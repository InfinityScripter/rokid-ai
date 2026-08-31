import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { applyIntent, bot } from './bot.js';
import { config } from './config.js';
import { log, logError } from './log.js';
import { routeText } from './router.js';

// OpenAI-совместимая ручка для платформы Rokid: кастомному агенту там можно
// указать «свой LLM» (base URL + ключ), и он шлёт обычный chat/completions.
// Вместо прокси к модели текст идёт через наш конвейер (routeText →
// applyIntent), ответ — в формате OpenAI, потоково или нет, как попросил
// клиент. Модуль восстановлен по контракту использования (inbox.ts):
// оригинал не был закоммичен. Если рабочая копия на VDS отличается — её
// вариант главнее, закоммитить поверх этого.

type ChatMessage = { role?: string; content?: string | { type?: string; text?: string }[] };
type ChatRequest = { model?: string; stream?: boolean; messages?: ChatMessage[] };

function textOf(message: ChatMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text ?? '')
      .join(' ')
      .trim();
  }
  return '';
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    // Текстовый chat/completions в мегабайт не упирается; всё крупнее —
    // не наш клиент, обрываем до того, как соберём это в память.
    if (received > MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'body too large', type: 'invalid_request_error' } }));
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  log('openai-compat raw:', raw.slice(0, 500));
  const body = JSON.parse(raw) as ChatRequest;

  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  const text = textOf(lastUser);
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'пустой запрос: нет user-сообщения с текстом', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  const intent = await routeText(text, new Date());
  const reply = await applyIntent(intent);

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'rokid-ai';

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (payload: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }],
    });
    send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  }

  // Зеркало в Telegram — после ответа клиенту и только best-effort: у очков
  // таймаут хода, сбой Telegram не должен ронять голосовой ответ.
  try {
    await bot.api.sendMessage(config.OWNER_TELEGRAM_ID, `🕶 Через агента Rokid:\n«${text}»\n\n${reply.text}`, {
      reply_markup: reply.keyboard,
    });
  } catch (error) {
    logError('openai-compat-mirror', error);
  }
}
