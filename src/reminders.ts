import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { InlineKeyboard } from 'grammy';

import { config } from './config.js';
import {
  dayNumberFromDate,
  diaryDate,
  fsGetFoodEntries,
  fsGetMonthTotals,
  fsLinked,
  mskDate,
  shiftDate,
  type DayTotals,
  type DiaryMeal,
  type FoodEntry,
} from './fatsecret.js';
import { bufferSize } from './food-buffer.js';
import { goalLine, loadGoal, type Goal } from './goal.js';
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
const MEAL_WORD: Record<DiaryMeal, string> = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', other: 'перекус' };

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// «4 сентября» из YYYY-MM-DD — без Date и таймзон, чтобы не сдвинуть день.
export function ruDate(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS_GENITIVE[month - 1]}`;
}

export function ruDateShort(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

function weekday(date: string): string {
  return WEEKDAYS_SHORT[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

// «сегодня, 4 сентября» / «вчера, 3 сентября» / «2 сентября».
export function dayLabel(date: string, today: string): string {
  const diff = dayNumberFromDate(today) - dayNumberFromDate(date);
  const word = diff === 0 ? 'сегодня' : diff === 1 ? 'вчера' : diff === 2 ? 'позавчера' : null;
  return word ? `${word}, ${ruDate(date)}` : ruDate(date);
}

// Аргумент /summary: «вчера», «позавчера», «сегодня», «3 сентября», «3 сен»,
// 2026-09-03. День в будущем (сказали «30 декабря» в сентябре) — прошлый год.
export function parseDayArg(text: string, today: string): string | null {
  const arg = text.trim().toLowerCase();
  if (!arg || arg === 'сегодня') return today;
  if (arg === 'вчера') return shiftDate(today, -1);
  if (arg === 'позавчера') return shiftDate(today, -2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  const match = arg.match(/^(\d{1,2})\s+([а-яё]+)\.?$/u);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS_GENITIVE.findIndex((m) => m.startsWith(match[2].slice(0, 3)));
  if (month < 0 || day < 1 || day > 31) return null;
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return dayNumberFromDate(candidate) > dayNumberFromDate(today)
    ? `${year - 1}${candidate.slice(4)}`
    : candidate;
}

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
  if (!last || lastSent[last.kind] === dayNumberFromDate(mskDate(now))) return null;
  return last.kind;
}

const fmt = (n: number): string => String(Math.round(n));

function totalsOf(entries: { calories: number; protein: number; fat: number; carbs: number }[]): {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
} {
  return entries.reduce(
    (acc, e) => ({ calories: acc.calories + e.calories, protein: acc.protein + e.protein, fat: acc.fat + e.fat, carbs: acc.carbs + e.carbs }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

function totalsLine(t: { calories: number; protein: number; fat: number; carbs: number }): string {
  return `${fmt(t.calories)} ккал · Б ${fmt(t.protein)} г · Ж ${fmt(t.fat)} г · У ${fmt(t.carbs)} г`;
}

export type SummaryOptions = { kind: SummaryKind; buffered: number; date: string; today: string; goal?: Goal | null };

export function formatDaySummary(entries: FoodEntry[], opts: SummaryOptions): string {
  const label = dayLabel(opts.date, opts.today);
  const isToday = opts.date === opts.today;
  const title = opts.kind === 'midday' ? `☀️ Еда за ${label}, пока что:` : opts.kind === 'evening' ? `🌙 Итоги дня, ${label}:` : `📊 Итоги дня, ${label}:`;
  const bufferedLine =
    isToday && opts.buffered > 0 ? `📤 Ещё ${opts.buffered} поз. в буфере ждут одобрения Premier — в итог не вошли.` : null;

  if (entries.length === 0) {
    return [
      title,
      'В дневнике FatSecret пусто.',
      bufferedLine,
      isToday
        ? 'Ничего не ел или забыл записать? Надиктуй, напиши или пришли фото — добавлю.'
        : `Если что-то ел — скажи «${ruDate(opts.date)} на обед …», добавлю.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const totals = totalsOf(entries);
  const lines = [title, `Итого: ${totalsLine(totals)}`];
  if (opts.goal) lines.push(goalLine(opts.goal, totals));
  const missing: string[] = [];
  for (const meal of MEAL_ORDER) {
    const own = entries.filter((e) => e.meal === meal);
    if (own.length === 0) {
      if (meal !== 'other') missing.push(MEAL_WORD[meal]);
      continue;
    }
    const kcal = own.reduce((sum, e) => sum + e.calories, 0);
    lines.push(`${MEAL_LABEL[meal]} — ${fmt(kcal)} ккал: ${own.map((e) => `${e.name} ${fmt(e.calories)}`).join(', ')}`);
  }
  if (bufferedLine) lines.push(bufferedLine);
  lines.push('');
  if (missing.length === 0) {
    lines.push(isToday ? 'Ничего не забыл записать? Если что — надиктуй или пришли фото, добавлю.' : 'Все приёмы пищи на месте.');
  } else if (isToday) {
    lines.push(`Не вижу: ${missing.join(', ')}. Записать? Надиктуй, напиши или пришли фото.`);
  } else {
    const hint = opts.date === shiftDate(opts.today, -1) ? ` Если ел — скажи «вчера на ${missing[0]} …», добавлю.` : '';
    lines.push(`Не записано: ${missing.join(', ')}.${hint}`);
  }
  return lines.join('\n');
}

// Последние 7 дней по итогам месяца: дни без записей FatSecret не отдаёт —
// показываем их как «пусто», среднее считаем только по заполненным.
export function formatWeekSummary(days: DayTotals[], today: string, goal?: Goal | null): string {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const lines = [goal ? `📈 Последние 7 дней (норма ${goal.kcal} ккал):` : '📈 Последние 7 дней:'];
  const filled: DayTotals[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const date = shiftDate(today, -back);
    const totals = byDate.get(date);
    const name = `${weekday(date)} ${ruDateShort(date)}`;
    if (!totals || totals.calories === 0) {
      lines.push(`${name} — пусто`);
      continue;
    }
    filled.push(totals);
    const over = goal && totals.calories > goal.kcal ? ` ⚠️ +${fmt(totals.calories - goal.kcal)}` : '';
    lines.push(`${name} — ${totalsLine(totals)}${over}`);
  }
  if (filled.length === 0) {
    lines.push('', 'За неделю в дневнике ничего нет.');
  } else {
    const avg = totalsOf(filled);
    const n = filled.length;
    lines.push(
      '',
      `Среднее за ${n} дн. с записями: ${totalsLine({ calories: avg.calories / n, protein: avg.protein / n, fat: avg.fat / n, carbs: avg.carbs / n })}`,
    );
  }
  return lines.join('\n');
}

// Кнопки под итогами: соседние дни и неделя. Вперёд — только пока есть куда.
export function summaryKeyboard(date: string, today: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(`◀️ ${ruDateShort(shiftDate(date, -1))}`, `summary:${shiftDate(date, -1)}`);
  if (dayNumberFromDate(date) < dayNumberFromDate(today)) {
    keyboard.text(`${ruDateShort(shiftDate(date, 1))} ▶️`, `summary:${shiftDate(date, 1)}`);
  }
  return keyboard.row().text('📈 Неделя', 'summary-week').text('🎯 Норма', 'goal:show');
}

export function weekKeyboard(today: string): InlineKeyboard {
  return new InlineKeyboard().text(`📊 ${ruDateShort(today)}`, `summary:${today}`).text('🎯 Норма', 'goal:show');
}

function errorText(error: unknown): string {
  return `⚠️ Не смогла прочитать дневник FatSecret: ${error instanceof Error ? error.message : String(error)}`;
}

export async function foodDaySummary(date: string, kind: SummaryKind): Promise<string> {
  const today = diaryDate(new Date());
  try {
    const [entries, buffered] = await Promise.all([fsGetFoodEntries(date), bufferSize()]);
    return formatDaySummary(entries, { kind, buffered, date, today, goal: loadGoal() });
  } catch (error) {
    logError('food-summary', error);
    return errorText(error);
  }
}

export async function foodWeekSummary(): Promise<string> {
  const today = diaryDate(new Date());
  const weekStart = shiftDate(today, -6);
  try {
    const months = [today];
    if (weekStart.slice(0, 7) !== today.slice(0, 7)) months.push(weekStart);
    const totals = (await Promise.all(months.map((m) => fsGetMonthTotals(m)))).flat();
    return formatWeekSummary(totals, today, loadGoal());
  } catch (error) {
    logError('food-week', error);
    return errorText(error);
  }
}

// Строка «за сегодня теперь столько-то» после записи; null — не смогла
// прочитать (в лог), запись от этого не страдает.
export async function dayTotalsLine(date: string): Promise<string | null> {
  try {
    const entries = await fsGetFoodEntries(date);
    if (entries.length === 0) return null;
    const totals = totalsOf(entries);
    const goal = loadGoal();
    return [`За ${dayLabel(date, diaryDate(new Date()))} теперь: ${totalsLine(totals)}`, goal ? goalLine(goal, totals) : null]
      .filter(Boolean)
      .join('\n');
  } catch (error) {
    logError('food-totals', error);
    return null;
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
export function startFoodReminders(
  send: (text: string, keyboard: InlineKeyboard) => Promise<void>,
  intervalMs = 60_000,
): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    if (!fsLinked()) return;
    const now = new Date();
    const sent = loadSent();
    const kind = dueReminder(now, sent);
    if (!kind) return;
    const today = dayNumberFromDate(mskDate(now));
    for (const t of REMINDER_TIMES_MSK) {
      if (mskMinutes(now) >= t.hour * 60 + t.minute) sent[t.kind] = today;
    }
    saveSent(sent);
    log('reminder:', kind);
    const date = diaryDate(now);
    await send(await foodDaySummary(date, kind), summaryKeyboard(date, date));
  };
  return setInterval(() => {
    tick().catch((e) => logError('food-reminder', e));
  }, intervalMs);
}
