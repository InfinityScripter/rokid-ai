import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';

import { config } from './config.js';
import { bufferFlush, bufferPush, type BufferedEntry } from './food-buffer.js';

function bufferPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.food-buffer.json');
}

function entry(name: string): BufferedEntry {
  return { foodId: '1', name, servingId: '10', units: 1, meal: 'lunch', date: '2026-08-22T00:00:00.000Z' };
}

test('bufferPush: записи попадают в файл буфера', (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  bufferPush([entry('суп'), entry('хлеб')]);
  const data = JSON.parse(readFileSync(bufferPath(), 'utf8')) as { entries: BufferedEntry[] };
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].name, 'суп');
  assert.equal(data.entries[1].name, 'хлеб');
});

test('bufferFlush: падение отправителя на второй записи останавливает флаш и оставляет остаток', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  bufferPush([entry('суп'), entry('хлеб')]);

  let calls = 0;
  const result = await bufferFlush(async () => {
    calls += 1;
    if (calls === 2) throw new Error('Premier ещё не одобрен');
    return 'entry-id-1';
  });

  assert.equal(result.sent, 1);
  assert.equal(result.left, 1);

  const data = JSON.parse(readFileSync(bufferPath(), 'utf8')) as { entries: BufferedEntry[] };
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].name, 'хлеб');
});

test('bufferFlush: пустой буфер — сразу {sent: 0, left: 0}, отправитель не вызывается', async () => {
  let called = false;
  const result = await bufferFlush(async () => {
    called = true;
    return 'x';
  });
  assert.equal(result.sent, 0);
  assert.equal(result.left, 0);
  assert.equal(called, false);
});
