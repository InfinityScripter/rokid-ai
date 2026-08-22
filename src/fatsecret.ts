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
