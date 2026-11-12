import { config } from './config.js';
import { fsCreateFoodEntry } from './fatsecret.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

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
  /** Метка одной подтверждённой карточки — по ней отмена находит свои записи. */
  batchId?: string;
};

type BufferFile = {
  entries: BufferedEntry[];
  /** Последняя ошибка отправки и когда — их показывает /status. */
  lastError?: string;
  lastErrorAt?: string;
  lastSuccessAt?: string;
};

function bufferPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.food-buffer.json');
}

function load(): BufferFile {
  const data = readJsonFile<BufferFile>(bufferPath(), { entries: [] }, 'food-buffer');
  return Array.isArray(data.entries) ? data : { entries: [] };
}

function save(data: BufferFile): void {
  writeJsonFile(bufferPath(), data);
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

// Шлёт буфер по порядку через send; при первой же ошибке останавливается и
// оставляет непровереннную запись и всё, что за ней, в файле — это и есть
// признак «Premier ещё не одобрен» (или другая ошибка FatSecret), на который
// смотрит вызывающий код (food-yes в bot.ts, периодический флаш в index.ts).
// Сохраняем файл после каждой успешной отправки, а не одним разом после
// цикла: если процесс упадёт посреди флаша, уже отправленные записи не
// улетят в FatSecret повторно при следующем запуске.
/** Что реально уехало в FatSecret: id записи и метка карточки, из которой она. */
export type FlushedEntry = { entryId: string; batchId?: string };

export type FlushResult = { sent: number; left: number; error?: unknown; flushed: FlushedEntry[] };

type Sender = (entry: BufferedEntry) => Promise<string>;

// Внутренняя часть флаша — без enqueue, чтобы её можно было вызвать из другой
// операции цепочки (иначе она ждала бы сама себя).
async function flushLoaded(send: Sender): Promise<FlushResult> {
  const data = load();
  // Идентификаторы созданных записей возвращаем наружу: без них кнопку
  // «↩️ Отменить» под сообщением нечем наполнить — удаление в FatSecret идёт
  // строго по food_entry_id.
  const flushed: FlushedEntry[] = [];
  let error: unknown;
  while (data.entries.length > 0) {
    const entry = data.entries[0];
    try {
      // Запись уже создана в FatSecret; убираем её из очереди и сохраняем файл
      // сразу, а не после всего цикла, чтобы падение процесса посреди флаша не
      // отправило её второй раз. Окно на одну запись всё же остаётся: между
      // ответом FatSecret и переименованием файла.
      flushed.push({ entryId: await send(entry), batchId: entry.batchId });
      data.entries.shift();
      data.lastSuccessAt = new Date().toISOString();
      data.lastError = undefined;
      data.lastErrorAt = undefined;
      save(data);
    } catch (e) {
      error = e;
      // Причину застревания храним в самом файле: иначе очередь, упёршаяся в
      // одну непроходящую запись, молчит месяцами, а /status показывает только
      // её размер.
      data.lastError = e instanceof Error ? e.message : String(e);
      data.lastErrorAt = new Date().toISOString();
      save(data);
      break;
    }
  }
  return { sent: flushed.length, left: data.entries.length, error, flushed };
}

export function bufferFlush(send: Sender): Promise<FlushResult> {
  return enqueue(() => flushLoaded(send));
}

// Положить партию и сразу же её отправить — одной операцией цепочки. Раздельные
// вызовы push и flush разделены точкой ожидания, и часовой флаш успевает
// вклиниться между ними: тогда записи уезжают, а вызывающий получает пустой
// список id и не может предложить отмену.
export function bufferPushAndFlush(entries: BufferedEntry[], send: Sender): Promise<FlushResult> {
  return enqueue(() => {
    const data = load();
    data.entries.push(...entries);
    save(data);
    return flushLoaded(send);
  });
}

// Убрать из буфера то, что ещё не уехало: отмена только что подтверждённой
// карточки должна отменять её целиком, а не половину.
export function bufferDrop(match: (entry: BufferedEntry) => boolean): Promise<number> {
  return enqueue(() => {
    const data = load();
    const kept = data.entries.filter((entry) => !match(entry));
    const dropped = data.entries.length - kept.length;
    if (dropped > 0) {
      data.entries = kept;
      if (kept.length === 0) {
        data.lastError = undefined;
        data.lastErrorAt = undefined;
      }
      save(data);
    }
    return dropped;
  });
}

export function bufferSize(): Promise<number> {
  return enqueue(() => load().entries.length);
}

export type BufferStatus = { size: number; lastError?: string; lastErrorAt?: string; lastSuccessAt?: string };

export function bufferStatus(): Promise<BufferStatus> {
  return enqueue(() => {
    const data = load();
    return { size: data.entries.length, lastError: data.lastError, lastErrorAt: data.lastErrorAt, lastSuccessAt: data.lastSuccessAt };
  });
}

// Готовый отправитель через fsCreateFoodEntry — потребителей несколько
// (подтверждение карточки в bot.ts и периодический флаш в index.ts).
const sendToFatSecret: Sender = (e) =>
  fsCreateFoodEntry({
    foodId: e.foodId,
    name: e.name,
    servingId: e.servingId,
    units: e.units,
    meal: e.meal,
    date: new Date(e.date),
  });

export function flushWithFatSecret(): Promise<FlushResult> {
  return bufferFlush(sendToFatSecret);
}

export function writeToFatSecret(entries: BufferedEntry[]): Promise<FlushResult> {
  return bufferPushAndFlush(entries, sendToFatSecret);
}
