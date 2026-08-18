import { randomUUID } from 'node:crypto';

import { createDAVClient } from 'tsdav';

import { config } from './config.js';
import { log } from './log.js';

// Личный календарь iCloud напрямую по CalDAV — работает с любой машины,
// нужен пароль приложения Apple ID (appleid.apple.com → App-Specific Passwords).

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;
type DavCalendar = Awaited<ReturnType<DavClient['fetchCalendars']>>[number];

let cached: { client: DavClient; calendar: DavCalendar } | null = null;

async function getPersonalCalendar(): Promise<{ client: DavClient; calendar: DavCalendar }> {
  if (cached) return cached;
  const client = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: config.APPLE_ID_EMAIL, password: config.APPLE_APP_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  const calendars = await client.fetchCalendars();
  const wanted = config.APPLE_CALENDAR_PERSONAL;
  const calendar = calendars.find((c) => String(c.displayName ?? '') === wanted);
  if (!calendar) {
    const names = calendars.map((c) => c.displayName).join(', ');
    throw new Error(`Календарь «${wanted}» не найден в iCloud. Доступны: ${names}`);
  }
  cached = { client, calendar };
  return cached;
}

function toIcsDate(d: Date): string {
  // UTC-формат: не зависит от таймзоны сервера
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export type CaldavCreated = { url: string; etag?: string };

export async function caldavCreateEvent(params: {
  title: string;
  start: Date;
  durationMinutes: number;
}): Promise<CaldavCreated> {
  const { client, calendar } = await getPersonalCalendar();
  const uid = `${randomUUID()}@rokid-ai`;
  const end = new Date(params.start.getTime() + params.durationMinutes * 60 * 1000);
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//rokid-ai//RU',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(params.start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${params.title.replace(/([,;\\])/g, '\\$1')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const url = `${calendar.url}${uid}.ics`;
  const response = await client.createCalendarObject({
    calendar,
    filename: `${uid}.ics`,
    iCalString: ics,
  });
  if (!response.ok) {
    throw new Error(`iCloud отказал в создании события: HTTP ${response.status}`);
  }
  log('caldav: created', params.title, '→', String(calendar.displayName));
  return { url };
}

export async function caldavFindDuplicate(title: string, start: Date): Promise<string | null> {
  const { client, calendar } = await getPersonalCalendar();
  const windowStart = new Date(start.getTime() - 30 * 60 * 1000);
  const windowEnd = new Date(start.getTime() + 30 * 60 * 1000);
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
  });
  const wanted = title.trim().toLowerCase();
  for (const obj of objects) {
    const match = /SUMMARY:(.+)/.exec(obj.data ?? '');
    if (!match) continue;
    const existing = match[1].trim().replace(/\\([,;\\])/g, '$1');
    const existingLower = existing.toLowerCase();
    if (existingLower === wanted || existingLower.includes(wanted) || wanted.includes(existingLower)) {
      return existing;
    }
  }
  return null;
}

export async function caldavDeleteEvent(created: CaldavCreated): Promise<void> {
  const { client } = await getPersonalCalendar();
  const response = await client.deleteCalendarObject({
    calendarObject: { url: created.url, etag: created.etag ?? '' },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`iCloud отказал в удалении: HTTP ${response.status}`);
  }
}
