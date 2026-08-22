# Task 3 — привязка аккаунта FatSecret (3-legged OAuth 1.0 с PIN) — отчёт

## Docs (Step 1)

`https://platform.fatsecret.com/docs/guides/authentication/oauth1` описывает только сам механизм подписи (сводка OAuth Core 1.0), URL-ов трёх шагов там нет — есть только ссылка на подстраницу `/oauth1/three-legged`. Проверила её отдельным WebFetch и перепроверила вторым запросом с просьбой воспроизвести страницу дословно — оба ответа совпали:

- Step 1 (request token): `POST https://authentication.fatsecret.com/oauth/request_token`, параметр `oauth_callback=oob` для PIN-флоу. Успех отдаёт form-encoded `oauth_token`, `oauth_token_secret`, `oauth_callback_confirmed`.
- Step 2 (авторизация): `https://authentication.fatsecret.com/oauth/authorize?oauth_token=...` — пользователь открывает в браузере, разрешает доступ, получает PIN (`oauth_verifier`) для oob-режима.
- Step 3 (access token): документация называет его **GET**-запросом `https://authentication.fatsecret.com/oauth/access_token` с `oauth_verifier`.

**Отклонение от доков:** бриф явно требует Step 3 через POST, и `oauth1Params` (Task 1) жёстко зашивает `'POST'` в base string подписи (`oauth1BaseString('POST', ...)`) — signature была бы неверной для реального GET-запроса. Раз интерфейс `oauth1Params` менять нельзя, реализовала `access_token` как фактический POST-запрос (метод запроса совпадает с методом в подписи). Многие серверы OAuth1 такое принимают, но не проверено вживую — см. риски ниже.

## Что сделано

- `src/fatsecret.ts`: добавлены `fsStartLink`, `fsFinishLink`, `fsLinked`, `fsUserRequest` + приватные `fatsecretTokenPath`/`loadUserToken`/`saveUserToken`/`oauth1Post`. Хранение токена — `config.SQLITE_PATH.replace(/\.sqlite$/, '.fatsecret.json')`, тот же приём mkdirSync+writeFileSync, что в `queuePath()` (`src/queue.ts:24`). Незавершённая привязка (между `/fatsecret_link` и `/fatsecret_pin`) — в памяти модуля (`pendingRequestToken`), по образцу `undoable`/`pendingWork` в `bot.ts`.
- `src/bot.ts`: команды `fatsecret_link` и `fatsecret_pin` рядом с `start` (после `src/bot.ts:190`), обёрнуты в try/catch с `logError` и русским сообщением об ошибке — по образцу `bot.callbackQuery(/^undo:.../)`.
- `src/fatsecret.test.ts`: добавлен интеграционный тест полного флоу (`fsStartLink` → `fsFinishLink` → `fsLinked` → `fsUserRequest`) с моком `globalThis.fetch` под три FatSecret-эндпоинта; проверяет URL авторизации, тело запросов (`oauth_callback=oob`, `oauth_verifier`, `oauth_token`) и итоговый ответ. Файл токена подчищается в `t.after`.

## Проверка

- `npm run ts` — чисто.
- `npm test` — 2/2 зелёных (старый тест `oauth1BaseString` + новый тест флоу привязки).
- Живой Telegram-флоу (Step 4 брифа): **пропущен по договорённости** — деплой на VDS и прогон `/fatsecret_link` → `/fatsecret_pin` в реальном Telegram отложены до финальной задачи; доказательства здесь — типы, тесты и точное соответствие кода проверенным докам.

## Риски / что стоит проверить на живом флоу

1. **Step 3 = POST вместо GET** (см. выше) — если FatSecret строго требует GET для `access_token`, обмен PIN на access-токены упадёт с ошибкой подписи. Первое, что смотреть, если `/fatsecret_pin` вернёт ошибку от FatSecret.
2. `fsUserRequest` не кеширует и не обновляет токены — если пользователь отзовёт доступ на стороне FatSecret, ошибка API дойдёт как есть; переподключение — только через `/fatsecret_link` заново (перезаписывает файл).

## Файлы

- `/Users/talalaev-m/projects/rokid-ai/src/fatsecret.ts`
- `/Users/talalaev-m/projects/rokid-ai/src/bot.ts`
- `/Users/talalaev-m/projects/rokid-ai/src/fatsecret.test.ts`

Коммит: `b9cacea` — "food: привязка аккаунта FatSecret — 3-legged OAuth 1.0 с PIN, команды в боте" (ветка `food-fatsecret`, не запушено).

## Fix (ревью-раунд 2026-08-23)

Ревью подтвердило риск, названный выше как "Риск 1": по докам access_token — это **GET**-запрос с параметрами (включая подпись) в query string, а не POST с телом. Мой прежний код сознательно шёл на POST, чтобы совпасть с захардкоженным `'POST'` внутри `oauth1Params`, — это было неверно: signature для GET и POST разная (метод входит в base string), и любой реальный `/fatsecret_pin` упал бы с ошибкой подписи на стороне FatSecret.

Правки:
- `oauth1Params` получил необязательный `method` (по умолчанию `'POST'`, обратная совместимость сохранена — других вызывающих кроме нового кода нет), который прокидывается в `oauth1BaseString`.
- `fsFinishLink` теперь строит запрос к `access_token` как GET: подписывает с `method: 'GET'`, все параметры (включая `oauth_signature`) уходят в query string через новую `oauth1Get`, тела нет.
- `request_token` остался POST (доки это подтверждают).
- Убрала сырое тело ответа из сообщений об ошибках в `fsStartLink`/`fsFinishLink` (`FatSecret request_token: пустой ответ ${body}` → `... пустой или неполный ответ`) — битый ответ сервера больше не может протащить обрывок `oauth_token` в текст ошибки, который увидит пользователь в Telegram.
- Тест переписан: мок `fetch` теперь фиксирует ещё и HTTP-метод; ассерты проверяют, что `access_token`-вызов — `GET`, тело пустое, а `oauth_verifier`/`oauth_token` лежат в query string URL, а не в body.

Проверка после фикса:
- `npm run ts` — чисто.
- `npm test`:
  ```
  ✔ oauth1BaseString: сортировка, RFC3986-кодирование, кириллица (0.391458ms)
  ✔ fsStartLink → fsFinishLink → fsLinked → fsUserRequest: полный флоу привязки (10.527583ms)
  ℹ tests 2
  ℹ pass 2
  ℹ fail 0
  ```

Коммит фикса: `<будет вписан после commit>`.
