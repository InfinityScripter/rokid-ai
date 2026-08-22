import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';

import { config } from './config.js';
import { fsFinishLink, fsLinked, fsStartLink, fsUserRequest, oauth1BaseString } from './fatsecret.js';

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

test('fsStartLink → fsFinishLink → fsLinked → fsUserRequest: полный флоу привязки', async (t) => {
  const tokenPath = config.SQLITE_PATH.replace(/\.sqlite$/, '.fatsecret.json');
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: string }[] = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(tokenPath, { force: true });
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = url.toString();
    calls.push({ url: href, body: String(init?.body ?? '') });
    if (href === 'https://authentication.fatsecret.com/oauth/request_token') {
      return new Response('oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true');
    }
    if (href === 'https://authentication.fatsecret.com/oauth/access_token') {
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
  assert.match(calls[0].body, /oauth_callback=oob/);

  await fsFinishLink('123456');
  assert.match(calls[1].body, /oauth_verifier=123456/);
  assert.match(calls[1].body, /oauth_token=req-token/);

  assert.equal(fsLinked(), true);

  const profile = await fsUserRequest({ method: 'profile.get' });
  assert.deepEqual(profile, { profile: { user_id: '1' } });
  assert.match(calls[2].body, /oauth_token=acc-token/);
});
