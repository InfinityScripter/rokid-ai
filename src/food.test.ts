import assert from 'node:assert/strict';
import { test } from 'node:test';

// Раньше остальных локальных импортов: food.js тянет config.js, который
// без этих переменных завершает процесс.
import './test-env.js';

import type { FsFood, FsRegion, FsServing } from './fatsecret.js';
import { matchFoodItems } from './food.js';

const food = (foodId: string, name: string): FsFood => ({ foodId, name, brand: null, description: '' });

const serving = (servingId: string, calories: number): FsServing => ({
  servingId,
  description: '1 serving',
  grams: 100,
  calories,
  protein: 1,
  fat: 1,
  carbs: 1,
});

test('пустой поиск → food:null, note «не нашла в базе»', async () => {
  const [result] = await matchFoodItems([{ name: 'борщ', amount: 'тарелка', query: 'borscht' }], {
    searchFoods: async () => [],
  });
  assert.equal(result.food, null);
  assert.equal(result.note, 'не нашла в базе');
  assert.equal(result.calories, null);
});

test('калории = calories сервинга × units', async () => {
  const [result] = await matchFoodItems([{ name: 'тост с сыром', amount: '2 шт', query: 'toast with cheese' }], {
    searchFoods: async () => [food('111', 'Toast with Cheese')],
    getServings: async () => [serving('s1', 120)],
    chooseFood: async () => ({ foodId: '111', servingId: 's1', units: 2, grams: 100 }),
  });
  assert.equal(result.food?.foodId, '111');
  assert.equal(result.servingId, 's1');
  assert.equal(result.units, 2);
  assert.equal(result.calories, 240);
  assert.equal(result.note, null);
});

test('ошибка одного item не роняет остальные — изоляция по элементу', async () => {
  const results = await matchFoodItems(
    [
      { name: 'борщ', amount: 'тарелка', query: 'borscht' },
      { name: 'тост', amount: '1 шт', query: 'toast' },
    ],
    {
      searchFoods: async (query) => {
        if (query === 'borscht') throw new Error('FatSecret недоступен');
        return [food('222', 'Toast')];
      },
      getServings: async () => [serving('s2', 90)],
      chooseFood: async () => ({ foodId: '222', servingId: 's2', units: 1, grams: 30 }),
    },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].food, null);
  assert.equal(results[0].note, 'ошибка подбора — попробуй ещё раз');
  assert.equal(results[1].food?.foodId, '222');
  assert.equal(results[1].calories, 90);
  assert.equal(results[1].note, null);
});

test('невалидная пара food/serving от модели → откат на первого кандидата с сервингами', async () => {
  const [result] = await matchFoodItems([{ name: 'суп', amount: 'тарелка', query: 'soup' }], {
    searchFoods: async () => [food('a1', 'Soup A'), food('a2', 'Soup B')],
    getServings: async (foodId) => (foodId === 'a1' ? [serving('sa1', 200)] : []),
    chooseFood: async () => ({ foodId: 'a2', servingId: 'unknown', units: 1, grams: null }),
  });
  assert.equal(result.food?.foodId, 'a1');
  assert.equal(result.servingId, 'sa1');
  assert.equal(result.calories, 200);
});

test('все кандидаты без сервингов → note «не нашла порций в базе», LLM не вызывается', async () => {
  let called = false;
  const [result] = await matchFoodItems([{ name: 'нечто', amount: '1 шт', query: 'something' }], {
    searchFoods: async () => [food('b1', 'Something')],
    getServings: async () => [],
    chooseFood: async () => {
      called = true;
      return { foodId: 'b1', servingId: 'x', units: 1, grams: null };
    },
  });
  assert.equal(result.food, null);
  assert.equal(result.note, 'не нашла порций в базе');
  assert.equal(called, false);
});

test('units вне диапазона (0, отрицательные, >50) → откат на 1', async () => {
  const [result] = await matchFoodItems([{ name: 'рис', amount: 'много', query: 'rice' }], {
    searchFoods: async () => [food('c1', 'Rice')],
    getServings: async () => [serving('sc1', 50)],
    chooseFood: async () => ({ foodId: 'c1', servingId: 'sc1', units: 9000, grams: null }),
  });
  assert.equal(result.units, 1);
  assert.equal(result.calories, 50);
});

const { matchFoodByBarcode, mealByMoscowTime } = await import('./food.js');

test('mealByMoscowTime: границы завтрак/обед/ужин/перекус по Москве', () => {
  // 07:30 UTC = 10:30 МСК — ещё завтрак; 08:00 UTC = 11:00 МСК — уже обед.
  assert.equal(mealByMoscowTime(new Date('2026-08-26T07:30:00.000Z')), 'breakfast');
  assert.equal(mealByMoscowTime(new Date('2026-08-26T08:00:00.000Z')), 'lunch');
  assert.equal(mealByMoscowTime(new Date('2026-08-26T13:00:00.000Z')), 'dinner');
  // 19:30 UTC = 22:30 МСК — перекус; 21:30 UTC = 00:30 МСК — тоже.
  assert.equal(mealByMoscowTime(new Date('2026-08-26T19:30:00.000Z')), 'other');
  assert.equal(mealByMoscowTime(new Date('2026-08-26T21:30:00.000Z')), 'other');
});

test('matchFoodByBarcode: продукт из базы FatSecret, порция из подписи через модель', async () => {
  const outcome = await matchFoodByBarcode('4606605030281', 'всю банку 320 г', {
    findFoodId: async (barcode) => (barcode === '4606605030281' ? '777' : null),
    getFood: async () => ({
      food: { foodId: '777', name: 'Cottage Cheese Grains', brand: 'Savushkin', description: '' },
      servings: [serving('s100', 110)],
    }),
    chooseFood: async (item) => {
      assert.equal(item.amount, 'всю банку 320 г');
      return { foodId: '777', servingId: 's100', units: 3.2, grams: 320 };
    },
  });
  assert.equal(outcome.kind, 'fatsecret');
  if (outcome.kind !== 'fatsecret') return;
  assert.equal(outcome.match.food?.foodId, '777');
  assert.equal(outcome.match.name, 'Savushkin Cottage Cheese Grains');
  assert.equal(outcome.match.units, 3.2);
  assert.equal(outcome.match.calories, 110 * 3.2);
});

test('matchFoodByBarcode: нет в FatSecret → Open Food Facts → аналог по английскому имени, ккал с этикетки', async () => {
  const outcome = await matchFoodByBarcode('4606605030281', undefined, {
    findFoodId: async () => null,
    lookupOff: async () => ({
      name: 'Творожное зерно в сливках 5%',
      brand: 'Савушкин',
      queryEn: 'творожное зерно в сливках',
      quantityGrams: 320,
      kcalPer100g: 143,
      proteinPer100g: 9,
      fatPer100g: 5,
      carbsPer100g: 2.6,
    }),
    // Русское имя с этикетки → перевод для поиска (у российских карточек
    // Open Food Facts английского имени обычно нет).
    translate: async (name) => {
      assert.equal(name, 'творожное зерно в сливках');
      return 'cottage cheese';
    },
    searchFoods: async (query) => {
      assert.equal(query, 'cottage cheese');
      return [food('900', 'Cottage Cheese')];
    },
    getServings: async () => [serving('s900', 98)],
    chooseFood: async (item) => {
      assert.equal(item.amount, 'упаковка 320 г');
      // Подсказка по этикетке доезжает до подбора — по ней модель выбирает
      // кандидата по составу, а не по названию.
      assert.equal(item.labelHint, 'Этикетка (на 100 г): 143 ккал, белки 9 г, жиры 5 г, углеводы 2.6 г.');
      return { foodId: '900', servingId: 's900', units: 3.2, grams: 320 };
    },
  });
  assert.equal(outcome.kind, 'openfoodfacts');
  if (outcome.kind !== 'openfoodfacts') return;
  assert.equal(outcome.product.name, 'Творожное зерно в сливках 5%');
  assert.equal(outcome.match.food?.foodId, '900');
  assert.equal(outcome.match.labelKcalPer100g, 143);
  assert.equal(outcome.match.calories, 98 * 3.2);
});

test('matchFoodByBarcode: нет ни в одной базе → not_found, модель не вызывается', async () => {
  let chooseCalled = false;
  const outcome = await matchFoodByBarcode('5901234123457', undefined, {
    findFoodId: async () => null,
    lookupOff: async () => null,
    chooseFood: async () => {
      chooseCalled = true;
      return { foodId: 'x', servingId: 'y', units: 1, grams: null };
    },
  });
  assert.deepEqual(outcome, { kind: 'not_found' });
  assert.equal(chooseCalled, false);
});

test('matchFoodByBarcode: ошибки API (нет прав Premier, сеть) → not_found с причиной, а не исключение', async () => {
  const outcome = await matchFoodByBarcode('5901234123457', undefined, {
    findFoodId: async () => {
      throw new Error('FatSecret food.find_id_for_barcode: 14 Missing scope');
    },
    lookupOff: async () => {
      throw new Error('Open Food Facts: HTTP 503');
    },
  });
  assert.equal(outcome.kind, 'not_found');
  assert.match(outcome.fatsecretNote ?? '', /Premier/);
});

test('matchFoodByBarcode: регион из префикса штрихкода → домашний RU → база по умолчанию', async () => {
  const calls: (FsRegion | undefined)[] = [];
  const outcome = await matchFoodByBarcode('5901234123457', undefined, {
    findFoodId: async (_barcode, region) => {
      calls.push(region);
      return null;
    },
    lookupOff: async () => null,
  });
  assert.deepEqual(calls, [{ region: 'PL' }, { region: 'RU', language: 'ru' }, undefined]);
  assert.deepEqual(outcome, { kind: 'not_found' });
});

test('matchFoodByBarcode: российский код — RU один раз, нашли — дальше не ищем', async () => {
  const calls: (FsRegion | undefined)[] = [];
  const outcome = await matchFoodByBarcode('4600605030288', undefined, {
    findFoodId: async (_barcode, region) => {
      calls.push(region);
      return '55';
    },
    getFood: async () => ({
      food: { foodId: '55', name: 'Творожное зерно в сливках', brand: 'Простоквашино', description: '' },
      servings: [serving('s55', 91)],
    }),
    chooseFood: async () => ({ foodId: '55', servingId: 's55', units: 1, grams: null }),
  });
  assert.deepEqual(calls, [{ region: 'RU', language: 'ru' }]);
  assert.equal(outcome.kind, 'fatsecret');
});

test('matchFoodByBarcode: отказ по скоупу локализации — сразу база по умолчанию, регионы дальше не перебираем', async () => {
  const calls: (string | undefined)[] = [];
  const outcome = await matchFoodByBarcode('5901234123457', undefined, {
    findFoodId: async (_barcode, region) => {
      calls.push(region?.region);
      if (region) throw new Error("FatSecret food.find_id_for_barcode: 14 Missing scope: scope 'localization'");
      return null;
    },
    lookupOff: async () => null,
  });
  assert.deepEqual(calls, ['PL', undefined]);
  assert.deepEqual(outcome, { kind: 'not_found' });
});

test('matchFoodByBarcode: регион не поддерживается FatSecret → следующий по списку', async () => {
  const calls: (string | undefined)[] = [];
  const outcome = await matchFoodByBarcode('5901234123457', undefined, {
    findFoodId: async (_barcode, region) => {
      calls.push(region?.region);
      if (region?.region === 'PL') throw new Error('FatSecret food.find_id_for_barcode: 21 Invalid region');
      return region?.region === 'RU' ? '77' : null;
    },
    getFood: async () => ({
      food: { foodId: '77', name: 'Pierogi', brand: null, description: '' },
      servings: [serving('s77', 200)],
    }),
    chooseFood: async () => ({ foodId: '77', servingId: 's77', units: 1, grams: null }),
  });
  assert.deepEqual(calls, ['PL', 'RU']);
  assert.equal(outcome.kind, 'fatsecret');
});

test('matchFoodByBarcode: нет прав на barcode-API → причина в fatsecretNote, Open Food Facts всё равно спрашивается', async () => {
  const outcome = await matchFoodByBarcode('5901234123457', undefined, {
    findFoodId: async () => {
      throw new Error("FatSecret food.find_id_for_barcode: 14 Missing scope: scope 'barcode'");
    },
    lookupOff: async () => ({
      name: 'Йогурт',
      brand: null,
      queryEn: 'yogurt',
      quantityGrams: null,
      kcalPer100g: null,
      proteinPer100g: null,
      fatPer100g: null,
      carbsPer100g: null,
    }),
    searchFoods: async () => [food('y1', 'Yogurt')],
    getServings: async () => [serving('sy', 60)],
    chooseFood: async () => ({ foodId: 'y1', servingId: 'sy', units: 1, grams: null }),
  });
  assert.equal(outcome.kind, 'openfoodfacts');
  if (outcome.kind !== 'openfoodfacts') return;
  assert.match(outcome.fatsecretNote ?? '', /Premier/);
  assert.equal(outcome.match.food?.foodId, 'y1');
});
