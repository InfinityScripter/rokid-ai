import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import './test-env.js';

process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-goal-test-')), 'test.sqlite');

const { formatGoal, goalLine, loadGoal, parseGoal, saveGoal } = await import('./goal.js');

test('parseGoal: ккал, ккал с БЖУ в разных написаниях, сброс, мусор и нереальные значения', () => {
  assert.deepEqual(parseGoal('2200'), { kcal: 2200 });
  assert.deepEqual(parseGoal('2200 ккал'), { kcal: 2200 });
  assert.deepEqual(parseGoal('2200 б150 ж70 у200'), { kcal: 2200, protein: 150, fat: 70, carbs: 200 });
  assert.deepEqual(parseGoal('2200 Б 150 Ж 70 У 200'), { kcal: 2200, protein: 150, fat: 70, carbs: 200 });
  assert.deepEqual(parseGoal('1800 б:120'), { kcal: 1800, protein: 120 });
  assert.equal(parseGoal('0'), null);
  assert.equal(parseGoal('off'), null);
  assert.equal(parseGoal('много'), 'invalid');
  assert.equal(parseGoal('50'), 'invalid');
  assert.equal(parseGoal('99999'), 'invalid');
});

test('goalLine: осталось / перебор, БЖУ как факт/норма; formatGoal', () => {
  assert.equal(goalLine({ kcal: 2200 }, { calories: 1450, protein: 78, fat: 52, carbs: 160 }), '🎯 Норма 2200 ккал: осталось 750 ккал');
  assert.equal(goalLine({ kcal: 2200 }, { calories: 2320.4, protein: 0, fat: 0, carbs: 0 }), '🎯 Норма 2200 ккал: перебор на 120 ккал');
  assert.equal(
    goalLine({ kcal: 2200, protein: 150, carbs: 200 }, { calories: 1450, protein: 78.4, fat: 52, carbs: 160 }),
    '🎯 Норма 2200 ккал: осталось 750 ккал · Б 78/150 · У 160/200',
  );
  assert.equal(formatGoal({ kcal: 2200 }), '2200 ккал');
  assert.equal(formatGoal({ kcal: 2200, protein: 150, fat: 70 }), '2200 ккал · Б 150 г · Ж 70 г');
});

test('saveGoal/loadGoal: переживает перезапуск, сброс и битый файл → null', (t) => {
  const { config } = { config: { SQLITE_PATH: process.env.SQLITE_PATH as string } };
  t.after(() => rmSync(path.dirname(config.SQLITE_PATH), { recursive: true, force: true }));
  assert.equal(loadGoal(), null);
  saveGoal({ kcal: 2200, protein: 150 });
  assert.deepEqual(loadGoal(), { kcal: 2200, protein: 150 });
  saveGoal(null);
  assert.equal(loadGoal(), null);
});
