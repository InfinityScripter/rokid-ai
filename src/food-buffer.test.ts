import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import './test-env.js';

import type { BufferedEntry } from './food-buffer.js';

// SQLITE_PATH задаём во временную папку ДО импорта config.js — иначе тест
// читал бы и удалял боевой файл буфера пользователя. Статические импорты
// хойстятся, поэтому используем динамический import() уже после того, как
// переменная окружения выставлена. import type не хойстится в рантайме — TS
// стирает его целиком, поэтому он безопасен и здесь, наверху файла.
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-food-buffer-test-')), 'test.sqlite');

const { config } = await import('./config.js');
const { bufferFlush, bufferPush } = await import('./food-buffer.js');

function bufferPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.food-buffer.json');
}

function entry(name: string): BufferedEntry {
  return { foodId: '1', name, servingId: '10', units: 1, meal: 'lunch', date: '2026-08-22T00:00:00.000Z' };
}

test('bufferPush: записи попадают в файл буфера', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  await bufferPush([entry('суп'), entry('хлеб')]);
  const data = JSON.parse(readFileSync(bufferPath(), 'utf8')) as { entries: BufferedEntry[] };
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].name, 'суп');
  assert.equal(data.entries[1].name, 'хлеб');
});

test('bufferFlush: падение отправителя на второй записи останавливает флаш и оставляет остаток', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  await bufferPush([entry('суп'), entry('хлеб')]);

  let calls = 0;
  const result = await bufferFlush(async () => {
    calls += 1;
    if (calls === 2) throw new Error('Premier ещё не одобрен');
    return 'entry-id-1';
  });

  assert.equal(result.sent, 1);
  assert.equal(result.left, 1);
  assert.deepEqual(
    result.flushed,
    [{ entryId: 'entry-id-1', batchId: undefined }],
    'id отправленной записи нужен, чтобы её можно было отменить',
  );

  const data = JSON.parse(readFileSync(bufferPath(), 'utf8')) as { entries: BufferedEntry[] };
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].name, 'хлеб');
});

test('bufferPushAndFlush: свои записи отличимы по метке партии от чужих, долежавших в буфере', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  const { bufferPushAndFlush } = await import('./food-buffer.js');
  await bufferPush([entry('вчерашний хлеб')]);

  let n = 0;
  const result = await bufferPushAndFlush([{ ...entry('борщ'), batchId: 'card-1' }], async () => `id-${++n}`);

  assert.equal(result.sent, 2, 'уехало и старое, и новое');
  const mine = result.flushed.filter((f) => f.batchId === 'card-1');
  assert.deepEqual(mine, [{ entryId: 'id-2', batchId: 'card-1' }], 'отменять надо только свою запись');
});

test('bufferDrop: отмена вычищает из буфера то, что ещё не уехало в FatSecret', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  const { bufferDrop, bufferSize } = await import('./food-buffer.js');
  await bufferPush([entry('суп'), entry('хлеб')]);
  const dropped = await bufferDrop((e) => e.name === 'суп');
  assert.equal(dropped, 1);
  assert.equal(await bufferSize(), 1);
});

test('bufferDrop: отмена другой карточки сохраняет причину остановки и историю отправки', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  const { bufferDrop, bufferStatus } = await import('./food-buffer.js');
  const pending = { ...entry('хлеб'), batchId: 'stuck-card' };
  await bufferPush([entry('суп'), pending]);
  await bufferFlush(async (e) => {
    if (e.batchId === 'stuck-card') throw new Error('FatSecret временно недоступен');
    return 'sent-soup';
  });
  const stuck = await bufferStatus();
  assert.equal(stuck.lastError, 'FatSecret временно недоступен');
  assert.ok(stuck.lastErrorAt);
  assert.ok(stuck.lastSuccessAt);

  await bufferPush([{ ...entry('чай'), batchId: 'cancelled-card' }]);
  assert.equal(await bufferDrop((e) => e.batchId === 'missing-card'), 0);
  assert.deepEqual(await bufferStatus(), { ...stuck, size: 2 });

  assert.equal(await bufferDrop((e) => e.batchId === 'cancelled-card'), 1);
  assert.deepEqual(await bufferStatus(), stuck, 'неотправленная карточка и её диагностика остались');
  assert.deepEqual(JSON.parse(readFileSync(bufferPath(), 'utf8')).entries, [pending]);
});

test('bufferDrop: полная отмена сохраняет последний успех, но новая очередь не наследует ошибку', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  const { bufferDrop, bufferStatus } = await import('./food-buffer.js');
  await bufferPush([entry('суп')]);
  await bufferFlush(async () => 'sent-soup');
  const sent = await bufferStatus();
  assert.ok(sent.lastSuccessAt);

  await bufferPush([{ ...entry('хлеб'), batchId: 'cancelled-card' }]);
  await bufferFlush(async () => {
    throw new Error('FatSecret временно недоступен');
  });
  assert.ok((await bufferStatus()).lastErrorAt);

  assert.equal(await bufferDrop((e) => e.batchId === 'cancelled-card'), 1);
  assert.deepEqual(await bufferStatus(), sent, 'отмена не стирает историю успеха и снимает ошибку пустой очереди');

  await bufferPush([entry('чай')]);
  assert.deepEqual(await bufferStatus(), { ...sent, size: 1 }, 'новую запись ещё не пытались отправить');
});

test('очередь помнит причину, по которой встала, и забывает её после успеха', async (t) => {
  t.after(() => rmSync(bufferPath(), { force: true }));
  const { bufferStatus } = await import('./food-buffer.js');
  await bufferPush([entry('борщ')]);

  await bufferFlush(async () => {
    throw new Error('FatSecret food_entry.create: 12 Missing required parameter');
  });
  const stuck = await bufferStatus();
  assert.equal(stuck.size, 1);
  assert.match(String(stuck.lastError), /Missing required parameter/, 'причина должна лежать рядом с очередью');
  assert.ok(stuck.lastErrorAt, 'и время, когда это случилось');

  await bufferFlush(async () => 'ok-1');
  const healed = await bufferStatus();
  assert.equal(healed.size, 0);
  assert.equal(healed.lastError, undefined, 'после удачной отправки причина стирается');
  assert.ok(healed.lastSuccessAt, 'и появляется отметка последней удачной отправки');
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
