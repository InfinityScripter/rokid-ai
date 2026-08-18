import { bot } from './bot.js';
import { warmUpCalendar } from './calendar.js';
import { config } from './config.js';
import { startInboxServer } from './inbox.js';
import { log, logError } from './log.js';

if (config.ROKID_MODE === 'mac') {
  warmUpCalendar()
    .then(() => log('Calendar.app прогрет'))
    .catch((e) => logError('calendar-warmup', e));
}
startInboxServer();
bot.start({
  onStart: () => log('rokid-ai бот запущен, жду голосовые и фото'),
});
