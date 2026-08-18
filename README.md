# rokid-ai

Конвейер для очков Rokid: голос/фото → расшифровка → разбор намерения →
календарь / дневник еды / саммари встреч. План — `PLAN.md`, этап 0 — `etap-0.md`.

## Два режима (ROKID_MODE в .env)

- **mac** — всё на Маке: Whisper локально, оба календаря через Calendar.app.
- **vds** — бот живёт на VDS 24/7 (`/opt/rokid-ai`, systemd-юнит `rokid-ai`):
  распознавание — Gemini через OpenRouter (локальный Whisper в 1 ГБ памяти
  VDS не помещается), личный календарь — напрямую в iCloud по CalDAV
  (нужны APPLE_ID_EMAIL + APPLE_APP_PASSWORD — пароль приложения с
  appleid.apple.com), рабочий — через очередь: мостик на Маке
  (`deploy/bridge.sh`, launchd раз в минуту, ssh-туннель до инбокса VDS)
  забирает задания и пишет через Calendar.app. HTTP-инбокс слушает только
  127.0.0.1 — наружу его выведет nginx с TLS на этапе 2.

## Что уже работает (этап 1)

Telegram-бот: пришли голосовое, фото еды или текст — бот вернёт расшифровку и
разобранное намерение (встреча / еда / заметка). Запись в календарь и дневник —
следующие этапы. HTTP-инбокс для companion-приложения заложен (`src/inbox.ts`),
включается заданием `INBOX_TOKEN`.

## Запуск

1. Секреты — в `~/.config/rokid-ai/.env` (шаблон уже там, подсказки в комментариях).
   Минимум для старта: `TELEGRAM_BOT_TOKEN` (создать бота у @BotFather),
   `OPENROUTER_API_KEY` (https://openrouter.ai/settings/keys) и
   `OWNER_TELEGRAM_ID`. Модель — `ROUTER_MODEL`, по умолчанию
   `openai/gpt-5.6-luna`.
2. Распознавание речи — локальный whisper.cpp:

   ```bash
   brew install whisper-cpp
   mkdir -p ~/.cache/whisper
   curl -L -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
   ```

   Модель `large-v3-turbo` (квантованная, ~547 МБ) — лучшая точность для
   русского при скорости уровня small. Путь — `WHISPER_MODEL_PATH` в .env.
3. `npm install && npm start`

## Структура

- `src/bot.ts` — Telegram-бот (голос, фото, текст)
- `src/stt.ts` — ffmpeg + whisper-cli
- `src/router.ts` — LLM-роутер намерений (Anthropic tool-use, схемы в zod)
- `src/format.ts` — человекочитаемые ответы бота
- `src/inbox.ts` — HTTP-инбокс для companion-приложения (этап 2)
