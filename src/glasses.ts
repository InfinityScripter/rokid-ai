import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import Busboy from 'busboy';

import { applyIntent, bot, foodFromPhoto } from './bot.js';
import { config } from './config.js';
import { log, logError } from './log.js';
import { routeText } from './router.js';
import { transcribe } from './stt.js';

// Ручка для приложения на очках, протокол в стиле rode (docs/glasses-protocol.md):
// POST /glasses/chat, multipart (audio = WAV, опц. image = JPEG для фото еды,
// опц. recordingId для идемпотентности),
// ответ — SSE-поток: user → status → answer → done; ошибки — событием error.

const TURN_TIMEOUT_MS = 40_000;

// Идемпотентность досылки: очередь на очках ретраит до подтверждения,
// повторный recordingId не должен создать второе событие в календаре.
const processedIdsPath = () => path.join(path.dirname(config.SQLITE_PATH), 'processed-recordings.json');

function loadProcessedIds(): string[] {
  try {
    return JSON.parse(readFileSync(processedIdsPath(), 'utf8')) as string[];
  } catch {
    return [];
  }
}

function markProcessed(id: string): void {
  const ids = loadProcessedIds();
  ids.push(id);
  mkdirSync(path.dirname(processedIdsPath()), { recursive: true });
  writeFileSync(processedIdsPath(), JSON.stringify(ids.slice(-500)));
}

type GlassesUpload = { audio: Buffer | null; image: Buffer | null; recordingId: string | null };

function parseMultipart(req: IncomingMessage): Promise<GlassesUpload> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 2 } });
    const result: GlassesUpload = { audio: null, image: null, recordingId: null };
    busboy.on('file', (name, stream) => {
      if (name !== 'audio' && name !== 'image') {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('close', () => {
        result[name] = Buffer.concat(chunks);
      });
    });
    busboy.on('field', (name, value) => {
      if (name === 'recordingId') result.recordingId = value;
    });
    busboy.on('close', () => resolve(result));
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

export async function handleGlassesChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const upload = await parseMultipart(req);
  if (!upload.audio || upload.audio.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'поле audio обязательно' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const finish = () => {
    send({ type: 'done' });
    if (!res.writableEnded) res.end();
  };

  if (upload.recordingId && loadProcessedIds().includes(upload.recordingId)) {
    log('glasses: duplicate recording', upload.recordingId);
    send({ type: 'answer', text: 'Эта запись уже обработана.' });
    finish();
    return;
  }

  // Очки ждут ход не дольше 45 с — закрываем сами раньше их таймера.
  const timeout = setTimeout(() => {
    logError('glasses', new Error('таймаут хода'));
    send({ type: 'error', text: 'Не успела обработать — попробуй ещё раз.' });
    finish();
  }, TURN_TIMEOUT_MS);

  const audioPath = path.join('/tmp', `rokid-glasses-${randomUUID()}.wav`);
  try {
    await writeFile(audioPath, upload.audio);
    send({ type: 'status', text: 'Распознаю…' });
    const text = await transcribe(audioPath);
    // С фото пустая расшифровка не беда: снимок сам по себе полноценная
    // заметка о еде, голос — лишь необязательная подпись к нему.
    if (!text && !upload.image) {
      send({ type: 'error', text: 'Не разобрала речь — запись пустая или шумная.' });
      return;
    }
    if (text) send({ type: 'user', text });
    send({ type: 'status', text: upload.image ? 'Смотрю на фото…' : 'Думаю…' });
    let reply;
    if (upload.image) {
      reply = await foodFromPhoto(upload.image.toString('base64'), text || undefined);
    } else {
      const intent = await routeText(text, new Date());
      log('glasses intent:', JSON.stringify(intent));
      reply = await applyIntent(intent);
    }
    send({ type: 'answer', text: reply.text });
    if (upload.recordingId) markProcessed(upload.recordingId);
    const transcriptLine = text ? `Расшифровка: «${text}»\n\n` : '';
    await bot.api.sendMessage(config.OWNER_TELEGRAM_ID, `📥 С очков:\n${transcriptLine}${reply.text}`, {
      reply_markup: reply.keyboard,
    });
  } catch (error) {
    logError('glasses', error);
    send({ type: 'error', text: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timeout);
    finish();
    await rm(audioPath, { force: true });
  }
}
