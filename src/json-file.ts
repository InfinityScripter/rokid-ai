import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { logError } from './log.js';

// Общая работа с маленькими JSON-файлами состояния бота: очередь отправки,
// черновики карточек, настройки, токен привязки. Все четыре раньше писались
// обычным writeFileSync, и обрыв процесса посреди записи оставлял половину
// JSON — при следующем старте это выглядело как «файл пустой».

/**
 * Пишет во временный файл рядом и переименовывает. Переименование в пределах
 * одной файловой системы атомарно, поэтому на диске всегда лежит либо старая
 * версия целиком, либо новая целиком.
 */
export function writeJsonFile(filePath: string, data: unknown, mode = 0o644): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode });
  renameSync(temporary, filePath);
}

/**
 * Читает JSON. Отсутствие файла — обычное дело (первый запуск), а вот файл,
 * который есть и не разбирается, — это потеря данных: уносим его в сторону с
 * пометкой .corrupt и громко пишем в лог, чтобы следующая запись не затёрла
 * улику молча.
 */
export function readJsonFile<T>(filePath: string, fallback: T, scope: string): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(filePath, quarantine);
    } catch {
      // Не смогли даже отложить битый файл — дальше идём с пустым состоянием,
      // но в логе уже будет видно, что файл не читался.
    }
    logError(scope, new Error(`файл ${path.basename(filePath)} не разобрался (${String(error)}), отложила в ${path.basename(quarantine)}`));
    return fallback;
  }
}
