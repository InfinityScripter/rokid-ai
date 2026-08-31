import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import './test-env.js';

// SQLITE_PATH — во временную папку ДО импорта config.js (тот же приём, что
// в food-buffer.test.ts): тесты не должны трогать боевой файл заметок.
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-notes-test-')), 'test.sqlite');

const { addNote, listNotes } = await import('./notes.js');

const notesPath = process.env.SQLITE_PATH.replace(/\.sqlite$/, '.notes.jsonl');

test('файла нет → пустой список', () => {
  assert.deepEqual(listNotes(10), []);
});

test('addNote → listNotes: заметки в порядке добавления, лимит берёт последние', (t) => {
  t.after(() => rmSync(notesPath, { force: true }));
  addNote('первая', new Date('2026-08-26T10:00:00.000Z'));
  addNote('вторая', new Date('2026-08-26T11:00:00.000Z'));
  addNote('третья', new Date('2026-08-26T12:00:00.000Z'));

  const all = listNotes(10);
  assert.deepEqual(
    all.map((n) => n.text),
    ['первая', 'вторая', 'третья'],
  );
  assert.equal(all[0].at, '2026-08-26T10:00:00.000Z');

  assert.deepEqual(
    listNotes(2).map((n) => n.text),
    ['вторая', 'третья'],
  );
});

test('битая строка в файле не прячет остальные заметки', (t) => {
  t.after(() => rmSync(notesPath, { force: true }));
  addNote('до мусора');
  appendFileSync(notesPath, 'обрыв записи не json\n');
  addNote('после мусора');
  assert.deepEqual(
    listNotes(10).map((n) => n.text),
    ['до мусора', 'после мусора'],
  );
});
