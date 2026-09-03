import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';

import { Bot, InlineKeyboard, Keyboard } from 'grammy';

import {
  hasBarcodeKeyword,
  parseBarcodeText,
  readBarcodeFromPhoto,
  stripBarcodeKeyword,
  type BarcodeRead,
} from './barcode.js';
import { caldavListEvents } from './caldav.js';
import { config } from './config.js';
import { fsFinishLink, fsLinked, fsStartLink, isInvalidTokenError } from './fatsecret.js';
import { writeOneEvent, undoOne, type CalendarEventInput, type UndoRef } from './events.js';
import { bufferPush, flushWithFatSecret, type BufferedEntry } from './food-buffer.js';
import {
  matchFoodByBarcode,
  matchFoodItems,
  mealByMoscowTime,
  reviseFoodItems,
  type FoodMatch,
  type FoodMeal,
} from './food.js';
import { formatEventLine, formatFoodCard, formatIntent } from './format.js';
import { log, logError } from './log.js';
import { splitTranscript, summarizeMeeting, transcribeLong } from './meeting.js';
import { addNote, listNotes } from './notes.js';
import type { Intent } from './router.js';
import { parseFoodPhoto, routeText } from './router.js';
import { tmpAudioPath, transcribe } from './stt.js';

const MEETING_AUDIO_THRESHOLD_SECONDS = 180;

// Состояние кнопок живёт в памяти: после перезапуска бота старые кнопки
// вежливо отвечают «устарело», это осознанный компромисс.
const undoable = new Map<string, UndoRef[]>();
const pendingWork = new Map<string, CalendarEventInput[]>();
export const pendingFood = new Map<string, { meal: FoodMeal; matches: FoodMatch[] }>();
// Ключ последней записи — для голосовой команды «отмени последнюю запись».
let lastUndoKey: string | null = null;
// «✏️ Поправить»: следующее сообщение владельца — правка этой карточки, а не
// новая заметка. Одна ожидающая правка на бота (владелец один).
let pendingFoodEdit: { key: string; meal: FoodMeal; matches: FoodMatch[] } | null = null;
// /barcode без цифр: следующее фото разбирается только по штрихкоду.
let barcodeModeArmed = false;

// Постоянная клавиатура под полем ввода — выбор режима одним тапом вместо
// команды. Тексты кнопок перехватываются до роутера (см. message:text).
const BUTTON_BARCODE = '🔎 Штрихкод';
const BUTTON_PHOTO = '📷 Фото еды';
const BUTTON_NOTES = '📝 Заметки';
const MAIN_KEYBOARD = new Keyboard().text(BUTTON_BARCODE).text(BUTTON_PHOTO).row().text(BUTTON_NOTES).resized().persistent();

function armBarcodeMode(): string {
  barcodeModeArmed = true;
  return (
    '🔎 Жду фото штрихкода — следующий снимок разберу только по нему, без угадывания. ' +
    'Или сразу цифрами: /barcode 4600605030288 всю банку'
  );
}

function notesReply(): string {
  const notes = listNotes(10);
  if (notes.length === 0) {
    return 'Заметок пока нет — пришли текст или голосовое, всё, что не встреча и не еда, запишу сюда.';
  }
  const lines = notes.map((note) => {
    const when = new Date(note.at).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `• ${when} — ${note.text}`;
  });
  return `📝 Последние заметки:\n${lines.join('\n')}`;
}

export type IntentReply = { text: string; keyboard?: InlineKeyboard };

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== config.OWNER_TELEGRAM_ID) return;
  await next();
});

async function writeEvents(events: CalendarEventInput[]): Promise<{ lines: string[]; undos: UndoRef[] }> {
  const lines: string[] = [];
  const undos: UndoRef[] = [];
  for (const event of events) {
    const outcome = await writeOneEvent(event);
    lines.push(outcome.line);
    if (outcome.undo) undos.push(outcome.undo);
  }
  return { lines, undos };
}

function undoKeyboard(undos: UndoRef[]): InlineKeyboard {
  const key = randomUUID();
  undoable.set(key, undos);
  lastUndoKey = key;
  return new InlineKeyboard().text('↩️ Отменить', `undo:${key}`);
}

// Голосовая отмена: то же, что нажать «↩️ Отменить» под последней записью.
async function cancelLast(): Promise<IntentReply> {
  const key = lastUndoKey;
  const undos = key ? undoable.get(key) : undefined;
  if (!key || !undos) {
    return { text: 'Отменять нечего: не вижу недавней записи (или её уже отменили).' };
  }
  undoable.delete(key);
  lastUndoKey = null;
  const results: string[] = [];
  for (const ref of undos) {
    results.push(await undoOne(ref));
  }
  return { text: `↩️ Отмена: ${results.join('; ')}` };
}

// «Что у меня сегодня» — читаем личный календарь. Рабочие встречи живут в
// Calendar.app на Маке и сюда не видны: об этом честно пишем в ответе.
async function showAgenda(from: string, to: string, title: string): Promise<IntentReply> {
  const events = await caldavListEvents(new Date(from), new Date(to));
  if (events.length === 0) {
    return { text: `📅 ${title}: пусто в личном календаре.` };
  }
  const lines = events.map((event) => {
    const when = event.start.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    });
    return `• ${when} — ${event.title}`;
  });
  return { text: [`📅 ${title} (личный календарь):`, ...lines].join('\n') };
}

const MEAL_BUTTONS: { meal: FoodMeal; label: string }[] = [
  { meal: 'breakfast', label: '🍳 Завтрак' },
  { meal: 'lunch', label: '🍲 Обед' },
  { meal: 'dinner', label: '🌙 Ужин' },
  { meal: 'other', label: '🍎 Перекус' },
];

function foodCardKeyboard(key: string, meal: FoodMeal): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('✅ Записать', `food-yes:${key}`)
    .text('✏️ Поправить', `food-edit:${key}`)
    .text('❌ Не надо', `food-no:${key}`)
    .row();
  for (const button of MEAL_BUTTONS) {
    keyboard.text(button.meal === meal ? `${button.label} ✓` : button.label, `food-meal:${key}:${button.meal}`);
  }
  return keyboard;
}

function buildFoodCard(meal: FoodMeal, matches: FoodMatch[]): IntentReply {
  if (matches.length === 0) {
    return { text: 'Не разобрала еду — пришли фото с подписью, что это и сколько, или надиктуй.' };
  }
  const key = randomUUID();
  pendingFood.set(key, { meal, matches });
  return { text: formatFoodCard(meal, matches), keyboard: foodCardKeyboard(key, meal) };
}

async function photoIntent(imageBase64: string, caption?: string): Promise<IntentReply> {
  const intent = await parseFoodPhoto(imageBase64, 'image/jpeg', caption);
  return applyIntent(intent);
}

// Карточка по штрихкоду со строкой-пояснением, откуда взялся продукт;
// null — ни в одной базе нет, пусть вызывающий код идёт другим путём.
async function foodFromBarcode(code: string, caption?: string): Promise<IntentReply | null> {
  log('barcode:', code);
  const outcome = await matchFoodByBarcode(code, caption);
  if (outcome.kind === 'not_found') {
    log('barcode: ни в FatSecret, ни в Open Food Facts', outcome.fatsecretNote ?? '');
    return null;
  }
  const card = buildFoodCard(mealByMoscowTime(new Date()), [outcome.match]);
  const why = outcome.kind === 'openfoodfacts' && outcome.fatsecretNote ? ` (${outcome.fatsecretNote})` : '';
  const how =
    outcome.kind === 'fatsecret'
      ? `🔎 Штрихкод ${code}: продукт из базы FatSecret.`
      : `🔎 Штрихкод ${code}: в FatSecret нет${why}, по этикетке (Open Food Facts) это «${outcome.product.brand ? `${outcome.product.brand} ` : ''}${outcome.product.name}» — подобрала аналог для дневника.`;
  return { ...card, text: `${how}\n\n${card.text}` };
}

const BARCODE_TEXT_HINT = 'Можно прислать цифры текстом: «штрихкод 4600605030288».';

// Фото еды. Явный режим (слово «штрихкод» в подписи или /barcode перед
// фото) — только по коду, без угадывания по снимку: либо продукт, либо
// честный ответ, почему нет. Неявный — штрихкод пробуем, при любом сбое
// распознаём по снимку и говорим, что произошло со штрихкодом.
export async function foodFromPhoto(imageBase64: string, caption?: string, barcodeOnly = false): Promise<IntentReply> {
  const explicit = barcodeOnly || (caption !== undefined && hasBarcodeKeyword(caption));
  const cleanCaption = caption === undefined ? undefined : stripBarcodeKeyword(caption);
  if (!fsLinked()) return photoIntent(imageBase64, cleanCaption);
  let read: BarcodeRead = null;
  try {
    read = await readBarcodeFromPhoto(imageBase64, 'image/jpeg');
  } catch (error) {
    logError('barcode-read', error);
  }
  if (explicit) {
    if (read === null) {
      return {
        text:
          '🔎 Штрихкод на фото не нашла. Сфоткай ближе, чтобы полосы и цифры под ними были в кадре целиком. ' +
          BARCODE_TEXT_HINT,
      };
    }
    if (read === 'unreadable') {
      return { text: `🔎 Штрихкод вижу, но цифры не разобрать. ${BARCODE_TEXT_HINT}` };
    }
    return (
      (await foodFromBarcode(read.code, cleanCaption)) ?? {
        text:
          `🔎 Штрихкод ${read.code} прочитала, но его нет ни в FatSecret, ни в Open Food Facts. ` +
          'Опиши продукт словами (что и сколько) — подберу по названию.',
      }
    );
  }
  if (read === 'unreadable') {
    const reply = await photoIntent(imageBase64, cleanCaption);
    return {
      ...reply,
      text: `🔎 Штрихкод на фото есть, но цифры не разобрать — распознаю по снимку. ${BARCODE_TEXT_HINT}\n\n${reply.text}`,
    };
  }
  if (read) {
    const byCode = await foodFromBarcode(read.code, cleanCaption);
    if (byCode) return byCode;
    const reply = await photoIntent(imageBase64, cleanCaption);
    return {
      ...reply,
      text: `🔎 Штрихкод ${read.code} прочитала, но его нет ни в FatSecret, ни в Open Food Facts — распознаю по снимку.\n\n${reply.text}`,
    };
  }
  return photoIntent(imageBase64, cleanCaption);
}

async function showFoodCard(
  meal: FoodMeal,
  items: { name: string; amount: string; query: string }[],
): Promise<IntentReply> {
  if (!fsLinked()) {
    return { text: 'Сначала привяжи аккаунт: /fatsecret_link' };
  }
  const matches = await matchFoodItems(items);
  return buildFoodCard(meal, matches);
}

// Ожидающая правка перехватывает сообщение до роутера: пересобираем карточку
// по фразе и заменяем старую (её ключ гасим, чтобы старые кнопки не жили).
async function maybeApplyFoodEdit(text: string): Promise<IntentReply | null> {
  const edit = pendingFoodEdit;
  if (!edit) return null;
  pendingFoodEdit = null;
  pendingFood.delete(edit.key);
  const items = await reviseFoodItems(edit.matches, text);
  if (items.length === 0) {
    return { text: '❌ Ок, убрала всё — карточку закрыла.' };
  }
  const matches = await matchFoodItems(items);
  return buildFoodCard(edit.meal, matches);
}

export async function applyIntent(intent: Intent): Promise<IntentReply> {
  if (intent.intent === 'agenda') {
    return showAgenda(intent.from, intent.to, intent.period);
  }
  if (intent.intent === 'cancel_last') {
    return cancelLast();
  }
  if (intent.intent === 'food_log') {
    return showFoodCard(intent.meal, intent.items);
  }
  if (intent.intent === 'note') {
    addNote(intent.text);
    return { text: formatIntent(intent) };
  }
  if (intent.intent !== 'calendar_event' || intent.uncertain.length > 0) {
    return { text: formatIntent(intent) };
  }

  const personal = intent.events.filter((e) => e.calendar === 'personal');
  const work = intent.events.filter((e) => e.calendar === 'work');
  const lines: string[] = [];
  const keyboard = new InlineKeyboard();
  let hasButtons = false;

  const { lines: personalLines, undos } = await writeEvents(personal);
  lines.push(...personalLines);
  if (undos.length > 0) {
    const key = randomUUID();
    undoable.set(key, undos);
    lastUndoKey = key;
    keyboard.text('↩️ Отменить', `undo:${key}`).row();
    hasButtons = true;
  }

  if (work.length > 0) {
    const key = randomUUID();
    pendingWork.set(key, work);
    lines.push(...work.map((e) => `❓ Рабочее: ${formatEventLine(e)} — записать?`));
    keyboard.text('✅ Записать рабочее', `work-yes:${key}`).text('❌ Не надо', `work-no:${key}`);
    hasButtons = true;
  }

  if (intent.skipped.length > 0) {
    lines.push(`⚠️ Пропустила: ${intent.skipped.join('; ')}`);
  }
  return { text: lines.join('\n'), keyboard: hasButtons ? keyboard : undefined };
}

bot.callbackQuery(/^undo:(.+)$/, async (ctx) => {
  const undos = undoable.get(ctx.match[1]);
  if (!undos) {
    await ctx.answerCallbackQuery({ text: 'Отменять уже нечего (возможно, бот перезапускался)' });
    return;
  }
  undoable.delete(ctx.match[1]);
  if (lastUndoKey === ctx.match[1]) lastUndoKey = null;
  await ctx.answerCallbackQuery({ text: 'Отменяю…' });
  try {
    const results: string[] = [];
    for (const ref of undos) {
      results.push(await undoOne(ref));
    }
    await ctx.reply(`↩️ Отмена: ${results.join('; ')}`);
  } catch (error) {
    logError('undo', error);
    await ctx.reply(`Ошибка отмены: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.callbackQuery(/^work-yes:(.+)$/, async (ctx) => {
  const events = pendingWork.get(ctx.match[1]);
  if (!events) {
    await ctx.answerCallbackQuery({ text: 'Эта карточка устарела (возможно, бот перезапускался)' });
    return;
  }
  pendingWork.delete(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'Записываю…' });
  try {
    const { lines, undos } = await writeEvents(events);
    await ctx.reply(lines.join('\n'), {
      reply_markup: undos.length > 0 ? undoKeyboard(undos) : undefined,
    });
  } catch (error) {
    logError('work-yes', error);
    await ctx.reply(`Ошибка записи: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.callbackQuery(/^work-no:(.+)$/, async (ctx) => {
  const existed = pendingWork.delete(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: existed ? 'Ок, не записываю' : 'Эта карточка устарела' });
  if (existed) await ctx.reply('❌ Рабочее не записала.');
});

bot.callbackQuery(/^food-yes:(.+)$/, async (ctx) => {
  const pending = pendingFood.get(ctx.match[1]);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Эта карточка устарела (возможно, бот перезапускался)' });
    return;
  }
  pendingFood.delete(ctx.match[1]);
  if (pendingFoodEdit?.key === ctx.match[1]) pendingFoodEdit = null;
  await ctx.answerCallbackQuery({ text: 'Записываю…' });

  const entries: BufferedEntry[] = [];
  for (const m of pending.matches) {
    if (!m.food || !m.servingId) continue;
    entries.push({
      foodId: m.food.foodId,
      name: m.food.foodName,
      servingId: m.servingId,
      units: m.units,
      meal: pending.meal,
      date: new Date().toISOString(),
    });
  }
  if (entries.length === 0) {
    await ctx.reply('Нечего записывать — ни одна позиция не сматчилась с продуктом.');
    return;
  }

  try {
    await bufferPush(entries);
    const result = await flushWithFatSecret();
    if (result.left > 0 && isInvalidTokenError(result.error)) {
      await ctx.reply('⚠️ Токен доступа устарел — перепривяжи аккаунт: /fatsecret_link');
    } else if (result.left > 0) {
      const sentPart = result.sent > 0 ? `✅ Записала ${result.sent} — ` : '';
      await ctx.reply(
        `${sentPart}📤 ещё ${result.left} жду одобрения Premier Free, отправлю сама, как только FatSecret откроет запись.\npowered by fatsecret`,
      );
    } else {
      await ctx.reply(`✅ Записала в FatSecret (${result.sent} позиций) — смотри в приложении.\npowered by fatsecret`);
    }
  } catch (error) {
    logError('food-yes', error);
    await ctx.reply(`Ошибка записи: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.callbackQuery(/^food-no:(.+)$/, async (ctx) => {
  const existed = pendingFood.delete(ctx.match[1]);
  if (pendingFoodEdit?.key === ctx.match[1]) pendingFoodEdit = null;
  await ctx.answerCallbackQuery({ text: existed ? 'Ок, не записываю' : 'Эта карточка устарела' });
  if (existed) await ctx.reply('❌ Еду не записала.');
});

bot.callbackQuery(/^food-meal:([^:]+):(breakfast|lunch|dinner|other)$/, async (ctx) => {
  const key = ctx.match[1];
  const meal = ctx.match[2] as FoodMeal;
  const pending = pendingFood.get(key);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Эта карточка устарела (возможно, бот перезапускался)' });
    return;
  }
  pending.meal = meal;
  if (pendingFoodEdit?.key === key) pendingFoodEdit.meal = meal;
  await ctx.answerCallbackQuery({ text: 'Приём пищи изменила' });
  try {
    await ctx.editMessageText(formatFoodCard(meal, pending.matches), { reply_markup: foodCardKeyboard(key, meal) });
  } catch (error) {
    // Повторное нажатие той же кнопки: Telegram отвергает правку без изменений.
    logError('food-meal', error);
  }
});

bot.callbackQuery(/^food-edit:(.+)$/, async (ctx) => {
  const pending = pendingFood.get(ctx.match[1]);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Эта карточка устарела (возможно, бот перезапускался)' });
    return;
  }
  pendingFoodEdit = { key: ctx.match[1], meal: pending.meal, matches: pending.matches };
  await ctx.answerCallbackQuery({ text: 'Жду поправку' });
  await ctx.reply('✏️ Пришли поправку текстом или голосом: «борщ 400 грамм, тосты убери».');
});

async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; remotePath: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл из Telegram: HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), remotePath: file.file_path };
}

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Привет! Я — инбокс очков Rokid.\n' +
      '🎤 Голосовое → разберу встречу, еду или заметку\n' +
      '📷 Фото еды → определю блюда и порции; штрихкод на упаковке — найду продукт по нему\n' +
      '🔎 Кнопка «Штрихкод» (или /barcode) → следующее фото только по штрихкоду\n' +
      '✍️ Текст → то же, что и голосовое',
    { reply_markup: MAIN_KEYBOARD },
  );
});

bot.command(['barcode', 'barkode', 'shtrihkod'], async (ctx) => {
  const typed = parseBarcodeText((ctx.match ?? '').trim());
  if (typed) {
    if (!fsLinked()) {
      await ctx.reply('Сначала привяжи аккаунт: /fatsecret_link');
      return;
    }
    try {
      const reply =
        (await foodFromBarcode(typed.code, typed.caption)) ??
        { text: `🔎 По штрихкоду ${typed.code} ничего нет ни в FatSecret, ни в Open Food Facts — опиши словами, что съел.` };
      await ctx.reply(reply.text, { reply_markup: reply.keyboard });
    } catch (error) {
      logError('barcode-command', error);
      await ctx.reply(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  await ctx.reply(armBarcodeMode(), { reply_markup: MAIN_KEYBOARD });
});

bot.command('notes', async (ctx) => {
  await ctx.reply(notesReply(), { reply_markup: MAIN_KEYBOARD });
});

bot.command('fatsecret_link', async (ctx) => {
  try {
    const { authorizeUrl } = await fsStartLink();
    await ctx.reply(
      `Открой ссылку, разреши доступ и пришли PIN командой /fatsecret_pin <код>:\n${authorizeUrl}`,
    );
  } catch (error) {
    logError('fatsecret_link', error);
    await ctx.reply(`Не смогла запросить ссылку у FatSecret: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.command('fatsecret_pin', async (ctx) => {
  const pin = (ctx.match ?? '').trim();
  if (!pin) {
    await ctx.reply('Нужен код: /fatsecret_pin 123456');
    return;
  }
  try {
    await fsFinishLink(pin);
    await ctx.reply('✅ Аккаунт FatSecret привязан — теперь могу писать в твой дневник.');
  } catch (error) {
    logError('fatsecret_pin', error);
    await ctx.reply(`Не смогла привязать аккаунт: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Запись длиннее порога — встреча: расшифровка частями и саммари вместо
// разбора намерения.
async function handleMeetingAudio(
  ctx: { reply: (text: string) => Promise<unknown> },
  media: { file_id: string; file_unique_id: string; duration?: number },
): Promise<void> {
  const minutes = Math.max(1, Math.round((media.duration ?? 0) / 60));
  await ctx.reply(`🎙 Запись на ${minutes} мин — делаю саммари встречи, это займёт несколько минут…`);
  try {
    const { buffer, remotePath } = await downloadTelegramFile(media.file_id);
    const audioPath = tmpAudioPath(media.file_unique_id, remotePath);
    await writeFile(audioPath, buffer);
    try {
      const transcript = await transcribeLong(audioPath);
      if (!transcript) {
        await ctx.reply('Не удалось разобрать запись — она пустая или слишком шумная.');
        return;
      }
      const summary = await summarizeMeeting(transcript);
      // Лимит сообщения Telegram — 4096 символов: длинное саммари шлём частями.
      for (const part of splitTranscript(summary, 4000)) {
        await ctx.reply(part);
      }
    } finally {
      await rm(audioPath, { force: true });
    }
  } catch (error) {
    logError('meeting', error);
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(
      message.includes('file is too big')
        ? 'Файл больше 20 МБ — это лимит Telegram для ботов. Ужми запись (mp3 48 кбит/с — ~3 часа в 20 МБ) и пришли ещё раз.'
        : `Ошибка саммари: ${message}`,
    );
  }
}

bot.on(['message:voice', 'message:audio'], async (ctx) => {
  const media = ctx.message.voice ?? ctx.message.audio;
  if (!media) return;
  if ((media.duration ?? 0) > MEETING_AUDIO_THRESHOLD_SECONDS) {
    await handleMeetingAudio(ctx, media);
    return;
  }
  await ctx.reply('Слушаю…');
  try {
    const { buffer, remotePath } = await downloadTelegramFile(media.file_id);
    const audioPath = tmpAudioPath(media.file_unique_id, remotePath);
    await writeFile(audioPath, buffer);
    try {
      log('voice:', `${media.duration ?? '?'}s`);
      const text = await transcribe(audioPath);
      log('stt:', text);
      if (!text) {
        await ctx.reply('Не удалось разобрать речь — запись пустая или слишком шумная.');
        return;
      }
      const edited = await maybeApplyFoodEdit(text);
      if (edited) {
        await ctx.reply(`Расшифровка: «${text}»\n\n${edited.text}`, { reply_markup: edited.keyboard });
        return;
      }
      const intent = await routeText(text, new Date());
      log('intent:', JSON.stringify(intent));
      const reply = await applyIntent(intent);
      await ctx.reply(`Расшифровка: «${text}»\n\n${reply.text}`, { reply_markup: reply.keyboard });
    } finally {
      await rm(audioPath, { force: true });
    }
  } catch (error) {
    logError('voice', error);
    await ctx.reply(`Ошибка обработки: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.on('message:photo', async (ctx) => {
  await ctx.reply('Смотрю на фото…');
  try {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const { buffer } = await downloadTelegramFile(largest.file_id);
    // Подпись к фото («творожные сливки 320 грамм») — самый надёжный сигнал:
    // без неё модель гадает по снимку, часто тёмному ракурсу этикетки.
    const caption = ctx.message.caption?.trim();
    const armed = barcodeModeArmed;
    barcodeModeArmed = false;
    const reply = await foodFromPhoto(buffer.toString('base64'), caption || undefined, armed);
    await ctx.reply(reply.text, { reply_markup: reply.keyboard });
  } catch (error) {
    logError('photo', error);
    await ctx.reply(`Ошибка обработки фото: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Список для меню команд Telegram (автодополнение по «/») и для ответа на
// незнакомую команду — чтобы опечатка вроде /barkode не уезжала в заметки.
export const BOT_COMMANDS = [
  { command: 'barcode', description: 'Следующее фото — только по штрихкоду (или /barcode <цифры>)' },
  { command: 'notes', description: 'Последние заметки' },
  { command: 'fatsecret_link', description: 'Привязать аккаунт FatSecret' },
  { command: 'start', description: 'Что умеет бот' },
];

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text === BUTTON_BARCODE) {
    await ctx.reply(armBarcodeMode(), { reply_markup: MAIN_KEYBOARD });
    return;
  }
  if (text === BUTTON_PHOTO) {
    barcodeModeArmed = false;
    await ctx.reply('📷 Жду фото еды — распознаю блюда по снимку (штрихкод на упаковке тоже проверю).', {
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }
  if (text === BUTTON_NOTES) {
    await ctx.reply(notesReply(), { reply_markup: MAIN_KEYBOARD });
    return;
  }
  if (text.startsWith('/')) {
    await ctx.reply(`Не знаю такой команды. Есть: ${BOT_COMMANDS.map((c) => `/${c.command}`).join(', ')}`, {
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }
  try {
    const edited = await maybeApplyFoodEdit(ctx.message.text);
    if (edited) {
      await ctx.reply(edited.text, { reply_markup: edited.keyboard });
      return;
    }
    // Штрихкод цифрами — запасной путь, когда с фото он не читается.
    const typed = parseBarcodeText(ctx.message.text);
    if (typed && fsLinked()) {
      const reply =
        (await foodFromBarcode(typed.code, typed.caption)) ??
        { text: `🔎 По штрихкоду ${typed.code} ничего нет ни в FatSecret, ни в Open Food Facts — опиши словами, что съел.` };
      await ctx.reply(reply.text, { reply_markup: reply.keyboard });
      return;
    }
    const intent = await routeText(ctx.message.text, new Date());
    log('intent:', JSON.stringify(intent));
    const reply = await applyIntent(intent);
    await ctx.reply(reply.text, { reply_markup: reply.keyboard });
  } catch (error) {
    logError('text', error);
    await ctx.reply(`Ошибка разбора: ${error instanceof Error ? error.message : String(error)}`);
  }
});
