import OpenAI from 'openai';
import { z } from 'zod';

import { config } from './config.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

export const intentSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('calendar_event'),
    events: z
      .array(
        z.object({
          title: z.string(),
          start: z.string().describe('ISO 8601 с таймзоной'),
          durationMinutes: z.number(),
          calendar: z.enum(['work', 'personal']),
        }),
      )
      .min(1),
    uncertain: z.array(z.string()).describe('что не удалось понять из фразы'),
    skipped: z.array(z.string()).default([]).describe('распознано, но не обработано'),
  }),
  z.object({
    intent: z.literal('food_log'),
    meal: z.enum(['breakfast', 'lunch', 'dinner', 'other']),
    items: z.array(
      z.object({
        name: z.string(),
        amount: z.string().describe('порция словами: «2 тоста», «тарелка»'),
      }),
    ),
    skipped: z.array(z.string()).default([]),
  }),
  z.object({
    intent: z.literal('meeting_audio'),
    topic: z.string(),
  }),
  z.object({
    intent: z.literal('note'),
    text: z.string(),
    skipped: z.array(z.string()).default([]),
  }),
]);

export type Intent = z.infer<typeof intentSchema>;

const routerTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'route_intent',
    description: 'Классифицировать заметку пользователя и извлечь поля',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['calendar_event', 'food_log', 'meeting_audio', 'note'] },
        events: {
          type: 'array',
          description: 'ВСЕ упомянутые события — их может быть несколько',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              start: { type: 'string', description: 'ISO 8601 с таймзоной Europe/Moscow' },
              durationMinutes: { type: 'number' },
              calendar: { type: 'string', enum: ['work', 'personal'] },
            },
            required: ['title', 'start', 'durationMinutes', 'calendar'],
          },
        },
        uncertain: { type: 'array', items: { type: 'string' } },
        skipped: {
          type: 'array',
          items: { type: 'string' },
          description: 'распознанные, но не обработанные части: повторяющиеся серии, побочные темы заметки',
        },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'other'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, amount: { type: 'string' } },
            required: ['name', 'amount'],
          },
        },
        topic: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['intent'],
    },
  },
};

async function callRouter(content: OpenAI.Chat.Completions.ChatCompletionContentPart[]): Promise<Intent> {
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 1024,
    tools: [routerTool],
    tool_choice: { type: 'function', function: { name: 'route_intent' } },
    messages: [{ role: 'user', content }],
  });

  const toolCall = response.choices[0]?.message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('Модель не вернула структурированный ответ роутера');
  }
  return intentSchema.parse(JSON.parse(toolCall.function.arguments));
}

export async function routeText(text: string, now: Date): Promise<Intent> {
  return callRouter([
    {
      type: 'text',
      text:
        `Сейчас ${now.toISOString()} (таймзона пользователя Europe/Moscow).\n` +
        'Расшифровка голосовой заметки с умных очков:\n' +
        `<заметка>${text}</заметка>\n\n` +
        'Определи намерение. Если в заметке несколько встреч — верни ВСЕ в массиве events. ' +
        'Правила выбора календаря: рабочие маркеры (синк, ревью, 1:1, ' +
        'созвон с коллегами, «рабочий») → work; остальное → personal. ' +
        'Относительные даты («завтра», «в среду») переводи в ISO от текущего момента. ' +
        'Длительность не названа — ставь 60 минут, это НЕ повод для uncertain. ' +
        'В uncertain пиши только настоящие дыры: нет времени, названное время уже прошло ' +
        '(тогда спроси «время уже прошло — ты про завтра?»), непонятно какое событие. Не выдумывай. ' +
        'Повторяющиеся события («каждый вторник») НЕ поддерживаются: в events не включай, ' +
        'добавь в skipped с пометкой «серии не умею — создай руками»; разовые события из той же фразы обработай. ' +
        'Если в заметке несколько разных тем (встреча И еда) — обработай главную ' +
        '(календарь приоритетнее еды, еда приоритетнее заметки), остальные перечисли в skipped ' +
        'с просьбой прислать отдельным сообщением. ' +
        'Еда («съел», «на обед было») → food_log. Просьба сделать саммари разговора → meeting_audio. ' +
        'Всё прочее → note с исходным текстом.',
    },
  ]);
}

export async function parseFoodPhoto(imageBase64: string, mediaType: 'image/jpeg' | 'image/png'): Promise<Intent> {
  return callRouter([
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
    {
      type: 'text',
      text:
        'Это фото еды с умных очков. Определи блюда и порции (intent=food_log). ' +
        'Приём пищи выбери по текущему времени в Москве: до 11 — breakfast, 11–16 — lunch, ' +
        '16–22 — dinner, иначе other. Порции оценивай консервативно, словами.',
    },
  ]);
}
