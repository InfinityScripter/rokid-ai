import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { FoodMatch } from './food.js';
import { PendingState } from './pending.js';

const match = (name: string): FoodMatch => ({
  name,
  amount: '1 шт',
  food: { foodId: '1', foodName: name },
  servingId: 's1',
  units: 1,
  grams: null,
  calories: 100,
  note: null,
});

function tmpFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-pending-test-'));
  return { file: path.join(dir, 'test.pending.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('карточка, правка и режим «штрихкод» переживают перезапуск (новый экземпляр на том же файле)', (t) => {
  const { file, cleanup } = tmpFile();
  t.after(cleanup);

  const before = new PendingState(file);
  before.setCard('k1', { meal: 'dinner', matches: [match('творог')], header: '🔎 Штрихкод 460…' });
  before.setEdit({ key: 'k1', meal: 'dinner', matches: [match('творог')] });
  before.setBarcodeArmed(true);

  const after = new PendingState(file);
  const card = after.getCard('k1');
  assert.equal(card?.meal, 'dinner');
  assert.equal(card?.header, '🔎 Штрихкод 460…');
  assert.deepEqual(card?.matches, [match('творог')]);
  assert.equal(after.edit?.key, 'k1');
  assert.equal(after.barcodeArmed, true);

  assert.equal(after.deleteCard('k1'), true);
  assert.equal(after.deleteCard('k1'), false);
  assert.equal(after.getCard('k1'), undefined);
  // Правка к удалённой карточке снимается вместе с ней.
  assert.equal(after.edit, null);
  assert.equal(new PendingState(file).getCard('k1'), undefined);
});

test('карточка старше суток исчезает, правка к ней снимается; свежая остаётся', (t) => {
  const { file, cleanup } = tmpFile();
  t.after(cleanup);
  const t0 = new Date('2026-09-03T12:00:00.000Z');

  const early = new PendingState(file, () => t0);
  early.setCard('old', { meal: 'lunch', matches: [match('суп')] });
  early.setEdit({ key: 'old', meal: 'lunch', matches: [match('суп')] });
  const later = new PendingState(file, () => new Date(t0.getTime() + 23 * 60 * 60 * 1000));
  later.setCard('fresh', { meal: 'dinner', matches: [match('рис')] });

  const nextDay = new PendingState(file, () => new Date(t0.getTime() + 25 * 60 * 60 * 1000));
  assert.equal(nextDay.getCard('old'), undefined);
  assert.equal(nextDay.edit, null);
  assert.equal(nextDay.getCard('fresh')?.meal, 'dinner');
});

test('не больше 50 карточек: самые старые вытесняются', (t) => {
  const { file, cleanup } = tmpFile();
  t.after(cleanup);
  const t0 = Date.parse('2026-09-03T12:00:00.000Z');
  let tick = 0;
  const state = new PendingState(file, () => new Date(t0 + tick * 1000));
  for (let i = 0; i < 55; i += 1) {
    tick = i;
    state.setCard(`k${i}`, { meal: 'other', matches: [match(`еда ${i}`)] });
  }
  assert.equal(state.getCard('k0'), undefined);
  assert.equal(state.getCard('k4'), undefined);
  assert.equal(state.getCard('k5')?.matches[0].name, 'еда 5');
  assert.equal(state.getCard('k54')?.matches[0].name, 'еда 54');
});

test('битый или отсутствующий файл → пустое состояние, а не падение', (t) => {
  const { file, cleanup } = tmpFile();
  t.after(cleanup);
  assert.equal(new PendingState(file).barcodeArmed, false);
  writeFileSync(file, '{not json');
  const state = new PendingState(file);
  assert.equal(state.getCard('x'), undefined);
  assert.equal(state.edit, null);
  state.setBarcodeArmed(true);
  assert.equal(new PendingState(file).barcodeArmed, true);
});
