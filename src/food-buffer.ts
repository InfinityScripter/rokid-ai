import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { fsCreateFoodEntry } from './fatsecret.js';

// Буфер записей дневника на время, пока заявка на FatSecret Premier Free ещё
// не одобрена: food_entry.create падает, пока write-доступ не открыт — копим
// тут и дольём после одобрения (флаш при старте бота + раз в час, src/index.ts).
// Формат файла и load/save — по образцу очереди рабочих событий, src/queue.ts:28-39.

export type BufferedEntry = {
  foodId: string;
  name: string;
  servingId: string;
  units: number;
  meal: string;
  date: string; // ISO-строка: Date не переживает JSON.stringify/parse как Date
};

type BufferFile = { entries: BufferedEntry[] };

function bufferPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.food-buffer.json');
}

function load(): BufferFile {
  try {
    return JSON.parse(readFileSync(bufferPath(), 'utf8')) as BufferFile;
  } catch {
    return { entries: [] };
  }
}

function save(data: BufferFile): void {
  mkdirSync(path.dirname(bufferPath()), { recursive: true });
  writeFileSync(bufferPath(), JSON.stringify(data, null, 2));
}

export function bufferPush(entries: BufferedEntry[]): void {
  if (entries.length === 0) return;
  const data = load();
  data.entries.push(...entries);
  save(data);
}

// Шлёт буфер по порядку через send; при первой же ошибке останавливается и
// оставляет непровереннную запись и всё, что за ней, в файле — это и есть
// признак «Premier ещё не одобрен» (или другая ошибка FatSecret), на который
// смотрит вызывающий код (food-yes в bot.ts, периодический флаш в index.ts).
export async function bufferFlush(
  send: (entry: BufferedEntry) => Promise<string>,
): Promise<{ sent: number; left: number; error?: unknown }> {
  const data = load();
  let sent = 0;
  let error: unknown;
  while (data.entries.length > 0) {
    try {
      await send(data.entries[0]);
      data.entries.shift();
      sent += 1;
    } catch (e) {
      error = e;
      break;
    }
  }
  save(data);
  return { sent, left: data.entries.length, error };
}

// Готовый отправитель через fsCreateFoodEntry — второй реальный потребитель
// (food-yes в bot.ts и периодический флаш в index.ts), поэтому вынесен сюда.
export function flushWithFatSecret(): Promise<{ sent: number; left: number; error?: unknown }> {
  return bufferFlush((e) =>
    fsCreateFoodEntry({
      foodId: e.foodId,
      name: e.name,
      servingId: e.servingId,
      units: e.units,
      meal: e.meal,
      date: new Date(e.date),
    }),
  );
}
