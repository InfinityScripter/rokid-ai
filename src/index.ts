import { bot } from './bot.js';
import { warmUpCalendar } from './calendar.js';
import { config } from './config.js';
import { flushWithFatSecret } from './food-buffer.js';
import { startInboxServer } from './inbox.js';
import { log, logError } from './log.js';

const FOOD_BUFFER_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

// Тихий флаш буфера FatSecret: пока заявка на Premier Free не одобрена,
// flushWithFatSecret просто ничего не отправит и вернёт left = размер буфера
// без ошибки в логе — шумим только на реальном исходе.
function flushFoodBuffer(): void {
  flushWithFatSecret()
    .then((result) => {
      if (result.sent > 0) log('food-buffer:', `отправила ${result.sent}, осталось в буфере ${result.left}`);
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
bot.start({
  onStart: () => log('rokid-ai бот запущен, жду голосовые и фото'),
});
