# Контракт «очки ↔ сервер» и доработки инбокса (разведка 2026-08-17)

Источники: rode (Apache-2.0 — код можно заимствовать), meeting-helper-rokid
(MIT), Rokid-Scribe (GPL-3.0 — только идеи, код не копировать).

## Протокол rode (берём за образец, PROTOCOL.en.md)

- `POST /glasses/chat`, Bearer-токен, multipart/form-data:
  поле `audio` (WAV 16 кГц моно PCM16, обязательное), поле `image`
  (JPEG, опциональное). Ответ — text/event-stream.
- SSE-события (`data: <JSON>`, поле type):
  `user` (эхо расшифровки) → `status` («думаю») → `answer_delta`* →
  `answer` → `done`; ошибки — событием `error` при HTTP 200.
  Клиент игнорирует незнакомые типы. Таймаут хода у клиента — 45 с.
- Защита сервера: rate-limit по IP, лимит тела (413), маскирование
  токенов в логах (security.ts, ~25 строк, Apache-2.0).

## Клиентские механики (для нашего будущего приложения на очках)

- Кнопка дужки = обычные KeyEvent: клик `KEYCODE_ENTER`, двойной
  `KEYCODE_BACK`, свайпы `DPAD_UP/DOWN`. Долгое удержание забрано
  системным ассистентом — приложению недоступно.
- Звук: AudioRecord 16 кГц моно PCM16 + самодельный 44-байтовый
  WAV-заголовок (WavRecorder.kt из rode). Записи короче ~0.4 с
  отбрасывать как случайные.
- Wi-Fi/сон: на YodaOS работает `setWifiEnabled(true)` на старте;
  на время запроса — PARTIAL_WAKE_LOCK + WifiLock(HIGH_PERF);
  FLAG_KEEP_SCREEN_ON.
- Автозапуск: BootReceiver + foreground-сервис START_STICKY с
  foregroundServiceType="microphone" (манифест meeting-helper, MIT).
- Дисплей 480×640: TextView 12sp, зелёный 0xFF45F068; статус-бар
  с пингом сервера каждые 4 с (GET / без токена).

## Надёжность офлайна (идеи Rokid-Scribe, GPL — только идеи)

- Формат записи AAC ADTS 16 кГц 64 кбит/с (час ≈ 28 МБ; оборванный
  файл остаётся проигрываемым, в отличие от m4a).
- Draft-файл атомарно ДО старта записи; восстановление сирот на старте.
- Из очереди удалять только после подтверждения сервера; md5 для сверки.
- Следствие для сервера: клиент будет ретраить → нужна идемпотентность
  по recordingId.

## Доработки нашего inbox.ts

Must:
1. Ручка `POST /glasses/chat`: multipart (audio + опц. image),
   сохранить как .wav → transcribe() → routeText → applyIntent.
2. SSE-ответ: user → status → answer → done; ошибки событием error.
3. Серверный таймаут хода < 45 с (иначе очки отваливаются раньше).
4. ✅ nginx TLS: https://api.aifirst.us.com:8444/rokid/ — сделано.
5. Лимит размера тела + rate-limit по IP (перенести security.ts из rode).

Nice:
6. Идемпотентность по recordingId (для очереди досылки).
7. `status` с реальными этапами («распознаю» → «пишу в календарь»).
8. `GET /` → 200 без токена (пинг-индикатор связи на очках).
9. TTS-события (озвучка ответа) — по схеме rode, позже.
