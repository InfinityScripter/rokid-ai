import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { config } from './config.js';

const run = promisify(execFile);

// Пишем через Calendar.app на Маке: события уходят на iPhone через iCloud,
// рабочий календарь Яндекса синхронизируется своим CalDAV-аккаунтом в Calendar.app.

export type CalendarKind = 'work' | 'personal';

export type CreatedEvent = { calendarName: string; uid: string };

function calendarNameOf(kind: CalendarKind): string {
  return kind === 'work' ? config.APPLE_CALENDAR_WORK : config.APPLE_CALENDAR_PERSONAL;
}

function escapeAs(text: string): string {
  return text.replace(/(["\\])/g, '\\$1');
}

function dateSetupLines(varName: string, d: Date): string[] {
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to 0`,
  ];
}

// Долгие операции Calendar.app (холодный старт, большие календари) не должны
// упираться в дефолтный AppleScript-таймаут в 2 минуты.
function withTimeout(lines: string[]): string {
  return ['with timeout of 300 seconds', ...lines.map((l) => `	${l}`), 'end timeout'].join('\n');
}

// Прогрев: первое обращение к Calendar.app после запуска заметно медленнее,
// будим его заранее, чтобы первый настоящий запрос не ловил таймаут.
export async function warmUpCalendar(): Promise<void> {
  await run('osascript', ['-e', withTimeout(['tell application "Calendar" to get name of first calendar'])]);
}

export async function createCalendarEvent(params: {
  title: string;
  start: Date;
  durationMinutes: number;
  calendar: CalendarKind;
  location?: string;
}): Promise<CreatedEvent> {
  const calendarName = calendarNameOf(params.calendar);
  const locationProp = params.location ? `, location:"${escapeAs(params.location)}"` : '';
  const script = withTimeout([
    ...dateSetupLines('startDate', params.start),
    `set endDate to startDate + ${params.durationMinutes} * minutes`,
    'tell application "Calendar"',
    `	tell calendar "${escapeAs(calendarName)}"`,
    `		set newEvent to make new event with properties {summary:"${escapeAs(params.title)}", start date:startDate, end date:endDate${locationProp}}`,
    '		return uid of newEvent',
    '	end tell',
    'end tell',
  ]);

  const { stdout } = await run('osascript', ['-e', script]);
  return { calendarName, uid: stdout.trim() };
}

// Дубль: похожее название + старт в пределах ±30 минут в том же календаре.
// Возвращает название существующего события или null.
export async function findDuplicateEvent(calendar: CalendarKind, title: string, start: Date): Promise<string | null> {
  const windowStart = new Date(start.getTime() - 30 * 60 * 1000);
  const windowEnd = new Date(start.getTime() + 30 * 60 * 1000);
  const script = withTimeout([
    ...dateSetupLines('lowDate', windowStart),
    ...dateSetupLines('highDate', windowEnd),
    'tell application "Calendar"',
    `	tell calendar "${escapeAs(calendarNameOf(calendar))}"`,
    '		set matches to summary of (every event whose start date ≥ lowDate and start date ≤ highDate)',
    '	end tell',
    'end tell',
    'set AppleScript\'s text item delimiters to linefeed',
    'return matches as text',
  ]);

  const { stdout } = await run('osascript', ['-e', script]);
  const wanted = title.trim().toLowerCase();
  for (const line of stdout.split('\n')) {
    const existing = line.trim().toLowerCase();
    if (!existing) continue;
    if (existing === wanted || existing.includes(wanted) || wanted.includes(existing)) {
      return line.trim();
    }
  }
  return null;
}

export async function deleteEventByUid(created: CreatedEvent): Promise<void> {
  const script = withTimeout([
    'tell application "Calendar"',
    `	tell calendar "${escapeAs(created.calendarName)}"`,
    `		delete (every event whose uid is "${escapeAs(created.uid)}")`,
    '	end tell',
    'end tell',
  ]);
  await run('osascript', ['-e', script]);
}
