import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FsFood, FsServing } from './fatsecret.js';
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
