# Еда → дневник FatSecret — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** фото/голос с очков → карточка подтверждения в Telegram → запись приёма пищи в дневник FatSecret пользователя.

**Architecture:** новый модуль `src/fatsecret.ts` (весь HTTP к FatSecret: OAuth 2.0 для поиска, OAuth 1.0 для дневника), `src/food.ts` (подбор продуктов и порций через LLM), расширение `src/bot.ts` (карточка с кнопками, команды привязки) и `src/router.ts` (английские названия продуктов в интенте). Буфер отправки до одобрения Premier Free — JSON-файл по образцу `src/queue.ts`.

**Tech Stack:** TypeScript + tsx (Node ≥20), grammY, zod, node:crypto (HMAC-SHA1 для OAuth 1.0 — без новых зависимостей), тесты — встроенный `node:test` через `node --import tsx --test`.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-23-food-fatsecret-design.md`.
- Дневник — ТОЛЬКО FatSecret; локальный буфер — очередь отправки, не хранилище с читалкой.
- Запись в дневник — только после кнопки «✅ Записать» (выбор пользователя).
- В карточке и итоговых сообщениях — подпись «powered by fatsecret» (условие Premier Free).
- Никаких новых npm-зависимостей: OAuth 1.0 подписываем сами через node:crypto.
- Все тексты пользователю — по-русски; поисковые запросы к базе — по-английски (база американская).
- Секреты — в `~/.config/rokid-ai/.env`; токены пользователя FatSecret — файл рядом с очередью (`SQLITE_PATH` с заменой расширения), в git не попадает (data/ вне репо).
- Комментарии в коде — только там, где есть неочевидное ограничение (стиль репо).
- Деплой проверки на VDS — только через `./deploy/bot.sh`.
- Пуш в GitHub — только по явной команде пользователя.

## Известные факты про FatSecret API (проверять по докам в шагах)

- Поиск: `POST https://platform.fatsecret.com/rest/server.api` c `method=foods.search`, OAuth 2.0 Bearer. Токен: `POST https://oauth.fatsecret.com/connect/token` (Basic `CLIENT_ID:CLIENT_SECRET`, `grant_type=client_credentials&scope=basic`). IP VDS уже в белом списке.
- Дневник: `method=food_entry.create` / `food_entry.delete`, подпись OAuth 1.0 (HMAC-SHA1) с токеном пользователя. Дата у FatSecret — **число дней с 1970-01-01 (UTC)**, не ISO.
- Привязка пользователя (3-legged OAuth 1.0, oob): request_token → пользователь открывает authorize-URL → PIN → access_token. Точные URL сверить в доках: https://platform.fatsecret.com/docs/guides/authentication/oauth1 (шаг в Task 3 обязателен — URL менялись между поколениями доков).
- Premier Free ещё не одобрен: `food_entry.create` до одобрения вернёт ошибку прав — это ожидаемо, пишем в буфер.

---

### Task 1: OAuth 1.0 подпись и каркас fatsecret.ts

**Files:**
- Create: `src/fatsecret.ts`
- Create: `src/fatsecret.test.ts`
- Modify: `src/config.ts` (4 новых ключа)
- Modify: `package.json` (скрипт `test`)

**Interfaces:**
- Produces: `oauth1BaseString(method: string, url: string, params: Record<string, string>): string`; `oauth1Params(opts: { url: string; params: Record<string, string>; token?: string; tokenSecret?: string }): Record<string, string>` — итоговые параметры запроса с `oauth_signature`. Использует `config.FATSECRET_CONSUMER_KEY/SECRET`.

- [ ] **Step 1: конфиг.** В `src/config.ts` в `envSchema` добавить:

```ts
  FATSECRET_CLIENT_ID: z.string().default(''),
  FATSECRET_CLIENT_SECRET: z.string().default(''),
  FATSECRET_CONSUMER_KEY: z.string().default(''),
  FATSECRET_CONSUMER_SECRET: z.string().default(''),
```

Дефолты пустые: бот без ключей стартует, конвейер еды честно скажет «не настроено» (как APPLE_APP_PASSWORD).

- [ ] **Step 2: скрипт тестов.** В `package.json` в `scripts`:

```json
"test": "node --import tsx --test src/*.test.ts"
```

- [ ] **Step 3: падающий тест** — `src/fatsecret.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oauth1BaseString } from './fatsecret.js';

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
```

- [ ] **Step 4: убедиться, что тест падает.** Run: `npm test` → FAIL (`oauth1BaseString` не существует).

- [ ] **Step 5: реализация** — начало `src/fatsecret.ts`:

```ts
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
```

- [ ] **Step 6: тест зелёный.** Run: `npm test` → PASS. Run: `npm run ts` → без ошибок.

- [ ] **Step 7: Commit.** `git add -f src/fatsecret.ts src/fatsecret.test.ts src/config.ts package.json && git commit -m "food: каркас fatsecret.ts — OAuth 1.0 подпись, ключи в конфиге, node:test"`

---

### Task 2: поиск продуктов (OAuth 2.0)

**Files:**
- Modify: `src/fatsecret.ts`

**Interfaces:**
- Produces: `fsSearchFoods(query: string, max?: number): Promise<FsFood[]>` где `FsFood = { foodId: string; name: string; brand: string | null; description: string }` (description — строка FatSecret вида «Per 100g - Calories: 43kcal | Fat: 0.10g…»); `fsGetServings(foodId: string): Promise<FsServing[]>` где `FsServing = { servingId: string; description: string; grams: number | null; calories: number; protein: number; fat: number; carbs: number }`.

- [ ] **Step 1: сверить контракты с доками.** WebFetch: https://platform.fatsecret.com/docs/v3/foods.search и https://platform.fatsecret.com/docs/v4/food.get — проверить имена методов (`foods.search` v3 передаётся как `method=foods.search&…` на server.api или отдельным REST-путём), формат ответа, поля сервингов (`serving_id`, `metric_serving_amount`, `metric_serving_unit`, `calories`, `protein`, `fat`, `carbohydrate`). Код ниже писать по фактическим докам, структура функций — как в Interfaces.

- [ ] **Step 2: реализация в `src/fatsecret.ts`** (добавить):

```ts
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
```

`fsSearchFoods` и `fsGetServings` — тонкие обёртки над `fsApi` с разбором фактических полей ответа (по докам из Step 1), сигнатуры из Interfaces. Числа парсить через `Number()`, отсутствующую грамматуру (`metric_serving_amount`) отдавать `grams: null`.

- [ ] **Step 3: живой прогон.** Скрипт в корне проекта `search-check.tmp.ts` (по образцу проверок из сессии): `fsSearchFoods('borscht')` и `fsGetServings(<первый foodId>)`, вывод в консоль. Run: `npx tsx search-check.tmp.ts` — ожидаем список продуктов с КБЖУ. ВАЖНО: IP-whitelist привязан к VDS — если с Мака получим `403/IP`, прогонять на VDS: `scp` скрипта + `ssh … 'cd /opt/rokid-ai && npx tsx search-check.tmp.ts'`. Удалить скрипт после прогона.

- [ ] **Step 4: типы.** Run: `npm run ts` → чисто. `npm test` → PASS (старый тест не сломан).

- [ ] **Step 5: Commit.** `git add -f src/fatsecret.ts && git commit -m "food: поиск продуктов FatSecret — OAuth 2.0 токен, foods.search, food.get"`

---

### Task 3: привязка аккаунта пользователя (/fatsecret_link)

**Files:**
- Modify: `src/fatsecret.ts` (3-legged OAuth + хранение токенов)
- Modify: `src/bot.ts` (команды `/fatsecret_link`, `/fatsecret_pin`)

**Interfaces:**
- Produces: `fsStartLink(): Promise<{ authorizeUrl: string }>` (запоминает request-token в памяти модуля); `fsFinishLink(pin: string): Promise<void>` (обменивает PIN на access-токены и сохраняет их); `fsLinked(): boolean`; `fsUserRequest(params: Record<string, string>): Promise<unknown>` — POST к server.api с подписью OAuth 1.0 токенами пользователя (использует `oauth1Params` из Task 1).
- Хранение: JSON `{ token: string, secret: string }` в `config.SQLITE_PATH.replace(/\.sqlite$/, '.fatsecret.json')` (тот же приём, что `queuePath()` в `src/queue.ts:24`).

- [ ] **Step 1: сверить URL 3-legged флоу.** WebFetch: https://platform.fatsecret.com/docs/guides/authentication/oauth1 — точные адреса request_token / authorize / access_token и параметр `oauth_callback=oob`. Не писать URL по памяти.

- [ ] **Step 2: реализация** в `src/fatsecret.ts`: `fsStartLink` (POST request_token c `oauth_callback=oob` через `oauth1Params` без token; распарсить `oauth_token`/`oauth_token_secret` из form-encoded ответа; вернуть authorize-URL с этим token), `fsFinishLink` (POST access_token c `oauth_verifier=PIN`; сохранить файл), `fsLinked` (файл существует и читается), `fsUserRequest` (подпись с токенами из файла; парсинг `{ error }` как в `fsApi`).

- [ ] **Step 3: команды в `src/bot.ts`** (рядом с `bot.command('start', …)` — `src/bot.ts:183`):

```ts
bot.command('fatsecret_link', async (ctx) => {
  const { authorizeUrl } = await fsStartLink();
  await ctx.reply(
    `Открой ссылку, разреши доступ и пришли PIN командой /fatsecret_pin <код>:\n${authorizeUrl}`,
  );
});

bot.command('fatsecret_pin', async (ctx) => {
  const pin = (ctx.match ?? '').trim();
  if (!pin) {
    await ctx.reply('Нужен код: /fatsecret_pin 123456');
    return;
  }
  await fsFinishLink(pin);
  await ctx.reply('✅ Аккаунт FatSecret привязан — теперь могу писать в твой дневник.');
});
```

Обе команды обернуть в try/catch с `logError` и честным сообщением об ошибке (образец — `bot.callbackQuery(/^undo:…/`, `src/bot.ts:128`).

- [ ] **Step 4: живая проверка.** `npm run ts` чисто → задеплоить на VDS `./deploy/bot.sh` → пользователь проходит `/fatsecret_link` → `/fatsecret_pin` в Telegram. Проверка успеха: `fsUserRequest({ method: 'profile.get' })` через tmp-скрипт на VDS возвращает профиль без ошибки. (Этот шаг требует участия пользователя — попросить в чате.)

- [ ] **Step 5: Commit.** `git add -f src/fatsecret.ts src/bot.ts && git commit -m "food: привязка аккаунта FatSecret — 3-legged OAuth 1.0 с PIN, команды в боте"`

---

### Task 4: английские запросы в интенте + подбор продукта и порции

**Files:**
- Modify: `src/router.ts` (поле `query` у items)
- Create: `src/food.ts`

**Interfaces:**
- Consumes: `fsSearchFoods`, `fsGetServings` (Task 2).
- Produces: `matchFoodItems(items: { name: string; amount: string; query: string }[]): Promise<FoodMatch[]>` где `FoodMatch = { name: string; amount: string; food: { foodId: string; foodName: string } | null; servingId: string | null; units: number; grams: number | null; calories: number | null; note: string | null }` (`food: null` + `note` — «не нашла в базе»).

- [ ] **Step 1: роутер.** В `src/router.ts` у `food_log.items` (zod `src/router.ts:30` и tool-schema `src/router.ts:96`) добавить обязательное поле `query: z.string().describe('название продукта по-английски для поиска в базе')`; в промпт `routeText` и `parseFoodPhoto` добавить строку: «Для каждого продукта заполни query — короткое английское название для поиска в американской базе продуктов („борщ" → "borscht", „два тоста с сыром" → "toast with cheese")».

- [ ] **Step 2: `src/food.ts`.** Для каждого item: `fsSearchFoods(item.query, 5)`; пустой результат → `food: null, note: 'не нашла в базе'`. Иначе — `fsGetServings` первого кандидата и один structured-вызов LLM (клиент и паттерн tool-choice скопировать из `callRouter`, `src/router.ts:112`): вход — item + кандидаты + сервинги, выход — `{ foodId, servingId, units, grams }` (модель выбирает продукт из списка и переводит «тарелка», «2 тоста» в число сервингов). Калории считать из выбранного сервинга × units.

- [ ] **Step 3: живой прогон.** tmp-скрипт: `matchFoodItems([{ name: 'борщ', amount: 'тарелка', query: 'borscht' }, { name: 'тост с сыром', amount: '2 шт', query: 'toast with cheese' }])` → в консоли осмысленные совпадения с калориями. Прогонять там же, где работал Task 2 Step 3 (IP-whitelist).

- [ ] **Step 4:** `npm run ts` + `npm test` → чисто. Commit: `git add -f src/router.ts src/food.ts && git commit -m "food: английский query в интенте и подбор продукта+порции по базе FatSecret"`

---

### Task 5: карточка подтверждения в Telegram

**Files:**
- Modify: `src/format.ts` (formatFoodCard)
- Modify: `src/bot.ts` (pendingFood, кнопки, правка ответом)

**Interfaces:**
- Consumes: `matchFoodItems` (Task 4), `FoodMatch`.
- Produces: `formatFoodCard(meal: 'breakfast'|'lunch'|'dinner'|'other', matches: FoodMatch[]): string`; в боте — map `pendingFood: Map<string, { meal: string; matches: FoodMatch[] }>` и callback-и `food-yes:<key>` / `food-no:<key>` (образец жизненного цикла — `pendingWork`, `src/bot.ts:149-172`). Запись выполняет Task 6; в этом task кнопка «Записать» отвечает заглушкой `writeFoodEntries ещё не подключён` только если Task 6 ещё не смержен — задачи 5 и 6 коммитятся подряд, заглушка в прод не едет.

- [ ] **Step 1: formatFoodCard** в `src/format.ts`:

```ts
export function formatFoodCard(meal: 'breakfast' | 'lunch' | 'dinner' | 'other', matches: FoodMatch[]): string {
  const meals = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', other: 'перекус' };
  const lines = matches.map((m) =>
    m.food
      ? `• ${m.name} (${m.amount}) → ${m.food.foodName}${m.grams ? `, ${m.grams} г` : ''} — ${m.calories} ккал`
      : `• ${m.name} (${m.amount}) — ${m.note}`,
  );
  const total = matches.reduce((sum, m) => sum + (m.calories ?? 0), 0);
  return [`🍽 ${meals[meal]}:`, ...lines, `Итого: ${total} ккал`, 'powered by fatsecret'].join('\n');
}
```

(тип `FoodMatch` импортировать из `./food.js`; `formatIntent` для `food_log` больше не используется в применении — карточку строит бот).

- [ ] **Step 2: бот.** В `applyIntent` (`src/bot.ts:87`) ветка `food_log`: если `!fsLinked()` — ответить «сначала привяжи аккаунт: /fatsecret_link»; иначе `matchFoodItems(intent.items)` → карточка + клавиатура «✅ Записать» / «❌ Не надо» (`food-yes/food-no`), запись в `pendingFood`. Callback `food-no` — по образцу `work-no` (`src/bot.ts:168`). Правка v1: ответ «✏️ поправить» отдельной кнопкой не делаем — пользователь просто присылает новое голосовое/текст, старая карточка остаётся висеть и её можно отклонить; это осознанное упрощение (в спеке «Поправить» — пересборка, оставляем на после первой обкатки: меньше кода в первой выкатке).

- [ ] **Step 3: живой прогон.** `./deploy/bot.sh` → текст боту «съел борщ и два тоста» → карточка с аналогами, калориями, подписью powered by fatsecret; «❌ Не надо» убирает.

- [ ] **Step 4:** `npm run ts` + `npm test`. Commit: `git add -f src/format.ts src/bot.ts && git commit -m "food: карточка подтверждения еды с кнопками в Telegram"`

⚠️ Отступление от спеки, названное вслух: кнопка «✏️ Поправить» с пересборкой карточки отложена (см. Step 2) — в первой выкатке правка = продиктовать заново. Если пользователь не согласен — добавить callback `food-edit`, который помечает карточку ожидающей и пересобирает по следующему сообщению.

---

### Task 6: запись в дневник + буфер до Premier Free

**Files:**
- Create: `src/food-buffer.ts`
- Modify: `src/fatsecret.ts` (`fsCreateFoodEntry`, `fsDeleteFoodEntry`)
- Modify: `src/bot.ts` (callback `food-yes` → запись; флаш буфера)
- Create: `src/food-buffer.test.ts`

**Interfaces:**
- Consumes: `fsUserRequest` (Task 3), `FoodMatch` (Task 4), `pendingFood` (Task 5).
- Produces: `fsCreateFoodEntry(e: { foodId: string; name: string; servingId: string; units: number; meal: string; date: Date }): Promise<string>` (возвращает `food_entry_id`; параметр даты FatSecret — дни с 1970-01-01: `Math.floor(date.getTime() / 86_400_000)`); `bufferPush(entries: BufferedEntry[]): void`, `bufferFlush(): Promise<{ sent: number; left: number }>` — шлёт всё из буфера через `fsCreateFoodEntry`, при ошибке прав (Premier ещё не одобрен) останавливается и оставляет остаток.

- [ ] **Step 1: сверить `food_entry.create`.** WebFetch: https://platform.fatsecret.com/docs/v1/food_entry.create — имена параметров (`food_id`, `food_entry_name`, `serving_id`, `number_of_units`, `meal`, `date`) и формат ответа. Код по фактическим докам.

- [ ] **Step 2: тест буфера (чистая логика, без сети)** — `src/food-buffer.test.ts`: `bufferPush` двух записей → файл существует; мок отправителя (аргумент-функция `send` у `bufferFlush(send)`) падает на второй → `{ sent: 1, left: 1 }`, в файле осталась одна. Формат файла и load/save — по образцу `src/queue.ts:28-39`, путь `config.SQLITE_PATH.replace(/\.sqlite$/, '.food-buffer.json')`.

- [ ] **Step 3:** `npm test` → новый тест FAIL → реализовать `src/food-buffer.ts` → PASS.

- [ ] **Step 4: запись в боте.** Callback `food-yes`: собрать `BufferedEntry[]` из карточки (только items с `food`), `bufferPush` → сразу `bufferFlush(fsCreateFoodEntry)`; ответ: `✅ Записала в FatSecret (N позиций) — смотри в приложении. powered by fatsecret`, а если `left > 0` — `📤 Заявка Premier Free ещё на рассмотрении: сохранила N позиций, отправлю сама, как только FatSecret откроет запись`. Отдельно различать ошибку авторизации пользователя (FatSecret вернул invalid/expired token): тогда не «ждём Premier», а ответ «токен доступа устарел — перепривяжи аккаунт: /fatsecret_link» (требование спеки, раздел «Ошибки»). Плюс тихий `bufferFlush` при старте бота и раз в час (`setInterval` в `src/index.ts` рядом с существующей инициализацией) — так буфер дольётся сам после одобрения.

- [ ] **Step 5: живой прогон.** До одобрения Premier: карточка → «Записать» → сообщение про буфер, файл `*.food-buffer.json` на VDS пополнился. (После одобрения — повторить: запись появляется в приложении FatSecret; тестовую запись удалить `fsDeleteFoodEntry` tmp-скриптом.)

- [ ] **Step 6:** `npm run ts` + `npm test`. Commit: `git add -f src/food-buffer.ts src/food-buffer.test.ts src/fatsecret.ts src/bot.ts src/index.ts && git commit -m "food: запись в дневник FatSecret с буфером до одобрения Premier Free"`

---

### Task 7: сквозная проверка и деплой

**Files:**
- Modify: `README.md` (раздел «Еда → FatSecret»: ключи в .env, /fatsecret_link, буфер)

- [ ] **Step 1:** ключи FatSecret — в `~/.config/rokid-ai/.env` на VDS (значения пользователь вставляет сам из кабинета; попросить в чате, самой значения не читать и не логировать).
- [ ] **Step 2:** `./deploy/bot.sh` → зелёный до «✅ бот на VDS обновлён и работает».
- [ ] **Step 3:** сквозной путь: фото еды в бота → карточка → «Записать» → ответ про буфер (или запись в приложении, если Premier уже одобрен). Голосом: «съел тарелку борща» → то же.
- [ ] **Step 4:** README: короткий раздел — какие ключи нужны, как привязать аккаунт, что происходит до одобрения Premier Free.
- [ ] **Step 5:** Commit: `git add -f README.md && git commit -m "docs: еда → FatSecret — настройка ключей и привязка аккаунта"`. Пуш — только по команде пользователя.
