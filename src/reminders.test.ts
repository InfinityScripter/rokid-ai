import assert from 'node:assert/strict';
import { test } from 'node:test';

import './test-env.js';

import { parseFoodEntries, type FoodEntry } from './fatsecret.js';
import { dueReminder, formatDaySummary } from './reminders.js';

const entry = (name: string, meal: FoodEntry['meal'], calories: number, macros: [number, number, number] = [0, 0, 0]): FoodEntry => ({
  name,
  meal,
  units: 1,
  calories,
  protein: macros[0],
  fat: macros[1],
  carbs: macros[2],
});

// 3 сентября 2026, московский день = UTC-день (МСК = UTC+3, до полуночи UTC).
const DAY = Date.UTC(2026, 8, 3) / 86_400_000;

test('dueReminder: до 14:30 МСК — ничего, после — дневное, после 21:30 — вечернее, второй раз за день не шлём', () => {
  assert.equal(dueReminder(new Date('2026-09-03T11:29:00Z'), {}), null);
  assert.equal(dueReminder(new Date('2026-09-03T11:30:00Z'), {}), 'midday');
  assert.equal(dueReminder(new Date('2026-09-03T12:00:00Z'), { midday: DAY }), null);
  assert.equal(dueReminder(new Date('2026-09-03T18:30:00Z'), { midday: DAY }), 'evening');
  assert.equal(dueReminder(new Date('2026-09-03T18:45:00Z'), { midday: DAY, evening: DAY }), null);
  // Отметка вчерашняя — сегодня снова пора.
  assert.equal(dueReminder(new Date('2026-09-04T11:31:00Z'), { midday: DAY, evening: DAY }), 'midday');
});

test('dueReminder: бот лежал с обеда — вечером одно вечернее, а не дневное в 22:00', () => {
  assert.equal(dueReminder(new Date('2026-09-03T19:00:00Z'), {}), 'evening');
});

test('parseFoodEntries: массив, одиночный объект, пустой день, строки-числа, meal в нижний регистр', () => {
  const two = parseFoodEntries({
    food_entries: {
      food_entry: [
        { food_entry_name: 'Oatmeal', meal: 'Breakfast', number_of_units: '1', calories: '150', protein: '5', fat: '3', carbohydrate: '27' },
        { food_entry_name: 'Snack', meal: 'Other', number_of_units: '2.5', calories: '80', protein: '1', fat: '0', carbohydrate: '20' },
      ],
    },
  });
  assert.equal(two.length, 2);
  assert.deepEqual(two[0], { name: 'Oatmeal', meal: 'breakfast', units: 1, calories: 150, protein: 5, fat: 3, carbs: 27 });
  assert.equal(two[1].units, 2.5);
  assert.equal(two[1].meal, 'other');

  const one = parseFoodEntries({
    food_entries: { food_entry: { food_entry_name: 'Borscht', meal: 'Lunch', calories: '300', protein: 'x' } },
  });
  assert.equal(one.length, 1);
  assert.equal(one[0].meal, 'lunch');
  assert.equal(one[0].protein, 0);

  assert.deepEqual(parseFoodEntries({ food_entries: null }), []);
  assert.deepEqual(parseFoodEntries({ food_entries: {} }), []);
  assert.deepEqual(parseFoodEntries(null), []);
});

test('formatDaySummary: итого с БЖУ, приёмы пищи по порядку, чего не хватает, буфер', () => {
  const text = formatDaySummary(
    [
      entry('Творожное зерно', 'dinner', 278.4, [40.2, 13.1, 9.9]),
      entry('Овсянка', 'breakfast', 150, [5, 3, 27]),
      entry('Банан', 'other', 89, [1, 0, 23]),
    ],
    { kind: 'evening', buffered: 2, now: new Date('2026-09-03T18:30:00Z') },
  );
  const lines = text.split('\n');
  assert.equal(lines[0], '🌙 Итоги дня, 3 сентября:');
  assert.equal(lines[1], 'Итого: 517 ккал · Б 46 г · Ж 16 г · У 60 г');
  assert.equal(lines[2], '🍳 Завтрак — 150 ккал: Овсянка');
  assert.equal(lines[3], '🌙 Ужин — 278 ккал: Творожное зерно');
  assert.equal(lines[4], '🍎 Перекус — 89 ккал: Банан');
  assert.match(lines[5], /^📤 Ещё 2 поз\. в буфере/);
  assert.equal(lines[7], 'Не вижу: обед. Записать? Надиктуй, напиши или пришли фото.');
});

test('formatDaySummary: пустой дневник и все приёмы на месте', () => {
  const empty = formatDaySummary([], { kind: 'midday', buffered: 0, now: new Date('2026-09-03T11:30:00Z') });
  assert.match(empty, /^☀️ Еда за 3 сентября, пока что:\nВ дневнике FatSecret пусто\./);
  assert.match(empty, /забыл записать/);
  assert.doesNotMatch(empty, /буфере/);

  const full = formatDaySummary(
    [entry('а', 'breakfast', 1), entry('б', 'lunch', 1), entry('в', 'dinner', 1)],
    { kind: 'manual', buffered: 0, now: new Date('2026-09-03T11:30:00Z') },
  );
  assert.match(full, /^📊 Итоги дня, 3 сентября:/);
  assert.match(full, /Ничего не забыл записать\?/);
  assert.doesNotMatch(full, /Не вижу/);
});
