import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import './test-env.js';

import type { VisionAnswer, Zone } from './vision.js';

// SQLITE_PATH — во временную папку ДО импорта config.js (тот же приём, что
// в food-buffer.test.ts): профиль пробы зрения не должен трогать боевой файл.
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-vision-test-')), 'test.sqlite');

const { analyzeVision, loadProfile, saveProfile, ZONES } = await import('./vision.js');

const SIZES = [14, 20, 28, 36];

// Полный план пробы, как его строят очки: 4 размера × 2 начертания × 5 зон.
function plan(read: (a: { size: number; bold: boolean; zone: Zone }) => boolean): VisionAnswer[] {
  return SIZES.flatMap((size) =>
    [false, true].flatMap((bold) =>
      ZONES.map((zone) => ({ size, bold, zone, read: read({ size, bold, zone }) })),
    ),
  );
}

test('всё прочитано → самый мелкий размер, обычное начертание, центр при равенстве зон', () => {
  const { profile } = analyzeVision(plan(() => true));
  assert.equal(profile.size, 14);
  assert.equal(profile.bold, false);
  assert.equal(profile.zone, 'center');
});

test('обычный 14 не читается, жирный 14 читается → жирный мелкий лучше обычного крупного', () => {
  const { profile } = analyzeVision(plan((a) => a.size > 14 || a.bold));
  assert.equal(profile.size, 14);
  assert.equal(profile.bold, true);
});

test('14 не читается совсем, с 20 обычный читается → 20 обычный', () => {
  const { profile } = analyzeVision(plan((a) => a.size >= 20));
  assert.equal(profile.size, 20);
  assert.equal(profile.bold, false);
});

test('ни один размер не прочитан во всех зонах → самый крупный и жирный', () => {
  // В каждой группе размер+начертание зона right всегда провалена.
  const { profile } = analyzeVision(plan((a) => a.zone !== 'right'));
  assert.equal(profile.size, 36);
  assert.equal(profile.bold, true);
});

test('зона с наибольшим числом прочитанных карточек попадает в профиль', () => {
  const { profile } = analyzeVision(plan((a) => a.zone === 'left' || (a.zone === 'center' && a.size >= 28)));
  assert.equal(profile.zone, 'left');
});

test('report и screen: человекочитаемый итог с размером и зоной', () => {
  const { report, screen } = analyzeVision(plan(() => true));
  assert.match(report, /Комфортный размер: 14, обычный/);
  assert.match(report, /Лучшая зона: центр \(8\/8\)/);
  assert.match(report, /14 — 10\/10/);
  assert.equal(screen.title, 'ГОТОВО');
  assert.match(screen.text, /Размер 14/);
});

test('loadProfile: файла нет → null', () => {
  assert.equal(loadProfile(), null);
});

test('saveProfile → loadProfile: профиль переживает запись и чтение', (t) => {
  t.after(() => rmSync(path.dirname(process.env.SQLITE_PATH ?? ''), { recursive: true, force: true }));
  const profile = { size: 20, bold: true, zone: 'center' as const, updatedAt: '2026-08-26T00:00:00.000Z' };
  saveProfile(profile);
  assert.deepEqual(loadProfile(), profile);
});
