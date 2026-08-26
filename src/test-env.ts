// Обязательные настройки для тестов на машине без боевого
// ~/.config/rokid-ai/.env (чистый клон, CI): config.ts завершает процесс,
// если их нет. Фейки ставятся до dotenv (он не перебивает уже заданное),
// поэтому тесты никогда не работают с настоящими токенами.
// Импортировать раньше модулей, которые тянут config.js.
process.env.OPENROUTER_API_KEY ??= 'test-openrouter-key';
process.env.TELEGRAM_BOT_TOKEN ??= '0:test-telegram-token';
process.env.OWNER_TELEGRAM_ID ??= '1';

export {};
