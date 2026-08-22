import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

// Очередь рабочих событий (режим vds): бот кладёт задания, мостик на Маке
// забирает их, пишет через Calendar.app и отчитывается. Объём — единицы
// заданий в день, поэтому хранилище — обычный JSON-файл.

export type WorkJob = {
  id: number;
  action: 'create' | 'delete';
  payload: string;
  status: 'pending' | 'done' | 'cancelled' | 'skipped';
  result: string | null;
  createdAt: string;
};

export type CreatePayload = { title: string; start: string; durationMinutes: number; location?: string };
export type DeletePayload = { calendarName: string; uid: string };

type QueueFile = { nextId: number; jobs: WorkJob[] };

function queuePath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.json');
}

function load(): QueueFile {
  try {
    return JSON.parse(readFileSync(queuePath(), 'utf8')) as QueueFile;
  } catch {
    return { nextId: 1, jobs: [] };
  }
}

function save(data: QueueFile): void {
  mkdirSync(path.dirname(queuePath()), { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(data, null, 2));
}

export function enqueueJob(action: WorkJob['action'], payload: CreatePayload | DeletePayload): number {
  const data = load();
  const id = data.nextId;
  data.nextId += 1;
  data.jobs.push({
    id,
    action,
    payload: JSON.stringify(payload),
    status: 'pending',
    result: null,
    createdAt: new Date().toISOString(),
  });
  save(data);
  return id;
}

export function pendingJobs(): WorkJob[] {
  return load().jobs.filter((j) => j.status === 'pending');
}

export function cancelJob(id: number): boolean {
  const data = load();
  const job = data.jobs.find((j) => j.id === id);
  if (!job || job.status !== 'pending') return false;
  job.status = 'cancelled';
  save(data);
  return true;
}

export function completeJob(id: number, status: 'done' | 'skipped', result: string): void {
  const data = load();
  const job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = status;
  job.result = result;
  save(data);
}

export function getJob(id: number): WorkJob | undefined {
  return load().jobs.find((j) => j.id === id);
}
