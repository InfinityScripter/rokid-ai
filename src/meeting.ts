import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import OpenAI from 'openai';

import { config } from './config.js';
import { log } from './log.js';
import { transcribe } from './stt.js';

const run = promisify(execFile);

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

const SEGMENT_SECONDS = 300;

// Длинную запись режем на куски по 5 минут и распознаём последовательно:
// у пути через OpenRouter выход ограничен 2048 токенами на вызов (stt.ts) —
// час записи целиком не помещается; параллелить нельзя — на VDS одно ядро
// и rate-limit Gemini.
export async function transcribeLong(audioPath: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokid-meeting-'));
  try {
    await run('ffmpeg', [
      '-y', '-i', audioPath,
      '-ac', '1', '-b:a', '48k',
      '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS),
      path.join(dir, 'part%03d.mp3'),
    ]);
    const parts = (await readdir(dir)).filter((f) => f.endsWith('.mp3')).sort();
    const texts: string[] = [];
    for (const [i, part] of parts.entries()) {
      log('meeting: расшифровка части', `${i + 1}/${parts.length}`);
      texts.push(await transcribe(path.join(dir, part)));
    }
    return texts.filter(Boolean).join('\n').trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Порог одного вызова саммари. Мера в символах, не в токенах — грубо, но
// для «поместится ли расшифровка в один вызов» достаточно.
const SUMMARY_CHUNK_CHARS = 24_000;

// Нарезка длинного текста по границам строк/предложений. Используется и для
// map-reduce саммари, и для отправки длинных ответов в Telegram (лимит 4096).
export function splitTranscript(text: string, maxChars = SUMMARY_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    // Ищем удобную границу; если её нет в правой половине окна — режем
    // жёстко, иначе куски выродятся в слишком мелкие.
    const cutCandidate = Math.max(rest.lastIndexOf('\n', maxChars), rest.lastIndexOf('. ', maxChars) + 1);
    const cut = cutCandidate > maxChars / 2 ? cutCandidate : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const SUMMARY_PROMPT =
  'Составь саммари встречи по расшифровке. Пиши по-русски, кратко и по делу, в таком формате:\n' +
  '🎙 Тема: одна строка\n' +
  'Главное:\n— пункт (3–7 штук)\n' +
  'Решения:\n— пункт (только если были)\n' +
  'Задачи:\n— кто: что (только если были)\n' +
  'Пустые разделы не выводи. Не выдумывай того, чего нет в расшифровке.';

async function summarizeOnce(text: string, instruction: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: `${instruction}\n\n<расшифровка>\n${text}\n</расшифровка>` }],
  });
  return (response.choices[0]?.message.content ?? '').trim();
}

export async function summarizeMeeting(transcript: string): Promise<string> {
  const chunks = splitTranscript(transcript);
  if (chunks.length === 1) {
    return summarizeOnce(chunks[0], SUMMARY_PROMPT);
  }
  const partial: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    log('meeting: саммари части', `${i + 1}/${chunks.length}`);
    partial.push(
      await summarizeOnce(
        chunk,
        `Это часть ${i + 1} из ${chunks.length} расшифровки одной длинной встречи. ` +
          'Выпиши тезисы, решения и задачи этой части списком, по-русски, без вступлений и выводов.',
      ),
    );
  }
  return summarizeOnce(partial.join('\n\n'), `Ниже — тезисы по частям одной встречи. ${SUMMARY_PROMPT}`);
}
