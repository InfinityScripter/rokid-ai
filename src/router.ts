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
          location: z.string().optional().describe('место или адрес события, если названы'),
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
        query: z.string().describe('название продукта по-английски для поиска в базе'),
      }),
    ),
    skipped: z.array(z.string()).default([]),
  }),
  z.object({
    intent: z.literal('meeting_audio'),
    topic: z.string(),
  }),
  z.object({
    intent: z.literal('food_summary'),
  }),
  z.object({
    intent: z.literal('other'),
    text: z.string(),
    skipped: z.array(z.string()).default([]),
  }),
  z.object({
    intent: z.literal('cancel_last'),
  }),
  z.object({
    intent: z.literal('agenda'),
    from: z.string().describe('начало периода, ISO 8601 с таймзоной'),
    to: z.string().describe('конец периода, ISO 8601 с таймзоной'),
    period: z.string().describe('о каком периоде спрашивают: «сегодня», «завтра», «на этой неделе»'),
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
        intent: {
          type: 'string',
          enum: ['calendar_event', 'food_log', 'meeting_audio', 'food_summary', 'other', 'cancel_last', 'agenda'],
        },
        from: { type: 'string', description: 'ISO 8601 с таймзоной — начало периода для agenda' },
        to: { type: 'string', description: 'ISO 8601 с таймзоной — конец периода для agenda' },
        period: { type: 'string', description: 'период словами для agenda: «сегодня», «завтра»' },
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
              location: {
                type: 'string',
                description: 'место или адрес события целиком, как названо в заметке',
              },
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
            properties: {
              name: { type: 'string' },
              amount: { type: 'string' },
              query: { type: 'string', description: 'название продукта по-английски для поиска в базе' },
            },
            required: ['name', 'amount', 'query'],
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
    // temperature 0: одно и то же фото/фраза должны давать один и тот же
    // разбор — иначе два подряд снимка одной банки дают разные карточки.
    temperature: 0,
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
        'Заметка может прийти на английском: распознавание умных очков переводит русскую речь ' +
        'на английский. Все тексты, которые ты возвращаешь (title, uncertain, skipped, text), ' +
        'ВСЕГДА пиши по-русски — переводи, если исходная фраза на другом языке. ' +
        'Определи намерение. Если в заметке несколько встреч — верни ВСЕ в массиве events. ' +
        'Правила выбора календаря: рабочие маркеры (синк, ревью, 1:1, ' +
        'созвон с коллегами, «рабочий») → work; остальное → personal. ' +
        'Относительные даты («завтра», «в среду») переводи в ISO от текущего момента. ' +
        'Длительность не названа — ставь 60 минут, это НЕ повод для uncertain. ' +
        'Если названо место или адрес — верни его в location целиком, ничего не выкидывая ' +
        '(город, улица, дом, корпус, литера, кабинет). В title место не дублируй. ' +
        'Место не названо — location не заполняй, это НЕ повод для uncertain. ' +
        'В uncertain пиши только настоящие дыры: нет времени, названное время уже прошло ' +
        '(тогда спроси «время уже прошло — ты про завтра?»), непонятно какое событие. Не выдумывай. ' +
        'Повторяющиеся события («каждый вторник») НЕ поддерживаются: в events не включай, ' +
        'добавь в skipped с пометкой «серии не умею — создай руками»; разовые события из той же фразы обработай. ' +
        'Если в заметке несколько разных тем (встреча И еда) — обработай главную ' +
        '(календарь приоритетнее еды, еда приоритетнее прочего), остальные перечисли в skipped ' +
        'с просьбой прислать отдельным сообщением. ' +
        'Вопрос о планах — «что у меня сегодня», «какие встречи завтра», «что на этой неделе», ' +
        'what is on my calendar today → agenda: посчитай период from/to в ISO от текущего момента ' +
        '(сегодня = с начала до конца текущего дня по Москве) и в period напиши период словами: ' +
        '«сегодня», «завтра», «на этой неделе». ' +
        'Просьба отменить или убрать последнюю запись/встречу/событие ' +
        '(«отмени последнюю запись», «убери это из календаря», «не надо было записывать») → cancel_last. ' +
        'Еда («съел», «на обед было») → food_log. Для каждого продукта заполни query — короткое английское ' +
        'название для поиска в американской базе продуктов («борщ» → "borscht", «два тоста с сыром» → ' +
        '"toast with cheese"). Просьба сделать саммари разговора → meeting_audio. ' +
        'Вопрос про съеденное за сегодня — «сколько я сегодня съел», «что я ел», «сколько калорий набрал», ' +
        '«итоги дня по еде» → food_summary. ' +
        'Всё прочее (мысли, заметки, просьбы не по теме) → other с исходным текстом.',
    },
  ]);
}

export async function parseFoodPhoto(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png',
  caption?: string,
): Promise<Intent> {
  return callRouter([
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
    {
      type: 'text',
      text:
        'Это фото еды с умных очков. Определи блюда и порции (intent=food_log). ' +
        'Составную тарелку (гарнир + мясо + салат + соус) разбивай на ОТДЕЛЬНЫЕ items по частям — ' +
        'каждая часть станет отдельной записью в дневнике, и её можно будет править независимо. ' +
        'Блюдо с устоявшимся названием, которое в базе есть целиком (борщ, пицца маргарита, цезарь ' +
        'с курицей), оставляй одним item — не дроби до ингредиентов. ' +
        'Приём пищи выбери по текущему времени в Москве: 05–11 — breakfast, 11–16 — lunch, ' +
        '16–22 — dinner, ночь (22–05) — other. Порции оценивай консервативно, словами. ' +
        'Для каждого продукта заполни query — короткое английское название для поиска в американской базе ' +
        'продуктов («борщ» → "borscht", «два тоста с сыром» → "toast with cheese").' +
        (caption
          ? `\nПодпись к фото: «${caption}» — учитывай её при выборе блюд, порций и приёма пищи; ` +
            'подпись главнее твоей оценки по фото.'
          : ''),
    },
  ]);
}
