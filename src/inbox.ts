import { createServer } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { applyIntent, bot } from './bot.js';
import { caldavListEvents } from './caldav.js';
import { config } from './config.js';
import { formatEventLine } from './format.js';
import { handleGlassesChat } from './glasses.js';
import { handleChatCompletions } from './openai-compat.js';
import { log, logError } from './log.js';
import { completeJob, getJob, pendingJobs, type CreatePayload } from './queue.js';
import { parseFoodPhoto, routeText } from './router.js';
import { transcribe } from './stt.js';
import { analyzeVision, loadProfile, saveProfile, ZONES } from './vision.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

const requestTimestampsByIp = new Map<string, number[]>();

const visionReportSchema = z.object({
  answers: z
    .array(
      z.object({
        size: z.number().positive(),
        bold: z.boolean(),
        zone: z.enum(ZONES),
        read: z.boolean(),
      }),
    )
    .min(1),
});

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (requestTimestampsByIp.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestTimestampsByIp.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

// HTTP-инбокс: POST /inbox/audio | /inbox/photo — заметки от companion-приложения;
// GET /bridge/jobs | POST /bridge/complete — обмен с мостиком на Маке (режим vds).
// Авторизация всюду: Authorization: Bearer <INBOX_TOKEN>.
export function startInboxServer(): void {
  if (!config.INBOX_TOKEN) {
    log('INBOX_TOKEN не задан — HTTP-инбокс выключен (для работы только через Telegram это нормально).');
    return;
  }

  const server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const route = req.url?.split('?')[0];

    // Пинг связи для очков: без токена, только факт «сервер жив».
    if (req.method === 'GET' && route === '/') {
      respond(200, { message: 'rokid-ai' });
      return;
    }

    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown');
    if (rateLimited(ip)) {
      respond(429, { message: 'too many requests' });
      return;
    }

    // Платформа Rokid (AIUI-агент) шлёт ключ либо Bearer'ом, либо в X-Auth-AK.
    const authorized =
      req.headers.authorization === `Bearer ${config.INBOX_TOKEN}` ||
      req.headers['x-auth-ak'] === config.INBOX_TOKEN;
    if (!authorized) {
      respond(401, { message: 'unauthorized' });
      return;
    }

    // Нативный AIUI-агент Rokid (Customizable Agent): платформа шлёт УЖЕ
    // распознанный ей текст; ответ — SSE-события message/error + done.
    // Контракт снят с github.com/Hylouis233/rokid-hermes-connector.
    if (req.method === 'POST' && route === '/sse') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const sse = (event: string, payload: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      try {
        const raw = Buffer.concat(chunks).toString();
        log('aiui-agent raw:', raw.slice(0, 500));
        const body = JSON.parse(raw) as Record<string, unknown>;
        const text = String(body.text ?? body.content ?? body.query ?? body.input ?? '').trim();
        if (!text) {
          sse('error', { error: 'пустой запрос' });
          return;
        }
        const intent = await routeText(text, new Date());
        log('aiui-agent intent:', JSON.stringify(intent));
        const reply = await applyIntent(intent);
        sse('message', { content: reply.text });
        await bot.api.sendMessage(config.OWNER_TELEGRAM_ID, `🕶 Через агента Rokid:\n«${text}»\n\n${reply.text}`, {
          reply_markup: reply.keyboard,
        });
      } catch (error) {
        logError('aiui-agent', error);
        sse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        sse('done', { ok: true });
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // Расписание на сегодня для экрана очков: без модели и без зеркала в
    // Telegram — это просто показ, а не заметка.
    if (req.method === 'GET' && route?.startsWith('/agenda')) {
      try {
        // Период — сегментом пути (/agenda/tomorrow), а не параметром: прокси
        // на Vercel передаёт только путь, «хвост» запроса до нас не доезжает.
        const range = route.split('/').filter(Boolean)[1] ?? 'today';
        const now = new Date();
        const from = new Date(now);
        from.setHours(0, 0, 0, 0);
        const to = new Date(now);
        to.setHours(23, 59, 59, 999);
        if (range === 'tomorrow') {
          from.setDate(from.getDate() + 1);
          to.setDate(to.getDate() + 1);
        }
        if (range === 'week') {
          to.setDate(to.getDate() + 7);
        }
        const events = await caldavListEvents(from, to);
        const lines = events.map((event) => {
          const when = event.start.toLocaleString('ru-RU', {
            timeZone: 'Europe/Moscow',
            hour: '2-digit',
            minute: '2-digit',
            ...(range === 'today' ? {} : { day: 'numeric', month: 'short' }),
          });
          return `${when} ${event.title}`;
        });
        const titles = { today: 'СЕГОДНЯ', tomorrow: 'ЗАВТРА', week: 'НЕДЕЛЯ' };
        respond(200, {
          title: titles[range as keyof typeof titles] ?? 'СЕГОДНЯ',
          text: lines.length > 0 ? lines.join('\n') : 'Встреч нет',
        });
      } catch (error) {
        logError('agenda', error);
        respond(500, { message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // Профиль отображения, подобранный «Пробой зрения»: его читают и
    // приложение на очках, и агент-табло, чтобы рисовать читаемым размером.
    if (req.method === 'GET' && route?.startsWith('/vision/profile')) {
      respond(200, loadProfile() ?? { size: 0, bold: false, zone: 'center', updatedAt: '' });
      return;
    }

    if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/chat/completions')) {
      try {
        await handleChatCompletions(req, res);
      } catch (error) {
        logError('openai-compat', error);
        respond(500, { message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'POST' && route === '/glasses/chat') {
      try {
        await handleGlassesChat(req, res);
      } catch (error) {
        logError('glasses-chat', error);
        respond(400, { message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'GET' && route === '/bridge/jobs') {
      respond(200, { jobs: pendingJobs() });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      received += (chunk as Buffer).length;
      if (received > MAX_BODY_BYTES) {
        respond(413, { message: 'body too large' });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    if (req.method === 'POST' && route === '/bridge/complete') {
      try {
        const { id, status, result } = JSON.parse(body.toString()) as {
          id: number;
          status: 'done' | 'skipped';
          result: string;
        };
        const job = getJob(id);
        completeJob(id, status, result);
        if (job?.action === 'create') {
          const payload = JSON.parse(job.payload) as CreatePayload;
          const line = formatEventLine({ ...payload, calendar: 'work' });
          const text =
            status === 'done' ? `🌉 Мостик: записала рабочее — ${line}` : `🌉 Мостик: ${line} — ${result}`;
          await bot.api.sendMessage(config.OWNER_TELEGRAM_ID, text);
        }
        respond(200, { message: 'ok' });
      } catch (error) {
        logError('bridge-complete', error);
        respond(400, { message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'POST' && route === '/vision/report') {
      try {
        const parsed = visionReportSchema.parse(JSON.parse(body.toString()));
        const { profile, report, screen } = analyzeVision(parsed.answers);
        saveProfile(profile);
        await bot.api.sendMessage(config.OWNER_TELEGRAM_ID, report);
        respond(200, screen);
      } catch (error) {
        logError('vision-report', error);
        respond(400, { message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method !== 'POST' || (route !== '/inbox/audio' && route !== '/inbox/photo')) {
      respond(404, { message: 'not found' });
      return;
    }
    if (body.length === 0) {
      respond(400, { message: 'empty body' });
      return;
    }

    try {
      let reply: string;
      let keyboard;
      if (route === '/inbox/audio') {
        const audioPath = path.join('/tmp', `rokid-inbox-${Date.now()}.bin`);
        await writeFile(audioPath, body);
        try {
          const text = await transcribe(audioPath);
          const intent = await routeText(text, new Date());
          const r = await applyIntent(intent);
          reply = `Расшифровка: «${text}»\n\n${r.text}`;
          keyboard = r.keyboard;
        } finally {
          await rm(audioPath, { force: true });
        }
      } else {
        const intent = await parseFoodPhoto(body.toString('base64'), 'image/jpeg');
        const r = await applyIntent(intent);
        reply = r.text;
        keyboard = r.keyboard;
      }
      await bot.api.sendMessage(config.OWNER_TELEGRAM_ID, `📥 С очков:\n${reply}`, { reply_markup: keyboard });
      respond(200, { message: 'ok' });
    } catch (error) {
      logError('inbox', error);
      respond(500, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  // Только localhost: мостик ходит через ssh-туннель, companion-приложение
  // на этапе 2 подключим через nginx с TLS на этой же машине.
  server.listen(config.INBOX_PORT, '127.0.0.1', () => {
    log(`HTTP-инбокс слушает 127.0.0.1:${config.INBOX_PORT}`);
  });
}
