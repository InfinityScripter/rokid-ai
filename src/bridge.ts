import { createCalendarEvent, deleteEventByUid, findDuplicateEvent } from './calendar.js';
import { config } from './config.js';
import { log, logError } from './log.js';
import type { CreatePayload, DeletePayload, WorkJob } from './queue.js';

// Мостик: запускается на Маке (launchd, раз в минуту), забирает очередь рабочих
// событий с VDS и пишет их в корпоративный календарь через Calendar.app.
// Запуск: npm run bridge

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  if (!config.BRIDGE_BASE_URL || !config.INBOX_TOKEN) {
    throw new Error('Для мостика нужны BRIDGE_BASE_URL и INBOX_TOKEN в ~/.config/rokid-ai/.env');
  }
  const response = await fetch(`${config.BRIDGE_BASE_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.INBOX_TOKEN}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`VDS ответил HTTP ${response.status} на ${pathname}`);
  return response;
}

async function processJob(job: WorkJob): Promise<{ status: 'done' | 'skipped'; result: string }> {
  if (job.action === 'delete') {
    const payload = JSON.parse(job.payload) as DeletePayload;
    await deleteEventByUid(payload);
    return { status: 'done', result: 'deleted' };
  }

  const payload = JSON.parse(job.payload) as CreatePayload;
  let duplicate: string | null = null;
  try {
    duplicate = await findDuplicateEvent('work', payload.title, new Date(payload.start));
  } catch (error) {
    logError('bridge-dedup', error);
  }
  if (duplicate) {
    return { status: 'skipped', result: `похожее уже стоит («${duplicate}»), не дублирую` };
  }
  const created = await createCalendarEvent({
    title: payload.title,
    start: new Date(payload.start),
    durationMinutes: payload.durationMinutes,
    calendar: 'work',
    location: payload.location,
  });
  return { status: 'done', result: JSON.stringify(created) };
}

const response = await api('/bridge/jobs');
const { jobs } = (await response.json()) as { jobs: WorkJob[] };
if (jobs.length === 0) {
  process.exit(0);
}
log(`мостик: заданий в очереди — ${jobs.length}`);
for (const job of jobs) {
  try {
    const outcome = await processJob(job);
    await api('/bridge/complete', { method: 'POST', body: JSON.stringify({ id: job.id, ...outcome }) });
    log(`мостик: задание ${job.id} → ${outcome.status}`);
  } catch (error) {
    logError(`bridge-job-${job.id}`, error);
  }
}
process.exit(0);
