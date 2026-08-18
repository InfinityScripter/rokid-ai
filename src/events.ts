import { createCalendarEvent, deleteEventByUid, findDuplicateEvent } from './calendar.js';
import { caldavCreateEvent, caldavDeleteEvent, caldavFindDuplicate } from './caldav.js';
import { config } from './config.js';
import { formatEventLine } from './format.js';
import { log, logError } from './log.js';
import { cancelJob, enqueueJob, getJob, type CreatePayload, type DeletePayload } from './queue.js';

// Единая точка записи/отмены событий поверх трёх механик:
// Calendar.app (Мак), iCloud CalDAV (VDS, личное), очередь мостика (VDS, рабочее).

export type CalendarEventInput = {
  title: string;
  start: string;
  durationMinutes: number;
  calendar: 'work' | 'personal';
};

export type UndoRef =
  | { kind: 'apple'; calendarName: string; uid: string }
  | { kind: 'caldav'; url: string }
  | { kind: 'job'; id: number };

export type WriteOutcome = { line: string; undo?: UndoRef };

export async function writeOneEvent(event: CalendarEventInput): Promise<WriteOutcome> {
  if (config.ROKID_MODE === 'vds' && event.calendar === 'work') {
    const payload: CreatePayload = {
      title: event.title,
      start: event.start,
      durationMinutes: event.durationMinutes,
    };
    const id = enqueueJob('create', payload);
    log('queue: enqueued create job', id, event.title);
    return {
      line: `📤 ${formatEventLine(event)} — поставила в очередь, Мак запишет и отчитается`,
      undo: { kind: 'job', id },
    };
  }

  // Дедупликация — best effort: упавшая проверка не должна блокировать запись.
  let duplicate: string | null = null;
  try {
    duplicate =
      config.ROKID_MODE === 'vds'
        ? await caldavFindDuplicate(event.title, new Date(event.start))
        : await findDuplicateEvent(event.calendar, event.title, new Date(event.start));
  } catch (error) {
    logError('dedup', error);
  }
  if (duplicate) {
    log('dedup: skip', event.title, '≈', duplicate);
    return { line: `⏭ ${formatEventLine(event)} — похожее уже стоит («${duplicate}»), не дублирую` };
  }

  if (config.ROKID_MODE === 'vds') {
    const created = await caldavCreateEvent({
      title: event.title,
      start: new Date(event.start),
      durationMinutes: event.durationMinutes,
    });
    return {
      line: `✅ ${formatEventLine(event)} → «${config.APPLE_CALENDAR_PERSONAL}»`,
      undo: { kind: 'caldav', url: created.url },
    };
  }

  const created = await createCalendarEvent({
    title: event.title,
    start: new Date(event.start),
    durationMinutes: event.durationMinutes,
    calendar: event.calendar,
  });
  log('calendar: created', event.title, '→', created.calendarName);
  return {
    line: `✅ ${formatEventLine(event)} → «${created.calendarName}»`,
    undo: { kind: 'apple', calendarName: created.calendarName, uid: created.uid },
  };
}

export async function undoOne(ref: UndoRef): Promise<string> {
  switch (ref.kind) {
    case 'apple':
      await deleteEventByUid({ calendarName: ref.calendarName, uid: ref.uid });
      return 'удалила из календаря';
    case 'caldav':
      await caldavDeleteEvent({ url: ref.url });
      return 'удалила из календаря';
    case 'job': {
      if (cancelJob(ref.id)) return 'убрала из очереди до записи';
      const job = getJob(ref.id);
      if (job?.status === 'done' && job.result) {
        const written = JSON.parse(job.result) as DeletePayload;
        enqueueJob('delete', written);
        return 'событие уже записано — поставила удаление в очередь';
      }
      return 'задание уже отменено или не найдено';
    }
  }
}
