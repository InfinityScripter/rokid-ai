import assert from 'node:assert/strict';
import { test } from 'node:test';

import './test-env.js';

import { parseFoodEntries, parseMonthTotals, type FoodEntry } from './fatsecret.js';
import { dayLabel, dueReminder, formatDaySummary, formatWeekSummary, parseDayArg } from './reminders.js';

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

test('parseMonthTotals: дни по date_int → YYYY-MM-DD, один день объектом, пустой месяц', () => {
  const days = parseMonthTotals({
    month: {
      from_date_int: '20699',
      to_date_int: '20728',
      day: [
        { date_int: String(DAY), calories: '1450', carbohydrate: '160', protein: '78', fat: '52' },
        { date_int: String(DAY + 1), calories: '662', carbohydrate: '42', protein: '35', fat: '39' },
      ],
    },
  });
  assert.deepEqual(days[0], { date: '2026-09-03', calories: 1450, protein: 78, fat: 52, carbs: 160 });
  assert.equal(days[1].date, '2026-09-04');
  assert.equal(parseMonthTotals({ month: { day: { date_int: String(DAY), calories: '1' } } }).length, 1);
  assert.deepEqual(parseMonthTotals({ month: null }), []);
  assert.deepEqual(parseMonthTotals({}), []);
});

test('dayLabel и parseDayArg: сегодня/вчера/позавчера, «3 сентября», «3 сен», ISO, будущее → прошлый год', () => {
  assert.equal(dayLabel('2026-09-05', '2026-09-05'), 'сегодня, 5 сентября');
  assert.equal(dayLabel('2026-09-04', '2026-09-05'), 'вчера, 4 сентября');
  assert.equal(dayLabel('2026-09-03', '2026-09-05'), 'позавчера, 3 сентября');
  assert.equal(dayLabel('2026-08-30', '2026-09-05'), '30 августа');

  assert.equal(parseDayArg('', '2026-09-05'), '2026-09-05');
  assert.equal(parseDayArg('вчера', '2026-09-05'), '2026-09-04');
  assert.equal(parseDayArg('Позавчера', '2026-09-05'), '2026-09-03');
  assert.equal(parseDayArg('3 сентября', '2026-09-05'), '2026-09-03');
  assert.equal(parseDayArg('3 сен', '2026-09-05'), '2026-09-03');
  assert.equal(parseDayArg('2026-08-30', '2026-09-05'), '2026-08-30');
  assert.equal(parseDayArg('30 декабря', '2026-09-05'), '2025-12-30');
  assert.equal(parseDayArg('когда-то', '2026-09-05'), null);
});

test('formatDaySummary: итого с БЖУ, приёмы по порядку с ккал по позициям, чего не хватает, буфер', () => {
  const text = formatDaySummary(
    [
      entry('чизкейк', 'dinner', 278.4, [40.2, 13.1, 9.9]),
      entry('овсянка', 'breakfast', 150, [5, 3, 27]),
      entry('банан', 'other', 89, [1, 0, 23]),
    ],
    { kind: 'evening', buffered: 2, date: '2026-09-03', today: '2026-09-03' },
  );
  const lines = text.split('\n');
  assert.equal(lines[0], '🌙 Итоги дня, сегодня, 3 сентября:');
  assert.equal(lines[1], 'Итого: 517 ккал · Б 46 г · Ж 16 г · У 60 г');
  assert.equal(lines[2], '🍳 Завтрак — 150 ккал: овсянка 150');
  assert.equal(lines[3], '🌙 Ужин — 278 ккал: чизкейк 278');
  assert.equal(lines[4], '🍎 Перекус — 89 ккал: банан 89');
  assert.match(lines[5], /^📤 Ещё 2 поз\. в буфере/);
  assert.equal(lines[7], 'Не вижу: обед. Записать? Надиктуй, напиши или пришли фото.');
});

test('formatDaySummary: пустой дневник, все приёмы на месте, прошлый день без призыва записать', () => {
  const empty = formatDaySummary([], { kind: 'midday', buffered: 0, date: '2026-09-03', today: '2026-09-03' });
  assert.match(empty, /^☀️ Еда за сегодня, 3 сентября, пока что:\nВ дневнике FatSecret пусто\./);
  assert.match(empty, /забыл записать/);
  assert.doesNotMatch(empty, /буфере/);

  const full = formatDaySummary(
    [entry('а', 'breakfast', 1), entry('б', 'lunch', 1), entry('в', 'dinner', 1)],
    { kind: 'manual', buffered: 0, date: '2026-09-03', today: '2026-09-03' },
  );
  assert.match(full, /^📊 Итоги дня, сегодня, 3 сентября:/);
  assert.match(full, /Ничего не забыл записать\?/);

  const yesterday = formatDaySummary([entry('а', 'breakfast', 1)], { kind: 'manual', buffered: 3, date: '2026-09-02', today: '2026-09-03' });
  assert.match(yesterday, /^📊 Итоги дня, вчера, 2 сентября:/);
  assert.match(yesterday, /Не записано: обед, ужин\. Если ел — скажи «вчера на обед …», добавлю\./);
  assert.doesNotMatch(yesterday, /буфере/);
});

test('formatWeekSummary: 7 дней подряд, пустые как «пусто», среднее по заполненным', () => {
  const text = formatWeekSummary(
    [
      { date: '2026-09-03', calories: 1450, protein: 78, fat: 52, carbs: 160 },
      { date: '2026-08-30', calories: 2000, protein: 100, fat: 60, carbs: 200 },
    ],
    '2026-09-04',
  );
  const lines = text.split('\n');
  assert.equal(lines[0], '📈 Последние 7 дней:');
  assert.equal(lines[1], 'сб 29 авг — пусто');
  assert.equal(lines[2], 'вс 30 авг — 2000 ккал · Б 100 г · Ж 60 г · У 200 г');
  assert.equal(lines[6], 'чт 3 сен — 1450 ккал · Б 78 г · Ж 52 г · У 160 г');
  assert.equal(lines[7], 'пт 4 сен — пусто');
  assert.equal(lines[9], 'Среднее за 2 дн. с записями: 1725 ккал · Б 89 г · Ж 56 г · У 180 г');
});

test('formatDaySummary и formatWeekSummary с нормой: остаток/перебор и пометка дней сверх нормы', () => {
  const day = formatDaySummary([entry('обед', 'lunch', 1450, [78, 52, 160])], {
    kind: 'manual',
    buffered: 0,
    date: '2026-09-03',
    today: '2026-09-03',
    goal: { kcal: 2200, protein: 150 },
  });
  assert.equal(day.split('\n')[2], '🎯 Норма 2200 ккал: осталось 750 ккал · Б 78/150');

  const week = formatWeekSummary(
    [
      { date: '2026-09-03', calories: 2450, protein: 78, fat: 52, carbs: 160 },
      { date: '2026-09-04', calories: 1000, protein: 10, fat: 10, carbs: 10 },
    ],
    '2026-09-04',
    { kcal: 2200 },
  );
  const lines = week.split('\n');
  assert.equal(lines[0], '📈 Последние 7 дней (норма 2200 ккал):');
  assert.equal(lines[6], 'чт 3 сен — 2450 ккал · Б 78 г · Ж 52 г · У 160 г ⚠️ +250');
  assert.equal(lines[7], 'пт 4 сен — 1000 ккал · Б 10 г · Ж 10 г · У 10 г');
});
