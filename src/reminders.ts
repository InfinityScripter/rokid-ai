import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { fsGetFoodEntries, fsLinked, mskDayNumber, type DiaryMeal, type FoodEntry } from './fatsecret.js';
import { bufferSize } from './food-buffer.js';
import { log, logError } from './log.js';

// Напоминания по еде: днём — «что уже записано, чего не хватает», вечером —
// итоги дня (ккал и БЖУ по приёмам пищи) с вопросом «ничего не забыл?».
// Данные — из дневника FatSecret (food_entries.get), а не из своих записей:
// то, что владелец записал руками в приложении, тоже учитывается.

export type ReminderKind = 'midday' | 'evening';
export type SummaryKind = ReminderKind | 'manual';

export const REMINDER_TIMES_MSK: { kind: ReminderKind; hour: number; minute: number }[] = [
  { kind: 'midday', hour: 14, minute: 30 },
  { kind: 'evening', hour: 21, minute: 30 },
];

const MEAL_ORDER: DiaryMeal[] = ['breakfast', 'lunch', 'dinner', 'other'];
const MEAL_LABEL: Record<DiaryMeal, string> = {
  breakfast: '🍳 Завтрак',
  lunch: '🍲 Обед',
  dinner: '🌙 Ужин',
  other: '🍎 Перекус',
};

function mskMinutes(now: Date): number {
  const [hour, minute] = now
    .toLocaleTimeString('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false })
    .split(':')
    .map(Number);
  return hour * 60 + minute;
}

// Какое напоминание пора слать. Из уже наступивших берём самое позднее:
// если бот лежал с обеда до вечера, шлём один вечерний итог, а не дневное
// напоминание в 22:00. Отметки «слал за такой-то день» — на диске: деплой
// в 21:31 не должен слать итог второй раз.
export function dueReminder(now: Date, lastSent: Partial<Record<ReminderKind, number>>): ReminderKind | null {
  const minutes = mskMinutes(now);
  const due = REMINDER_TIMES_MSK.filter((t) => minutes >= t.hour * 60 + t.minute);
  const last = due[due.length - 1];
  if (!last || lastSent[last.kind] === mskDayNumber(now)) return null;
  return last.kind;
}

const fmt = (n: number): string => String(Math.round(n));

export function formatDaySummary(entries: FoodEntry[], opts: { kind: SummaryKind; buffered: number; now: Date }): string {
  const day = opts.now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
  const title = opts.kind === 'midday' ? `☀️ Еда за ${day}, пока что:` : opts.kind === 'evening' ? `🌙 Итоги дня, ${day}:` : `📊 Итоги дня, ${day}:`;
  const bufferedLine =
    opts.buffered > 0 ? `📤 Ещё ${opts.buffered} поз. в буфере ждут одобрения Premier — в итог не вошли.` : null;

  if (entries.length === 0) {
    return [
      title,
      'В дневнике FatSecret пусто.',
      bufferedLine,
      'Ничего не ел или забыл записать? Надиктуй, напиши или пришли фото — добавлю.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const total = entries.reduce(
    (acc, e) => ({ calories: acc.calories + e.calories, protein: acc.protein + e.protein, fat: acc.fat + e.fat, carbs: acc.carbs + e.carbs }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
  const lines = [title, `Итого: ${fmt(total.calories)} ккал · Б ${fmt(total.protein)} г · Ж ${fmt(total.fat)} г · У ${fmt(total.carbs)} г`];
  const missing: string[] = [];
  for (const meal of MEAL_ORDER) {
    const own = entries.filter((e) => e.meal === meal);
    if (own.length === 0) {
      if (meal !== 'other') missing.push(MEAL_LABEL[meal].replace(/^\S+\s/, '').toLowerCase());
      continue;
    }
    const kcal = own.reduce((sum, e) => sum + e.calories, 0);
    lines.push(`${MEAL_LABEL[meal]} — ${fmt(kcal)} ккал: ${own.map((e) => e.name).join(', ')}`);
  }
  if (bufferedLine) lines.push(bufferedLine);
  lines.push('');
  if (missing.length > 0) {
    lines.push(`Не вижу: ${missing.join(', ')}. Записать? Надиктуй, напиши или пришли фото.`);
  } else {
    lines.push('Ничего не забыл записать? Если что — надиктуй или пришли фото, добавлю.');
  }
  return lines.join('\n');
}

export async function foodDaySummary(now: Date, kind: SummaryKind): Promise<string> {
  try {
    const [entries, buffered] = await Promise.all([fsGetFoodEntries(now), bufferSize()]);
    return formatDaySummary(entries, { kind, buffered, now });
  } catch (error) {
    logError('food-summary', error);
    return `⚠️ Не смогла прочитать дневник FatSecret: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type SentFile = Partial<Record<ReminderKind, number>>;

function sentPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.reminders.json');
}

function loadSent(): SentFile {
  try {
    return JSON.parse(readFileSync(sentPath(), 'utf8')) as SentFile;
  } catch {
    return {};
  }
}

function saveSent(data: SentFile): void {
  mkdirSync(path.dirname(sentPath()), { recursive: true });
  writeFileSync(sentPath(), JSON.stringify(data, null, 2));
}

// Раз в минуту смотрим на московские часы. Отметку ставим до отправки: если
// Telegram или FatSecret упадут, повторять каждую минуту не будем — лучше
// одно пропущенное напоминание, чем шестьдесят одинаковых.
export function startFoodReminders(send: (text: string) => Promise<void>, intervalMs = 60_000): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    if (!fsLinked()) return;
    const now = new Date();
    const sent = loadSent();
    const kind = dueReminder(now, sent);
    if (!kind) return;
    const today = mskDayNumber(now);
    for (const t of REMINDER_TIMES_MSK) {
      if (mskMinutes(now) >= t.hour * 60 + t.minute) sent[t.kind] = today;
    }
    saveSent(sent);
    log('reminder:', kind);
    await send(await foodDaySummary(now, kind));
  };
  return setInterval(() => {
    tick().catch((e) => logError('food-reminder', e));
  }, intervalMs);
}
