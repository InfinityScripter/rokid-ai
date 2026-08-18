import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.join(os.homedir(), '.config', 'rokid-ai', '.env') });

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OWNER_TELEGRAM_ID: z.coerce.number(),
  WHISPER_MODEL_PATH: z.string().default(path.join(os.homedir(), '.cache', 'whisper', 'ggml-small.bin')),
  ROUTER_MODEL: z.string().default('openai/gpt-5.6-luna'),
  INBOX_PORT: z.coerce.number().default(3060),
  INBOX_TOKEN: z.string().default(''),
  APPLE_CALENDAR_WORK: z.string().default('Рабочий'),
  APPLE_CALENDAR_PERSONAL: z.string().default('Домашний'),
  // mac: всё через Calendar.app (osascript). vds: личное — iCloud CalDAV,
  // рабочее — очередь, которую разбирает мостик на Маке.
  ROKID_MODE: z.enum(['mac', 'vds']).default('mac'),
  STT_PROVIDER: z.enum(['whisper-cpp', 'openrouter']).default('whisper-cpp'),
  STT_MODEL: z.string().default('google/gemini-2.5-flash-lite'),
  APPLE_ID_EMAIL: z.string().default(''),
  APPLE_APP_PASSWORD: z.string().default(''),
  SQLITE_PATH: z.string().default('data/rokid-ai.sqlite'),
  // Для мостика на Маке: адрес VDS-инстанса
  BRIDGE_BASE_URL: z.string().default(''),
});

// Пустая строка в .env (`KEY=`) — то же самое, что незаданная переменная:
// иначе пустое значение перебивает default из схемы.
const definedEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));

const parsed = envSchema.safeParse(definedEnv);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  console.error(
    `Не хватает настроек в ~/.config/rokid-ai/.env: ${missing}\n` +
      'Открой файл и заполни пустые значения (подсказки — в комментариях внутри файла).',
  );
  process.exit(1);
}

export const config = parsed.data;
