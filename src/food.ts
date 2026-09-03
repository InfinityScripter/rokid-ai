import OpenAI from 'openai';
import { z } from 'zod';

import { config } from './config.js';
import { lookupOpenFoodFacts, type OffProduct } from './barcode.js';
import { fsFindFoodIdForBarcode, fsGetFood, fsGetServings, fsSearchFoods, type FsFood, type FsServing } from './fatsecret.js';
import { logError } from './log.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

// labelHint — КБЖУ с этикетки (штрихкод → Open Food Facts): подбор аналога
// идёт по составу, а не по похожести названия — иначе «творожное зерно»
// превращалось в «2% Fat Milk».
export type FoodItem = { name: string; amount: string; query: string; labelHint?: string };

export type FoodMeal = 'breakfast' | 'lunch' | 'dinner' | 'other';

// Те же границы, что в промпте распознавания фото: 05–11 — завтрак, 11–16 —
// обед, 16–22 — ужин, ночь — перекус (00:30 — не «до 11», а ночной перекус).
// Нужна там, где модель приём пищи не выбирает (карточка по штрихкоду).
export function mealByMoscowTime(date: Date): FoodMeal {
  // hour12:false у некоторых ICU отдаёт «24» для полуночи — ветка ночи это
  // переживает (24 >= 22).
  const hour = Number(date.toLocaleString('en-US', { timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false }));
  if (hour >= 22 || hour < 5) return 'other';
  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  return 'dinner';
}

export type FoodMatch = {
  name: string;
  amount: string;
  food: { foodId: string; foodName: string } | null;
  servingId: string | null;
  units: number;
  grams: number | null;
  calories: number | null;
  note: string | null;
  // Калории на 100 г с этикетки (Open Food Facts) — для сверки с аналогом
  // из FatSecret; в дневник идёт аналог, этикетка только показывается.
  labelKcalPer100g?: number | null;
};

type CandidateWithServings = { food: FsFood; servings: FsServing[] };

const matchSchema = z.object({
  foodId: z.string(),
  servingId: z.string(),
  units: z.number(),
  grams: z.number().nullable(),
});

const matchTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'match_food',
    description: 'Выбрать продукт из кандидатов и порцию (сервинг) с числом единиц',
    parameters: {
      type: 'object',
      properties: {
        foodId: { type: 'string', description: 'food_id выбранного продукта — обязательно из списка кандидатов' },
        servingId: {
          type: 'string',
          description: 'serving_id порции — обязательно из сервингов ИМЕННО этого выбранного продукта',
        },
        units: { type: 'number', description: 'сколько таких порций съедено, например 2 для «2 тоста»' },
        grams: { type: 'number', nullable: true, description: 'итоговый вес в граммах, если известен' },
      },
      required: ['foodId', 'servingId', 'units', 'grams'],
    },
  },
};

async function chooseFoodAndServing(
  item: FoodItem,
  candidates: CandidateWithServings[],
): Promise<z.infer<typeof matchSchema>> {
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 512,
    temperature: 0,
    tools: [matchTool],
    tool_choice: { type: 'function', function: { name: 'match_food' } },
    messages: [
      {
        role: 'user',
        content:
          `Продукт из голосовой заметки: «${item.name}», порция словами: «${item.amount}» ` +
          `(поисковый запрос: "${item.query}").\n` +
          (item.labelHint
            ? `${item.labelHint}\nВыбирай кандидата, чьи калории и БЖУ на 100 г ближе всего к этикетке — ` +
              'состав важнее похожести названия.\n'
            : '') +
          `\nКандидаты из базы FatSecret вместе с их сервингами (порциями):\n` +
          `${JSON.stringify(candidates, null, 2)}\n\n` +
          'Выбери один food_id и один serving_id — servingId ОБЯЗАН принадлежать выбранному foodId ' +
          '(сравни по кандидату в списке, не смешивай сервинги разных продуктов). Смотри на name/brand/' +
          'description — бери более точное совпадение, не всегда первый кандидат. Переведи «amount» в число ' +
          'units этого сервинга: «тарелка» — оцени как 1-2 обычных сервинга, «2 тоста» — units=2, если сервинг ' +
          'на 1 тост. grams — итоговый вес порции в граммах (units × грамм сервинга), если у сервинга ' +
          'известны граммы, иначе null.',
      },
    ],
  });

  const toolCall = response.choices[0]?.message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('Модель не вернула структурированный ответ подбора продукта');
  }
  return matchSchema.parse(JSON.parse(toolCall.function.arguments));
}

function notFound(item: FoodItem, note: string): FoodMatch {
  return {
    name: item.name,
    amount: item.amount,
    food: null,
    servingId: null,
    units: 0,
    grams: null,
    calories: null,
    note,
  };
}

// Модель иногда называет foodId/servingId, которых нет в присланном списке
// (галлюцинация), или служит servingId от другого кандидата — валидируем
// пару и при промахе откатываемся на первого кандидата с непустыми
// сервингами (а не на candidates[0] в лоб — у него сервингов может не быть).
function pickValidPair(
  choice: z.infer<typeof matchSchema>,
  candidates: CandidateWithServings[],
): { food: FsFood; serving: FsServing } {
  const chosenEntry = candidates.find((c) => c.food.foodId === choice.foodId && c.servings.length > 0);
  if (chosenEntry) {
    const serving = chosenEntry.servings.find((s) => s.servingId === choice.servingId) ?? chosenEntry.servings[0];
    return { food: chosenEntry.food, serving };
  }
  const fallback = candidates.find((c) => c.servings.length > 0);
  if (!fallback) throw new Error('нет ни одного кандидата с сервингами — вызывающий код должен был это отсечь');
  return { food: fallback.food, serving: fallback.servings[0] };
}

// units/grams от модели — недоверенный ввод: помимо zod (тип number) нужна
// содержательная проверка диапазона, иначе «2 тарелки борща» на 9000 units
// разнесёт калории. При провале — консервативный дефолт, не отказ.
function sanitizeUnits(units: number): number {
  return Number.isFinite(units) && units > 0 && units <= 50 ? units : 1;
}

function sanitizeGrams(grams: number | null): number | null {
  return grams !== null && Number.isFinite(grams) && grams > 0 ? grams : null;
}

const reviseSchema = z.object({
  items: z.array(z.object({ name: z.string(), amount: z.string(), query: z.string() })),
});

const reviseTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'revise_food_items',
    description: 'Пересобрать список продуктов карточки еды по поправке пользователя',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'ПОЛНЫЙ новый список продуктов после поправки',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              amount: { type: 'string', description: 'порция словами: «400 г», «2 шт»' },
              query: { type: 'string', description: 'название продукта по-английски для поиска в базе' },
            },
            required: ['name', 'amount', 'query'],
          },
        },
      },
      required: ['items'],
    },
  },
};

// «✏️ Поправить»: пересборка списка по свободной фразе («борщ 400, тосты
// убери»). Модель возвращает ПОЛНЫЙ новый список — одна фраза может менять
// порции, убирать и добавлять позиции одновременно; пустой список = «убери
// всё», вызывающий код закрывает карточку.
export async function reviseFoodItems(current: FoodMatch[], correction: string): Promise<FoodItem[]> {
  const card = current.map((m) => ({
    name: m.name,
    amount: m.amount,
    matched: m.food?.foodName ?? null,
    grams: m.grams,
  }));
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 1024,
    temperature: 0,
    tools: [reviseTool],
    tool_choice: { type: 'function', function: { name: 'revise_food_items' } },
    messages: [
      {
        role: 'user',
        content:
          `Карточка еды сейчас:\n${JSON.stringify(card, null, 2)}\n\n` +
          `Поправка пользователя: «${correction}»\n\n` +
          'Верни ПОЛНЫЙ новый список items после поправки: позиции без изменений оставь как есть, ' +
          '«убери X» — исключи позицию, «X 400 грамм» — поменяй amount этой позиции, новые продукты ' +
          'добавь. Если поправка убирает всё — верни пустой список. Для каждого продукта заполни query — ' +
          'короткое английское название для поиска в американской базе («борщ» → "borscht").',
      },
    ],
  });
  const toolCall = response.choices[0]?.message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('Модель не вернула структурированный ответ пересборки карточки');
  }
  return reviseSchema.parse(JSON.parse(toolCall.function.arguments)).items;
}

export type MatchFoodDeps = {
  searchFoods?: (query: string, max?: number) => Promise<FsFood[]>;
  getServings?: (foodId: string) => Promise<FsServing[]>;
  chooseFood?: (item: FoodItem, candidates: CandidateWithServings[]) => Promise<z.infer<typeof matchSchema>>;
};

export async function matchFoodItems(items: FoodItem[], deps: MatchFoodDeps = {}): Promise<FoodMatch[]> {
  const searchFoods = deps.searchFoods ?? fsSearchFoods;
  const getServings = deps.getServings ?? fsGetServings;
  const chooseFood = deps.chooseFood ?? chooseFoodAndServing;

  const results: FoodMatch[] = [];
  for (const item of items) {
    try {
      const found = await searchFoods(item.query, item.labelHint ? 8 : 5);
      if (found.length === 0) {
        results.push(notFound(item, 'не нашла в базе'));
        continue;
      }

      // Топ-3, а не только первый кандидат: первый по релевантности поиска
      // не всегда правильный продукт (бренд, другой вид блюда) — модели
      // нужны сервинги нескольких кандидатов, чтобы реально выбирать, а не
      // просто утверждать первый вариант. С этикеткой — шире: подбор по
      // составу выигрывает от выбора.
      const topCandidates = found.slice(0, item.labelHint ? 5 : 3);
      const servingsByCandidate = await Promise.all(topCandidates.map((food) => getServings(food.foodId)));
      const candidates: CandidateWithServings[] = topCandidates.map((food, i) => ({
        food,
        servings: servingsByCandidate[i],
      }));

      if (candidates.every((c) => c.servings.length === 0)) {
        results.push(notFound(item, 'не нашла порций в базе'));
        continue;
      }

      results.push(await matchAmongCandidates(item, candidates, chooseFood));
    } catch (error) {
      logError('food-match', error);
      results.push(notFound(item, 'ошибка подбора — попробуй ещё раз'));
    }
  }
  return results;
}

async function matchAmongCandidates(
  item: FoodItem,
  candidates: CandidateWithServings[],
  chooseFood: NonNullable<MatchFoodDeps['chooseFood']>,
): Promise<FoodMatch> {
  const choice = await chooseFood(item, candidates);
  const { food, serving } = pickValidPair(choice, candidates);
  const units = sanitizeUnits(choice.units);
  const grams = sanitizeGrams(choice.grams);
  return {
    name: item.name,
    amount: item.amount,
    food: { foodId: food.foodId, foodName: food.name },
    servingId: serving.servingId,
    units,
    grams,
    calories: serving.calories * units,
    note: null,
  };
}

// У российских карточек Open Food Facts часто нет ни английского имени, ни
// английской категории — поиск в FatSecret с русским запросом пуст. Короткий
// перевод одним вызовом, без бренда («творожное зерно в сливках» → cottage
// cheese grains in cream).
async function translateToEnglishQuery(name: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 30,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content:
          `Название продукта с этикетки: «${name}». Дай короткий английский запрос для поиска ` +
          'в американской базе продуктов (1–3 слова, без бренда) — обычное американское название ' +
          'категории, не дословный перевод: «творожное зерно в сливках» → cottage cheese, «сметана» → ' +
          'sour cream, «творожный сыр» → cream cheese, «кефир» → kefir. Ответь только запросом.',
      },
    ],
  });
  const answer = (response.choices[0]?.message.content ?? '').trim().replace(/^["'«]+|["'».]+$/g, '');
  return answer || name;
}

const CYRILLIC = /[А-Яа-яЁё]/;

export type BarcodeDeps = {
  findFoodId?: (barcode: string) => Promise<string | null>;
  getFood?: (foodId: string) => Promise<{ food: FsFood; servings: FsServing[] }>;
  lookupOff?: (barcode: string) => Promise<OffProduct | null>;
  translate?: (name: string) => Promise<string>;
  searchFoods?: MatchFoodDeps['searchFoods'];
  getServings?: MatchFoodDeps['getServings'];
  chooseFood?: MatchFoodDeps['chooseFood'];
};

export type BarcodeOutcome =
  | { kind: 'fatsecret'; match: FoodMatch }
  | { kind: 'openfoodfacts'; match: FoodMatch; product: OffProduct }
  | { kind: 'not_found' };

// Продукт по штрихкоду. Сначала база FatSecret (точное попадание, метод
// Premier-exclusive), затем Open Food Facts: название с этикетки → поиск
// аналога в FatSecret по английскому имени. Порцию в обоих случаях выбирает
// модель из подписи («всю банку 320 г») или из веса упаковки. Сбои (нет в
// базах, нет прав Premier, сеть) — not_found: вызывающий код откатывается
// на распознавание по фото, ошибку пользователь не видит.
export async function matchFoodByBarcode(
  barcode: string,
  caption: string | undefined,
  deps: BarcodeDeps = {},
): Promise<BarcodeOutcome> {
  const findFoodId = deps.findFoodId ?? fsFindFoodIdForBarcode;
  const getFood = deps.getFood ?? fsGetFood;
  const lookupOff = deps.lookupOff ?? lookupOpenFoodFacts;
  const translate = deps.translate ?? translateToEnglishQuery;
  const chooseFood = deps.chooseFood ?? chooseFoodAndServing;

  try {
    const foodId = await findFoodId(barcode);
    if (foodId) {
      const candidate = await getFood(foodId);
      if (candidate.servings.length > 0) {
        const item: FoodItem = {
          name: candidate.food.brand ? `${candidate.food.brand} ${candidate.food.name}` : candidate.food.name,
          amount: caption?.trim() || '1 порция',
          query: candidate.food.name,
        };
        return { kind: 'fatsecret', match: await matchAmongCandidates(item, [candidate], chooseFood) };
      }
    }
  } catch (error) {
    logError('food-barcode', error);
  }

  try {
    const product = await lookupOff(barcode);
    if (!product) return { kind: 'not_found' };
    const label = [
      product.kcalPer100g !== null ? `${product.kcalPer100g} ккал` : null,
      product.proteinPer100g !== null ? `белки ${product.proteinPer100g} г` : null,
      product.fatPer100g !== null ? `жиры ${product.fatPer100g} г` : null,
      product.carbsPer100g !== null ? `углеводы ${product.carbsPer100g} г` : null,
    ].filter(Boolean);
    const item: FoodItem = {
      name: product.brand ? `${product.brand} ${product.name}` : product.name,
      amount: caption?.trim() || (product.quantityGrams ? `упаковка ${product.quantityGrams} г` : '1 упаковка'),
      query: CYRILLIC.test(product.queryEn) ? await translate(product.queryEn) : product.queryEn,
      labelHint: label.length > 0 ? `Этикетка (на 100 г): ${label.join(', ')}.` : undefined,
    };
    const [match] = await matchFoodItems([item], {
      searchFoods: deps.searchFoods,
      getServings: deps.getServings,
      chooseFood: deps.chooseFood,
    });
    return { kind: 'openfoodfacts', match: { ...match, labelKcalPer100g: product.kcalPer100g }, product };
  } catch (error) {
    logError('food-barcode-off', error);
    return { kind: 'not_found' };
  }
}
