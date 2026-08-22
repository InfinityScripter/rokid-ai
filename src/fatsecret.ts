import { createHmac, randomUUID } from 'node:crypto';

import { config } from './config.js';

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
  const signature = createHmac('sha1', key).update(oauth1BaseString('POST', opts.url, all)).digest('base64');
  return { ...all, oauth_signature: signature };
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

async function fsApi(params: Record<string, string>): Promise<unknown> {
  const token = await getOauth2Token();
  const res = await fetch('https://platform.fatsecret.com/rest/server.api', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, format: 'json' }).toString(),
  });
  if (!res.ok) throw new Error(`FatSecret ${params.method}: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { error?: { code: number; message: string } };
  if (data.error) throw new Error(`FatSecret ${params.method}: ${data.error.code} ${data.error.message}`);
  return data;
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
