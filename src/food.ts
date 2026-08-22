import OpenAI from 'openai';
import { z } from 'zod';

import { config } from './config.js';
import { fsGetServings, fsSearchFoods, type FsFood, type FsServing } from './fatsecret.js';
import { logError } from './log.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

export type FoodItem = { name: string; amount: string; query: string };

export type FoodMatch = {
  name: string;
  amount: string;
  food: { foodId: string; foodName: string } | null;
  servingId: string | null;
  units: number;
  grams: number | null;
  calories: number | null;
  note: string | null;
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
    tools: [matchTool],
    tool_choice: { type: 'function', function: { name: 'match_food' } },
    messages: [
      {
        role: 'user',
        content:
          `Продукт из голосовой заметки: «${item.name}», порция словами: «${item.amount}» ` +
          `(поисковый запрос: "${item.query}").\n\n` +
          `Кандидаты из базы FatSecret вместе с их сервингами (порциями):\n` +
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
      const found = await searchFoods(item.query, 5);
      if (found.length === 0) {
        results.push(notFound(item, 'не нашла в базе'));
        continue;
      }

      // Топ-3, а не только первый кандидат: первый по релевантности поиска
      // не всегда правильный продукт (бренд, другой вид блюда) — модели
      // нужны сервинги нескольких кандидатов, чтобы реально выбирать, а не
      // просто утверждать первый вариант.
      const topCandidates = found.slice(0, 3);
      const servingsByCandidate = await Promise.all(topCandidates.map((food) => getServings(food.foodId)));
      const candidates: CandidateWithServings[] = topCandidates.map((food, i) => ({
        food,
        servings: servingsByCandidate[i],
      }));

      if (candidates.every((c) => c.servings.length === 0)) {
        results.push(notFound(item, 'не нашла порций в базе'));
        continue;
      }

      const choice = await chooseFood(item, candidates);
      const { food, serving } = pickValidPair(choice, candidates);
      const units = sanitizeUnits(choice.units);
      const grams = sanitizeGrams(choice.grams);

      results.push({
        name: item.name,
        amount: item.amount,
        food: { foodId: food.foodId, foodName: food.name },
        servingId: serving.servingId,
        units,
        grams,
        calories: serving.calories * units,
        note: null,
      });
    } catch (error) {
      logError('food-match', error);
      results.push(notFound(item, 'ошибка подбора — попробуй ещё раз'));
    }
  }
  return results;
}
