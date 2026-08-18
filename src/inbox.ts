import { createServer } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { applyIntent, bot } from './bot.js';
import { config } from './config.js';
import { formatEventLine } from './format.js';
import { handleGlassesChat } from './glasses.js';
import { log, logError } from './log.js';
import { completeJob, getJob, pendingJobs, type CreatePayload } from './queue.js';
import { parseFoodPhoto, routeText } from './router.js';
import { transcribe } from './stt.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

const requestTimestampsByIp = new Map<string, number[]>();

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

    if (req.headers.authorization !== `Bearer ${config.INBOX_TOKEN}`) {
      respond(401, { message: 'unauthorized' });
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
