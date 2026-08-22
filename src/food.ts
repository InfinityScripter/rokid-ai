import OpenAI from 'openai';
import { z } from 'zod';

import { config } from './config.js';
import { fsGetServings, fsSearchFoods, type FsFood, type FsServing } from './fatsecret.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

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
        foodId: { type: 'string', description: 'food_id выбранного продукта из списка кандидатов' },
        servingId: { type: 'string', description: 'serving_id выбранной порции из списка сервингов' },
        units: { type: 'number', description: 'сколько таких порций съедено, например 2 для «2 тоста»' },
        grams: { type: 'number', nullable: true, description: 'итоговый вес в граммах, если известен' },
      },
      required: ['foodId', 'servingId', 'units', 'grams'],
    },
  },
};

async function chooseFoodAndServing(
  item: { name: string; amount: string; query: string },
  candidates: FsFood[],
  servings: FsServing[],
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
          `Кандидаты из базы FatSecret:\n${JSON.stringify(candidates, null, 2)}\n\n` +
          `Сервинги первого кандидата (${candidates[0].foodId}):\n${JSON.stringify(servings, null, 2)}\n\n` +
          'Выбери подходящий food_id (обычно первый кандидат, но смотри на name/brand/description — ' +
          'бери более точное совпадение, если оно есть) и serving_id. Переведи «amount» в число units ' +
          'этого сервинга: «тарелка» — оцени как 1-2 обычных сервинга, «2 тоста» — units=2, если сервинг ' +
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

export async function matchFoodItems(
  items: { name: string; amount: string; query: string }[],
): Promise<FoodMatch[]> {
  const results: FoodMatch[] = [];
  for (const item of items) {
    const candidates = await fsSearchFoods(item.query, 5);
    if (candidates.length === 0) {
      results.push({
        name: item.name,
        amount: item.amount,
        food: null,
        servingId: null,
        units: 0,
        grams: null,
        calories: null,
        note: 'не нашла в базе',
      });
      continue;
    }

    const servings = await fsGetServings(candidates[0].foodId);
    const choice = await chooseFoodAndServing(item, candidates, servings);
    const chosenFood = candidates.find((f) => f.foodId === choice.foodId) ?? candidates[0];
    const chosenServing = servings.find((s) => s.servingId === choice.servingId) ?? servings[0];

    results.push({
      name: item.name,
      amount: item.amount,
      food: { foodId: chosenFood.foodId, foodName: chosenFood.name },
      servingId: chosenServing.servingId,
      units: choice.units,
      grams: choice.grams,
      calories: chosenServing.calories * choice.units,
      note: null,
    });
  }
  return results;
}
