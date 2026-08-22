import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatFoodCard } from './format.js';
import type { FoodMatch } from './food.js';

test('formatFoodCard: найденная позиция, не найденная позиция, сумма ккал и подпись fatsecret', () => {
  const matches: FoodMatch[] = [
    {
      name: 'куриная грудка',
      amount: '150 г',
      food: { foodId: '1', foodName: 'Chicken Breast' },
      servingId: '10',
      units: 1.5,
      grams: 150,
      calories: 250,
      note: null,
    },
    {
      name: 'неведомая ягода',
      amount: '1 шт',
      food: null,
      servingId: null,
      units: 0,
      grams: null,
      calories: null,
      note: 'не нашла продукт в FatSecret',
    },
  ];

  const card = formatFoodCard('lunch', matches);
  const lines = card.split('\n');

  assert.match(lines[0], /^🍽 обед:$/);
  assert.match(lines[1], /куриная грудка \(150 г\) → Chicken Breast, 150 г — 250 ккал/);
  assert.match(lines[2], /неведомая ягода \(1 шт\) — не нашла продукт в FatSecret/);
  assert.equal(lines[3], 'Итого: 250 ккал');
  assert.equal(lines.at(-1), 'powered by fatsecret');
});
