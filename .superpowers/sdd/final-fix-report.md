# food-fatsecret: фиксы финального ревью

## Что сделано

1. **src/fatsecret.test.ts, src/food-buffer.test.ts** — `SQLITE_PATH` теперь указывает
   во временную папку (`mkdtempSync`), выставляется в `process.env` до импорта
   `./config.js`. Так как статические импорты хойстятся, модули (`config`,
   `fatsecret`, `food-buffer`) подключены динамическим `await import()` после
   установки переменной окружения — top-level await поддерживается ESM +
   `node --import tsx`.
2. **src/food-buffer.ts** — `bufferFlush` сохраняет файл после КАЖДОЙ успешной
   отправки (`save(data)` внутри цикла сразу после `shift()`), а не один раз
   в конце: падение процесса посреди флаша больше не приведёт к повторной
   отправке уже ушедших записей.
3. **src/index.ts** — периодический флаш логирует ошибку через `logError` при
   `result.error`; если это `isInvalidTokenError` — дополнительно шлёт
   владельцу разовое сообщение «токен устарел — /fatsecret_link» (флаг
   `ownerAlertedForInvalidToken`, сбрасывается, когда ошибка пропадает или
   меняет тип).
4. **src/food-buffer.ts** — гонка между синхронным `bufferPush` и асинхронным
   `bufferFlush` (await внутри send даёт event loop переключиться, push мог
   затереть файл устаревшим снимком) устранена модульной цепочкой промисов
   (`chain`), через которую идут обе операции. `bufferPush` стал асинхронным
   (`Promise<void>`) — вызовы в `bot.ts` обновлены на `await`.
5. **src/bot.ts** — в ответе food-yes для случая «часть ещё в буфере, ждёт
   Premier Free» добавлена подпись `powered by fatsecret` (успешная ветка
   ответа уже её содержала).
6. **src/fatsecret.ts** — дата записи дневника считается по московскому дню
   (`mskDayNumber`: `toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'})`
   → `Date.UTC(y, m-1, d) / 86_400_000`), а не `Math.floor(getTime()/86_400_000)`
   по UTC. Добавлены тесты на граничный случай 00:30 МСК = 21:30 UTC накануне.
7. **src/format.test.ts** (новый файл) — юнит-тест `formatFoodCard`: найденная
   позиция, не найденная позиция, сумма ккал, последняя строка
   `'powered by fatsecret'`.

## Проверки

- `npm run ts` — чисто (0 ошибок).
- `npm test` — 14/14 зелёных.
- Верификация finding 1: создан фейковый `data/rokid-ai.fatsecret.json` с
  «боевыми» токенами и непустой `data/rokid-ai.food-buffer.json`, прогнан
  `npm test` — оба файла пережили прогон байт-в-байт (проверено по содержимому
  и diff'у), после проверки удалены.

## Замечания

- `bufferPush` сменил сигнатуру с `void` на `Promise<void>` — единственный
  внешний вызывающий код (`bot.ts`) обновлён на `await`; других потребителей
  в кодовой базе нет (проверено grep'ом).
