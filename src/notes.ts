import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

// Заметки (intent=note) раньше только показывались в чате и терялись.
// Хранилище — JSONL рядом с очередью: одна строка = одна заметка, append
// не переписывает файл, поэтому не нужна цепочка промисов как у буфера еды.

export type Note = { text: string; at: string };

function notesPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.notes.jsonl');
}

export function addNote(text: string, at: Date = new Date()): void {
  mkdirSync(path.dirname(notesPath()), { recursive: true });
  appendFileSync(notesPath(), `${JSON.stringify({ text, at: at.toISOString() })}\n`);
}

export function listNotes(limit: number): Note[] {
  let raw: string;
  try {
    raw = readFileSync(notesPath(), 'utf8');
  } catch {
    return [];
  }
  const notes: Note[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Note;
      if (typeof parsed.text === 'string' && typeof parsed.at === 'string') notes.push(parsed);
    } catch {
      // Битая строка (оборванная запись при падении) не должна прятать
      // остальные заметки.
    }
  }
  return notes.slice(-limit);
}
