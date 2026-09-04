# rokid-ai — заметки для агентов

Конвейер очков Rokid: голос/фото → расшифровка → LLM-роутер намерений →
календарь / еда (FatSecret) / саммари встреч / итоги дня по еде. Владелец один,
интерфейс — Telegram-бот + HTTP-инбокс для приложения очков.

## Команды

- `npm test` — тесты (node:test, работают без секретов: `src/test-env.ts`).
- `npm run ts` — typecheck (`tsc --noEmit`, strict).
- `npm start` / `npm run dev` — запуск бота (нужен `~/.config/rokid-ai/.env`).
- Деплой на VDS — автоматически GitHub Actions `Deploy` при мерже в `main`
  (нужны секреты VPS_HOST/VPS_USER/VPS_SSH_KEY в репо) или вручную
  `./deploy/bot.sh` с машины владельца. Из агентской сессии по SSH — нельзя,
  поэтому «задеплоить» = смержить в main.

## Карта кода

- `src/bot.ts` — Telegram: обработчики сообщений, карточки с кнопками,
  `applyIntent` (единая точка исполнения намерений — её зовут и инбокс-ручки).
- `src/router.ts` — интенты: `calendar_event`, `food_log`, `meeting_audio`,
  `note`, `cancel_last`, `agenda`; схемы zod + tool-use через OpenRouter.
- `src/inbox.ts` — HTTP-инбокс (только 127.0.0.1, наружу — nginx с TLS);
  ручки: `/glasses/chat` (SSE, `src/glasses.ts`), `/sse` (AIUI-агент),
  `/chat/completions` (`src/openai-compat.ts`), `/agenda`, `/vision/*`
  (`src/vision.ts`), `/bridge/*` (очередь для мостика), `/inbox/*`.
- Календари: `events.ts` → `calendar.ts` (osascript, mac) или `caldav.ts`
  (iCloud) + `queue.ts`/`bridge.ts` (рабочие события через Мак).
- Еда: `fatsecret.ts` (OAuth 1.0/2.0 руками), `food.ts` (подбор по базе),
  `food-buffer.ts` (буфер до одобрения Premier Free), `barcode.ts` (zxing-wasm
  → модель как запасной путь, Open Food Facts для российских товаров).
- `meeting.ts` — саммари длинных записей; `reminders.ts` — напоминания
  14:30/21:30 МСК и итоги дня по дневнику FatSecret (`food_entries.get`);
  `goal.ts` — дневная норма (`*.goal.json`), остаток до неё в итогах.
- `pending.ts` — карточки еды с кнопками, правка и режим «штрихкод» на диске
  (`*.pending.json`): переживают перезапуск бота при деплое.

## Конвенции

- Тексты пользователю — по-русски; комментарии в коде — только там, где есть
  неочевидное ограничение (не пересказывать код).
- Новые npm-зависимости — только при реальной необходимости (OAuth-подпись,
  например, написана руками на node:crypto).
- Файлы данных — рядом с `config.SQLITE_PATH` через `.replace(/\.sqlite$/,
  '.<имя>.json')`; каталог `data/` в git не попадает.
- Тесты, которым нужен config: `import './test-env.js'` первым локальным
  импортом + `process.env.SQLITE_PATH` во временную папку ДО динамического
  `await import('./config.js')` (статические импорты хойстятся).
- У владельца в `~/.gitignore` глобальный `/*`: на его машине файлы добавляются
  через `git add -f` — новые файлы легко забыть закоммитить, проверяй
  `npm run ts` на чистом клоне. `PLAN.md`/`etap-0.md` — его локальные файлы,
  в репо их нет; актуальный план — `docs/ROADMAP.md`.

## Что где проверять

- Бэклог и статус: `docs/ROADMAP.md` (единственный источник плана в репо).
- Дизайн-решения: `docs/superpowers/specs/`, планы: `docs/superpowers/plans/`.
- Протокол очков: `docs/glasses-protocol.md`.
- LLM-вызовы живьём не тестируются — чистая логика покрывается node:test,
  сквозные проверки делает владелец после деплоя.
