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

// bufferPush (синхронная запись) может попасть между итерациями bufferFlush
// (сеть внутри send даёт event loop переключиться) и затереть файл его
// устаревшим снимком данных — поэтому обе операции идут через одну цепочку
// промисов, а не пишут файл напрямую.
let chain: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => T | Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function bufferPush(entries: BufferedEntry[]): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  return enqueue(() => {
    const data = load();
    data.entries.push(...entries);
    save(data);
  });
}

// Сколько позиций ещё ждут отправки — для итогов дня (они в дневнике не
// видны, но владелец их уже «записал»).
export function bufferSize(): Promise<number> {
  return enqueue(() => load().entries.length);
}

// Шлёт буфер по порядку через send; при первой же ошибке останавливается и
// оставляет непровереннную запись и всё, что за ней, в файле — это и есть
// признак «Premier ещё не одобрен» (или другая ошибка FatSecret), на который
// смотрит вызывающий код (food-yes в bot.ts, периодический флаш в index.ts).
// Сохраняем файл после каждой успешной отправки, а не одним разом после
// цикла: если процесс упадёт посреди флаша, уже отправленные записи не
// улетят в FatSecret повторно при следующем запуске.
export function bufferFlush(
  send: (entry: BufferedEntry) => Promise<string>,
): Promise<{ sent: number; left: number; error?: unknown }> {
  return enqueue(async () => {
    const data = load();
    let sent = 0;
    let error: unknown;
    while (data.entries.length > 0) {
      try {
        await send(data.entries[0]);
        data.entries.shift();
        sent += 1;
        save(data);
      } catch (e) {
        error = e;
        break;
      }
    }
    return { sent, left: data.entries.length, error };
  });
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
