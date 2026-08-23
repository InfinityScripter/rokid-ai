import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { log } from './log.js';

// Весь HTTP к FatSecret. Поиск — OAuth 2.0 (client credentials, IP-whitelist),
// дневник пользователя — OAuth 1.0 (HMAC-SHA1): у FatSecret это два разных
// поколения авторизации, современного пути к дневнику нет.

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauth1BaseString(method: string, url: string, params: Record<string, string>): string {
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key])}`)
    .join('&');
  return `${method.toUpperCase()}&${rfc3986(url)}&${rfc3986(paramString)}`;
}

export function oauth1Params(opts: {
  url: string;
  params: Record<string, string>;
  token?: string;
  tokenSecret?: string;
  method?: string;
}): Record<string, string> {
  const all: Record<string, string> = {
    ...opts.params,
    oauth_consumer_key: config.FATSECRET_CONSUMER_KEY,
    oauth_nonce: randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(opts.token ? { oauth_token: opts.token } : {}),
  };
  const key = `${rfc3986(config.FATSECRET_CONSUMER_SECRET)}&${rfc3986(opts.tokenSecret ?? '')}`;
  const signature = createHmac('sha1', key)
    .update(oauth1BaseString(opts.method ?? 'POST', opts.url, all))
    .digest('base64');
  return { ...all, oauth_signature: signature };
}

// 3-legged OAuth 1.0 (PIN/oob-флоу) — привязка личного дневника пользователя.
// https://platform.fatsecret.com/docs/guides/authentication/oauth1/three-legged
const OAUTH1_REQUEST_TOKEN_URL = 'https://authentication.fatsecret.com/oauth/request_token';
const OAUTH1_AUTHORIZE_URL = 'https://authentication.fatsecret.com/oauth/authorize';
const OAUTH1_ACCESS_TOKEN_URL = 'https://authentication.fatsecret.com/oauth/access_token';

type UserToken = { token: string; secret: string };

function fatsecretTokenPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.fatsecret.json');
}

function loadUserToken(): UserToken | null {
  try {
    return JSON.parse(readFileSync(fatsecretTokenPath(), 'utf8')) as UserToken;
  } catch {
    return null;
  }
}

function saveUserToken(token: UserToken): void {
  const filePath = fatsecretTokenPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(token, null, 2));
}

// Незавершённая привязка (между /fatsecret_link и /fatsecret_pin) живёт в
// памяти процесса — как undoable/pendingWork в bot.ts.
let pendingRequestToken: UserToken | null = null;

async function oauth1Post(url: string, params: Record<string, string>): Promise<URLSearchParams> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FatSecret OAuth1 ${url}: HTTP ${res.status}`);
  return new URLSearchParams(text);
}

// Доки подтверждают GET для access_token — параметры (включая подпись) идут
// в query string, тела нет.
async function oauth1Get(url: string, params: Record<string, string>): Promise<URLSearchParams> {
  const res = await fetch(`${url}?${new URLSearchParams(params).toString()}`, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) throw new Error(`FatSecret OAuth1 ${url}: HTTP ${res.status}`);
  return new URLSearchParams(text);
}

export async function fsStartLink(): Promise<{ authorizeUrl: string }> {
  const signed = oauth1Params({
    url: OAUTH1_REQUEST_TOKEN_URL,
    params: { oauth_callback: 'oob' },
  });
  const body = await oauth1Post(OAUTH1_REQUEST_TOKEN_URL, signed);
  const token = body.get('oauth_token');
  const secret = body.get('oauth_token_secret');
  if (!token || !secret) throw new Error('FatSecret request_token: пустой или неполный ответ');
  pendingRequestToken = { token, secret };
  return { authorizeUrl: `${OAUTH1_AUTHORIZE_URL}?oauth_token=${rfc3986(token)}` };
}

export async function fsFinishLink(pin: string): Promise<void> {
  if (!pendingRequestToken) {
    throw new Error('Сначала запроси ссылку командой /fatsecret_link — код без неё не привязать');
  }
  const signed = oauth1Params({
    url: OAUTH1_ACCESS_TOKEN_URL,
    params: { oauth_verifier: pin },
    token: pendingRequestToken.token,
    tokenSecret: pendingRequestToken.secret,
    method: 'GET',
  });
  const body = await oauth1Get(OAUTH1_ACCESS_TOKEN_URL, signed);
  const token = body.get('oauth_token');
  const secret = body.get('oauth_token_secret');
  if (!token || !secret) throw new Error('FatSecret access_token: пустой или неполный ответ');
  saveUserToken({ token, secret });
  pendingRequestToken = null;
}

export function fsLinked(): boolean {
  return loadUserToken() !== null;
}

export async function fsUserRequest(params: Record<string, string>): Promise<unknown> {
  const userToken = loadUserToken();
  if (!userToken) throw new Error('Аккаунт FatSecret не привязан — сначала /fatsecret_link');
  const signed = oauth1Params({
    url: 'https://platform.fatsecret.com/rest/server.api',
    params: { ...params, format: 'json' },
    token: userToken.token,
    tokenSecret: userToken.secret,
  });
  const res = await fetch('https://platform.fatsecret.com/rest/server.api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(signed).toString(),
  });
  if (!res.ok) throw new Error(`FatSecret ${params.method}: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { error?: { code: number; message: string } };
  if (data.error) throw new Error(`FatSecret ${params.method}: ${data.error.code} ${data.error.message}`);
  return data;
}

let oauth2Token: { value: string; expiresAt: number } | null = null;

async function getOauth2Token(): Promise<string> {
  if (oauth2Token && Date.now() < oauth2Token.expiresAt - 60_000) return oauth2Token.value;
  const basic = Buffer.from(`${config.FATSECRET_CLIENT_ID}:${config.FATSECRET_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=basic',
  });
  if (!res.ok) throw new Error(`FatSecret не выдал токен: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  oauth2Token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

function parseFsResponse(method: string, res: Response): Promise<unknown> {
  return res.text().then((text) => {
    if (!res.ok) throw new Error(`FatSecret ${method}: HTTP ${res.status}`);
    const data = JSON.parse(text) as { error?: { code: number; message: string } };
    if (data.error) throw new Error(`FatSecret ${method}: ${data.error.code} ${data.error.message}`);
    return data;
  });
}

async function fsApi(params: Record<string, string>): Promise<unknown> {
  try {
    const token = await getOauth2Token();
    const res = await fetch('https://platform.fatsecret.com/rest/server.api', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, format: 'json' }).toString(),
    });
    return await parseFsResponse(params.method, res);
  } catch (error) {
    // Белый список IP действует только на OAuth 2.0 и применяется до 24 часов
    // после правки — при ошибке 21 «Invalid IP» повторяем запрос с подписью
    // OAuth 1.0 (consumer-ключи, без токена пользователя), у него списка нет.
    if (!String(error).includes('Invalid IP')) throw error;
    log('fatsecret: OAuth2 отбит по IP, повторяю с подписью OAuth1');
    const signed = oauth1Params({
      url: 'https://platform.fatsecret.com/rest/server.api',
      params: { ...params, format: 'json' },
    });
    const res = await fetch('https://platform.fatsecret.com/rest/server.api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(signed).toString(),
    });
    return await parseFsResponse(params.method, res);
  }
}

export type FsFood = { foodId: string; name: string; brand: string | null; description: string };

export type FsServing = {
  servingId: string;
  description: string;
  grams: number | null;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
};

// Одиночный результат FatSecret отдаёт объектом, а не массивом из одного
// элемента — это касается и foods.food, и servings.serving.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type RawSearchFood = { food_id: string; food_name: string; brand_name?: string; food_description: string };

export async function fsSearchFoods(query: string, max = 10): Promise<FsFood[]> {
  const data = (await fsApi({
    method: 'foods.search',
    search_expression: query,
    max_results: String(max),
  })) as { foods?: { food?: RawSearchFood | RawSearchFood[] } };
  return asArray(data.foods?.food).map((f) => ({
    foodId: f.food_id,
    name: f.food_name,
    brand: f.brand_name ?? null,
    description: f.food_description,
  }));
}

type RawServing = {
  serving_id: string;
  serving_description: string;
  metric_serving_amount?: string;
  calories: string;
  protein: string;
  fat: string;
  carbohydrate: string;
};

export async function fsGetServings(foodId: string): Promise<FsServing[]> {
  const data = (await fsApi({ method: 'food.get', food_id: foodId })) as {
    food?: { servings?: { serving?: RawServing | RawServing[] } };
  };
  return asArray(data.food?.servings?.serving).map((s) => ({
    servingId: s.serving_id,
    description: s.serving_description,
    grams: s.metric_serving_amount ? Number(s.metric_serving_amount) : null,
    calories: Number(s.calories),
    protein: Number(s.protein),
    fat: Number(s.fat),
    carbs: Number(s.carbohydrate),
  }));
}

// Дневник FatSecret — по московскому дню, не по UTC: ужин в 00:30 МСК должен
// попасть в сегодняшний день, а не во вчерашний (UTC в это время суток ещё
// накануне). en-CA даёт готовый Y-M-D, из которого строим UTC-полночь этого
// дня и делим на сутки — так же, как этого требует формат FatSecret.
export function mskDayNumber(date: Date): number {
  const [year, month, day] = date.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export type CreateFoodEntryInput = {
  foodId: string;
  name: string;
  servingId: string;
  units: number;
  meal: string;
  date: Date;
};

type RawFoodEntryId = { value: string } | string;

// Параметры и формат сверены по докам: https://platform.fatsecret.com/docs/v1/food_entry.create
// (food_id, food_entry_name, serving_id, number_of_units, meal, date — целое
// число дней с 1970-01-01 UTC). Пишет в личный дневник, поэтому идёт через
// fsUserRequest (OAuth 1.0, 3-legged), а не через fsApi (OAuth 2.0).
export async function fsCreateFoodEntry(entry: CreateFoodEntryInput): Promise<string> {
  const data = (await fsUserRequest({
    method: 'food_entry.create',
    food_id: entry.foodId,
    food_entry_name: entry.name,
    serving_id: entry.servingId,
    number_of_units: String(entry.units),
    meal: entry.meal,
    date: String(mskDayNumber(entry.date)),
  })) as { food_entry_id?: RawFoodEntryId };
  const id = typeof data.food_entry_id === 'string' ? data.food_entry_id : data.food_entry_id?.value;
  if (!id) throw new Error('FatSecret food_entry.create: ответ без food_entry_id');
  return id;
}

// Для тестовых записей (Step 5 брифа) — убрать то, что записалось до
// одобрения Premier. Доки: https://platform.fatsecret.com/docs/v1/food_entry.delete
export async function fsDeleteFoodEntry(foodEntryId: string): Promise<void> {
  await fsUserRequest({ method: 'food_entry.delete', food_entry_id: foodEntryId });
}

// FatSecret код 9 (OAuth 1.0) — "Invalid access token": токен пользователя
// невалиден или истёк, чинится только через повторную привязку /fatsecret_link.
// Отдельного кода на «Premier ещё не одобрен» доки не дают (проверено по
// https://platform.fatsecret.com/docs/guides/error-codes) — поэтому это
// единственная распознаваемая по коду ошибка, а всё остальное в food_entry.create
// трактуем как проблему прав/буферизации. Это эвристика, не гарантия.
export function isInvalidTokenError(error: unknown): boolean {
  return error instanceof Error && /FatSecret \S+: 9 /.test(error.message);
}
