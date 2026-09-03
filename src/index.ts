import { BOT_COMMANDS, bot } from './bot.js';
import { warmUpCalendar } from './calendar.js';
import { config } from './config.js';
import { isInvalidTokenError } from './fatsecret.js';
import { flushWithFatSecret } from './food-buffer.js';
import { startInboxServer } from './inbox.js';
import { log, logError } from './log.js';

const FOOD_BUFFER_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

// Разовое сообщение владельцу про протухший токен — пока ошибка не сменится
// (или не пропадёт), не долбим одним и тем же алертом каждый час.
let ownerAlertedForInvalidToken = false;

// Тихий флаш буфера FatSecret: пока заявка на Premier Free не одобрена,
// flushWithFatSecret просто ничего не отправит и вернёт left = размер буфера
// без ошибки в логе — шумим только на реальном исходе.
function flushFoodBuffer(): void {
  flushWithFatSecret()
    .then((result) => {
      if (result.sent > 0) log('food-buffer:', `отправила ${result.sent}, осталось в буфере ${result.left}`);
      if (!result.error) {
        ownerAlertedForInvalidToken = false;
        return;
      }
      logError('food-buffer-flush', result.error);
      if (!isInvalidTokenError(result.error)) {
        ownerAlertedForInvalidToken = false;
      } else if (!ownerAlertedForInvalidToken) {
        ownerAlertedForInvalidToken = true;
        bot.api
          .sendMessage(config.OWNER_TELEGRAM_ID, '⚠️ Токен доступа FatSecret устарел — перепривяжи аккаунт: /fatsecret_link')
          .catch((e) => logError('food-buffer-alert', e));
      }
    })
    .catch((e) => logError('food-buffer-flush', e));
}

if (config.ROKID_MODE === 'mac') {
  warmUpCalendar()
    .then(() => log('Calendar.app прогрет'))
    .catch((e) => logError('calendar-warmup', e));
}
startInboxServer();
flushFoodBuffer();
setInterval(flushFoodBuffer, FOOD_BUFFER_FLUSH_INTERVAL_MS);
bot.api.setMyCommands(BOT_COMMANDS).catch((e) => logError('set-my-commands', e));
bot.start({
  onStart: () => log('rokid-ai бот запущен, жду голосовые и фото'),
});
