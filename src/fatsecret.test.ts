import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import './test-env.js';

// SQLITE_PATH задаём во временную папку ДО импорта config.js — иначе тест
// привязки читал бы и удалял боевой файл токена пользователя. Статические
// импорты хойстятся, поэтому используем динамический import() уже после
// того, как переменная окружения выставлена.
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-fatsecret-test-')), 'test.sqlite');

const { config } = await import('./config.js');
const {
  diaryDate,
  fsFindFoodIdForBarcode,
  fsFinishLink,
  fsGetFood,
  fsLinked,
  fsStartLink,
  fsUserRequest,
  isPermissionError,
  mskDayNumber,
  oauth1BaseString,
  shiftDate,
} = await import('./fatsecret.js');

test('oauth1BaseString: сортировка, RFC3986-кодирование, кириллица', () => {
  const base = oauth1BaseString('POST', 'https://platform.fatsecret.com/rest/server.api', {
    z: 'два',
    a: '1',
    oauth_consumer_key: 'ck',
    oauth_nonce: 'n',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '100',
    oauth_token: 'tk',
    oauth_version: '1.0',
  });
  assert.equal(
    base,
    'POST&https%3A%2F%2Fplatform.fatsecret.com%2Frest%2Fserver.api&' +
      'a%3D1%26oauth_consumer_key%3Dck%26oauth_nonce%3Dn%26oauth_signature_method%3DHMAC-SHA1' +
      '%26oauth_timestamp%3D100%26oauth_token%3Dtk%26oauth_version%3D1.0%26z%3D%25D0%25B4%25D0%25B2%25D0%25B0',
  );
});

test('mskDayNumber: 00:30 МСК (21:30 UTC накануне) попадает в сегодняшний московский день', () => {
  // 22 августа 00:30 МСК = 21 августа 21:30 UTC.
  const day = mskDayNumber(new Date('2026-08-21T21:30:00.000Z'));
  assert.equal(day, Date.UTC(2026, 7, 22) / 86_400_000);
});

test('mskDayNumber: 23:30 МСК того же UTC-дня — тот же московский день', () => {
  const day = mskDayNumber(new Date('2026-08-22T20:30:00.000Z'));
  assert.equal(day, Date.UTC(2026, 7, 22) / 86_400_000);
});

test('fsStartLink → fsFinishLink → fsLinked → fsUserRequest: полный флоу привязки', async (t) => {
  const tokenPath = config.SQLITE_PATH.replace(/\.sqlite$/, '.fatsecret.json');
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: string }[] = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(tokenPath, { force: true });
    rmSync(path.dirname(config.SQLITE_PATH), { recursive: true, force: true });
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = url.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url: href, method, body: String(init?.body ?? '') });
    if (href === 'https://authentication.fatsecret.com/oauth/request_token') {
      return new Response('oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true');
    }
    if (href.startsWith('https://authentication.fatsecret.com/oauth/access_token')) {
      return new Response('oauth_token=acc-token&oauth_token_secret=acc-secret');
    }
    if (href === 'https://platform.fatsecret.com/rest/server.api') {
      return new Response(JSON.stringify({ profile: { user_id: '1' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`неожиданный fetch: ${href}`);
  }) as typeof fetch;

  assert.equal(fsLinked(), false);

  const { authorizeUrl } = await fsStartLink();
  assert.equal(authorizeUrl, 'https://authentication.fatsecret.com/oauth/authorize?oauth_token=req-token');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body, /oauth_callback=oob/);

  await fsFinishLink('123456');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, '');
  assert.match(calls[1].url, /^https:\/\/authentication\.fatsecret\.com\/oauth\/access_token\?/);
  assert.match(calls[1].url, /oauth_verifier=123456/);
  assert.match(calls[1].url, /oauth_token=req-token/);

  assert.equal(fsLinked(), true);

  const profile = await fsUserRequest({ method: 'profile.get' });
  assert.deepEqual(profile, { profile: { user_id: '1' } });
  assert.equal(calls[2].method, 'POST');
  assert.match(calls[2].body, /oauth_token=acc-token/);
});

test('fsFindFoodIdForBarcode: region/language уходят в запрос, «0» → null, id → строка', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bodies: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = url.toString();
    if (href === 'https://oauth.fatsecret.com/connect/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = String(init?.body ?? '');
    bodies.push(body);
    const value = body.includes('region=RU') ? '4384' : '0';
    return new Response(JSON.stringify({ food_id: { value } }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.equal(await fsFindFoodIdForBarcode('5901234123457', { region: 'RU', language: 'ru' }), '4384');
  assert.match(bodies[0], /method=food.find_id_for_barcode/);
  assert.match(bodies[0], /barcode=5901234123457/);
  assert.match(bodies[0], /region=RU/);
  assert.match(bodies[0], /language=ru/);
  assert.equal(await fsFindFoodIdForBarcode('5901234123457'), null);
  assert.doesNotMatch(bodies[1], /region=/);
});

test('isPermissionError: код 14 / Missing scope / premier — да, «не нашла» и сеть — нет', () => {
  assert.equal(isPermissionError(new Error("FatSecret food.find_id_for_barcode: 14 Missing scope: scope 'barcode'")), true);
  assert.equal(isPermissionError(new Error('FatSecret x: 2 This feature requires a premier subscription')), true);
  assert.equal(isPermissionError(new Error('FatSecret x: HTTP 503')), false);
  assert.equal(isPermissionError(new Error('fetch failed')), false);
});

test('diaryDate: до 04:00 МСК — ещё вчера, с 04:00 — сегодня; shiftDate через границу месяца', () => {
  // 00:30 МСК 5 сентября = 21:30 UTC 4 сентября → дневниковый день 4 сентября.
  assert.equal(diaryDate(new Date('2026-09-04T21:30:00.000Z')), '2026-09-04');
  // 03:59 МСК — всё ещё 4-е, 04:00 — уже 5-е.
  assert.equal(diaryDate(new Date('2026-09-05T00:59:00.000Z')), '2026-09-04');
  assert.equal(diaryDate(new Date('2026-09-05T01:00:00.000Z')), '2026-09-05');
  assert.equal(shiftDate('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
});

test('fsGetFood: unitsPerServing из number_of_units порции («100 g» → 100), без поля → 1', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (url.toString() === 'https://oauth.fatsecret.com/connect/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        food: {
          food_id: '1',
          food_name: 'Ground Beef',
          servings: {
            serving: [
              { serving_id: 'g', serving_description: '100 g', metric_serving_amount: '100.000', number_of_units: '100.000', calories: '276', protein: '26', fat: '18', carbohydrate: '0' },
              { serving_id: 'c', serving_description: '1 cup', calories: '400', protein: '30', fat: '20', carbohydrate: '0' },
            ],
          },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const { servings } = await fsGetFood('1');
  assert.equal(servings[0].unitsPerServing, 100);
  assert.equal(servings[0].grams, 100);
  assert.equal(servings[1].unitsPerServing, 1);
});
