# Task 6 report: запись в дневник FatSecret + буфер до одобрения Premier Free

## Статус
Готово. Живой прогон (Step 5) не делался — деплой/live-проверки по договорённости отложены до финальной задачи, доказательство здесь = typecheck + тесты.

## Коммит
`1f041f2` — "food: запись в дневник FatSecret с буфером до одобрения Premier Free" (ветка `food-fatsecret`, не запушено). Файлы `src/food-buffer.ts` и `src/food-buffer.test.ts` попадали под глобальный `~/.gitignore` (`/*`) — добавлены через `git add -f`, как и раньше в этом проекте.

## Step 1 — сверка доков (WebFetch)
`food_entry.create` (https://platform.fatsecret.com/docs/v1/food_entry.create):
- Параметры: `food_id`, `food_entry_name`, `serving_id`, `number_of_units`, `meal`, `date` — все обязательные, `format` опциональный.
- `date` — целое число дней с 1 января 1970 (подтверждает `Math.floor(date.getTime() / 86_400_000)` из брифа).
- `meal`: breakfast/lunch/dinner/other. Метод POST, нужен 3-legged OAuth 1.0 (это уже `fsUserRequest`).
- Ответ: id в `food_entry.food_entry_id`.

`food_entry.delete`: параметр `food_entry_id`, метод через `method: 'food_entry.delete'` (тот же server.api, что и остальные вызовы в проекте).

Коды ошибок (https://platform.fatsecret.com/docs/guides/error-codes): код 9 (OAuth 1.0) = "Invalid access token" — единственный однозначно подтверждённый код авторизационной ошибки. Отдельного кода на «Premier ещё не одобрен» доки не дают. Поэтому `isInvalidTokenError` в `src/fatsecret.ts` — эвристика по коду 9 в тексте сообщения; всё остальное в `food_entry.create` трактуется как проблема прав/буферизация. Это прямо прокомментировано в коде как эвристика, не факт.

## TDD-доказательство (Step 2–3)
1. Написан `src/food-buffer.test.ts` до реализации.
2. Прогон до создания `food-buffer.ts` → `ERR_MODULE_NOT_FOUND` (модуля нет) — падение зафиксировано в терминале.
3. Реализован `src/food-buffer.ts` → все тесты зелёные.

Тесты (3 шт.): `bufferPush` кладёт записи в файл; `bufferFlush` с моком-отправителем, падающим на второй записи, даёт `{sent:1, left:1}` и в файле остаётся только вторая запись; пустой буфер не вызывает отправителя.

## Что сделано
- `src/fatsecret.ts`: `fsCreateFoodEntry`, `fsDeleteFoodEntry`, `isInvalidTokenError`.
- `src/food-buffer.ts` (новый): `bufferPush`, `bufferFlush(send)` (тестируемый через мок), `flushWithFatSecret()` — готовый отправитель через `fsCreateFoodEntry` (второй потребитель — `bot.ts` и `index.ts`, поэтому вынесен один раз).
- `src/bot.ts`: `food-yes` теперь реально пишет — собирает `BufferedEntry[]` из карточки (только позиции с найденным продуктом), `bufferPush` → `flushWithFatSecret()`, try/catch + `logError('food-yes', ...)` по образцу `work-yes`. Три исхода ответа: всё ушло / осталось в буфере (Premier на рассмотрении) / токен протух (отдельное сообщение с `/fatsecret_link`).
- `src/index.ts`: тихий флаш при старте + `setInterval` раз в час.
- `src/format.ts`: ветка `case 'food_log'` в `formatIntent` сведена к комментарию «недостижимо» + `return ''` (она реально перехватывается раньше в `applyIntent`) — убрана стейл-фраза «подключим на этапе 4».

## Проверки
- `npm run ts` — чисто.
- `npm test` — 11/11 зелёных (включая новые 3 для буфера); один ожидаемый ERROR-лог в существующем тесте на изоляцию ошибок в `food.test.ts`, не регрессия.

## Фикс по ревью (2026-08-23)
Замечание: в ветке `else if (result.left > 0)` число «сохранила N позиций» бралось из `entries.length` (все позиции этой карточки), а не из `result.left` (реально осталось в буфере). При частичном флаше (2 позиции, первая ушла, вторая упала) сообщение врало «сохранила 2», хотя 1 уже уехала в FatSecret, а буфер держит только 1.

Исправлено в `src/bot.ts` (`food-yes`): сообщение теперь строится из `result.sent` и `result.left`, оба из фактического результата `flushWithFatSecret()`, а не из числа позиций на карточке. Если что-то реально отправилось — это тоже упоминается.

Исправленная строка:
```
} else if (result.left > 0) {
  const sentPart = result.sent > 0 ? `✅ Записала ${result.sent} — ` : '';
  await ctx.reply(
    `${sentPart}📤 ещё ${result.left} жду одобрения Premier Free, отправлю сама, как только FatSecret откроет запись.`,
  );
}
```

Покрывающего теста на этот текст нет — это склейка в `bot.ts` без тестовой инфраструктуры бота (как и раньше). Доказательство — `npm run ts` (чисто) и `npm test` (11/11 зелёных, тот же набор, что и до фикса).

## Опасения / что не проверено вживую
- Step 5 (живой прогон на VDS, файл `.food-buffer.json`, реальная запись после одобрения Premier) не выполнялся — по договорённости деплой и live-проверки идут в финальной задаче.
- Формат `food_entry_id` в ответе FatSecret обработан для двух вариантов (`{value: string}` и голая строка) — в доках явно не указано, какой именно приходит в JSON-режиме; если реальный ответ окажется другой формы, `fsCreateFoodEntry` бросит явную ошибку «ответ без food_entry_id», а не тихо проглотит.
- Эвристика `isInvalidTokenError` завязана на точный текст сообщения из `fsUserRequest` (`FatSecret <method>: 9 <message>`) — если FatSecret изменит формат ошибки, распознавание сломается молча (будет трактоваться как «ждём Premier» вместо «токен протух»).
