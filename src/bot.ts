import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';

import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';

import {
  hasBarcodeKeyword,
  parseBarcodeText,
  readBarcodeFromPhoto,
  stripBarcodeKeyword,
  type BarcodeRead,
} from './barcode.js';
import { caldavListEvents } from './caldav.js';
import { config } from './config.js';
import { diaryDate, fsFinishLink, fsLinked, fsStartLink, isInvalidTokenError, mskDate, shiftDate } from './fatsecret.js';
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
import { formatEventLine, formatFoodCard, formatIntent, pluralRu } from './format.js';
import { formatGoal, loadGoal, parseGoal, saveGoal, withKcal, type Goal } from './goal.js';
import { log, logError } from './log.js';
import { splitTranscript, summarizeMeeting, transcribeLong } from './meeting.js';
import { PendingState } from './pending.js';
import {
  dayLabel,
  dayTotalsLine,
  foodDaySummary,
  foodWeekSummary,
  parseDayArg,
  summaryKeyboard,
  weekKeyboard,
} from './reminders.js';
import type { Intent } from './router.js';
import { parseFoodPhoto, routeText } from './router.js';
import { tmpAudioPath, transcribe } from './stt.js';

const MEETING_AUDIO_THRESHOLD_SECONDS = 180;

// Кнопки календаря живут в памяти: после перезапуска бота отвечают
// «устарело», это осознанный компромисс. Карточки еды, ожидающая правка
// («✏️ Поправить»: следующее сообщение — правка, а не новая фраза) и режим
// «штрихкод» — на диске (pending.ts): деплой перезапускает бота на каждый
// мерж, и «✅ Записать» на карточке минутной давности не должно молча умирать.
const undoable = new Map<string, UndoRef[]>();
const pendingWork = new Map<string, CalendarEventInput[]>();
const state = new PendingState(config.SQLITE_PATH.replace(/\.sqlite$/, '.pending.json'));
// Ключ последней записи — для голосовой команды «отмени последнюю запись».
let lastUndoKey: string | null = null;

// Постоянная клавиатура под полем ввода — выбор режима одним тапом вместо
// команды. Тексты кнопок перехватываются до роутера (см. message:text).
const BUTTON_BARCODE = '🔎 Штрихкод';
const BUTTON_PHOTO = '📷 Фото еды';
const BUTTON_SUMMARY = '📊 Итоги дня';
const BUTTON_WEEK = '📈 Неделя';
const BUTTON_GOAL = '🎯 Норма';
const BUTTON_HELP = '❓ Помощь';
// Постоянная клавиатура — всё, что делается чаще раза в неделю, без команд.
const MAIN_KEYBOARD = new Keyboard()
  .text(BUTTON_BARCODE)
  .text(BUTTON_PHOTO)
  .row()
  .text(BUTTON_SUMMARY)
  .text(BUTTON_WEEK)
  .row()
  .text(BUTTON_GOAL)
  .text(BUTTON_HELP)
  .resized()
  .persistent();

function linkKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🔗 Привязать FatSecret', 'link:start');
}

// Привязка FatSecret без команд: кнопка → ссылка → PIN обычным сообщением.
// Флаг в памяти: привязка — разовое дело, перезапуск между шагами маловероятен.
let linkPending = false;

async function startLinkReply(): Promise<IntentReply> {
  try {
    const { authorizeUrl } = await fsStartLink();
    linkPending = true;
    return {
      text:
        `Открой ссылку, разреши доступ и пришли PIN обычным сообщением (просто цифры):\n${authorizeUrl}`,
    };
  } catch (error) {
    logError('fatsecret_link', error);
    return { text: `Не смогла запросить ссылку у FatSecret: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function finishLinkReply(pin: string): Promise<IntentReply> {
  try {
    await fsFinishLink(pin);
    linkPending = false;
    return {
      text: '✅ Аккаунт FatSecret привязан — теперь могу писать в твой дневник и считать итоги.',
      keyboard: new InlineKeyboard().text('🎯 Норма', 'goal:show').text('📊 Итоги дня', `summary:${diaryDate(new Date())}`),
    };
  } catch (error) {
    logError('fatsecret_pin', error);
    return { text: `Не смогла привязать аккаунт: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function helpReply(): IntentReply {
  const linked = fsLinked();
  const text = [
    'Что умею:',
    '🎤 Голосовое или текст → встречу в календарь, еду в FatSecret («на обед борщ и два тоста»),',
    '   «сколько я сегодня съел», «что я ел вчера», «поставь норму 2200», «отмени последнюю запись», «что у меня завтра»',
    '📷 Фото еды → карточка с блюдами и порциями; штрихкод на упаковке найду сама',
    '🔎 Штрихкод → следующее фото только по коду (или /barcode 4600605030288 всю банку)',
    '📊 Итоги дня → ккал, БЖУ, остаток до нормы; кнопки ◀️ ▶️ по дням (или /summary вчера)',
    '📈 Неделя → итоги по дням за 7 дней и среднее',
    '🎯 Норма → кнопками или /goal 2200 (с БЖУ: /goal 2200 б150 ж70 у200)',
    '🌙 До 04:00 еда пишется на вчера; «вчера на ужин …» тоже понимаю',
    '⏰ Сама напомню в 14:30 и 21:30 по Москве, что записано и чего не хватает',
    linked ? '🔗 FatSecret привязан ✓' : '🔗 FatSecret не привязан — без него еда не запишется',
  ].join('\n');
  const keyboard = new InlineKeyboard().text('🎯 Норма', 'goal:show').text('📊 Итоги дня', `summary:${diaryDate(new Date())}`);
  if (!linked) keyboard.row().text('🔗 Привязать FatSecret', 'link:start');
  return { text, keyboard };
}

function armBarcodeMode(): string {
  state.setBarcodeArmed(true);
  return (
    '🔎 Жду фото штрихкода — следующий снимок разберу только по нему, без угадывания. ' +
    'Или сразу цифрами: /barcode 4600605030288 всю банку'
  );
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

// Дата на карточке: подпись только если день не календарный сегодняшний
// (ночью после полуночи еда идёт на вчера — это видно), кнопка переключает
// между сегодня и вчера.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(date: string | undefined): string | undefined {
  return date && ISO_DATE.test(date) ? date : undefined;
}

function cardDayLabel(date: string | undefined): string | undefined {
  const today = mskDate(new Date());
  return date && date !== today ? dayLabel(date, today) : undefined;
}

function dateToggle(date: string | undefined): { label: string; target: string } {
  const today = mskDate(new Date());
  const current = date ?? today;
  return current === today
    ? { label: '📅 Это было вчера', target: shiftDate(today, -1) }
    : { label: '📅 Это сегодня', target: today };
}

function foodCardKeyboard(key: string, meal: FoodMeal, date?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('✅ Записать', `food-yes:${key}`)
    .text('✏️ Поправить', `food-edit:${key}`)
    .text('❌ Не надо', `food-no:${key}`)
    .row();
  for (const button of MEAL_BUTTONS) {
    keyboard.text(button.meal === meal ? `${button.label} ✓` : button.label, `food-meal:${key}:${button.meal}`);
  }
  const toggle = dateToggle(date);
  return keyboard.row().text(toggle.label, `food-date:${key}:${toggle.target}`);
}

// header — строка «🔎 Штрихкод …» над карточкой; хранится вместе с ней,
// чтобы не пропадать при перерисовке (смена приёма пищи).
function cardText(meal: FoodMeal, matches: FoodMatch[], header?: string, date?: string): string {
  const body = formatFoodCard(meal, matches, cardDayLabel(date));
  return header ? `${header}\n\n${body}` : body;
}

// date — дневниковый день записи; по умолчанию сегодняшний с поправкой на
// ночь (до 04:00 — ещё вчера).
function buildFoodCard(meal: FoodMeal, matches: FoodMatch[], opts: { header?: string; date?: string } = {}): IntentReply {
  if (matches.length === 0) {
    return { text: 'Не разобрала еду — пришли фото с подписью, что это и сколько, или надиктуй.' };
  }
  const key = randomUUID();
  const date = opts.date ?? diaryDate(new Date());
  state.setCard(key, { meal, matches, date, ...(opts.header ? { header: opts.header } : {}) });
  return { text: cardText(meal, matches, opts.header, date), keyboard: foodCardKeyboard(key, meal, date) };
}

// Карточки нет (старше суток, вытеснена или бот её потерял): всплывашка
// исчезает за секунду, поэтому ещё и сообщением — иначе «нажал, и ничего».
async function staleCard(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Эта карточка устарела' });
  await ctx.reply('Эта карточка уже неактуальна — пришли фото или опиши еду ещё раз, соберу новую.');
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
  const why = outcome.kind === 'openfoodfacts' && outcome.fatsecretNote ? ` (${outcome.fatsecretNote})` : '';
  const how =
    outcome.kind === 'fatsecret'
      ? `🔎 Штрихкод ${code}: продукт из базы FatSecret.`
      : `🔎 Штрихкод ${code}: в FatSecret нет${why}, по этикетке (Open Food Facts) это «${outcome.product.brand ? `${outcome.product.brand} ` : ''}${outcome.product.name}» — подобрала аналог для дневника.`;
  return buildFoodCard(mealByMoscowTime(new Date()), [outcome.match], { header: how });
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

// Итоги дня по дневнику FatSecret — кнопка, /summary и голосом; под ними
// кнопки соседних дней и недели.
async function daySummaryReply(date?: string): Promise<IntentReply> {
  if (!fsLinked()) return { text: 'Сначала привяжи аккаунт FatSecret — одна кнопка и PIN.', keyboard: linkKeyboard() };
  const today = diaryDate(new Date());
  const day = date ?? today;
  return { text: await foodDaySummary(day, 'manual'), keyboard: summaryKeyboard(day, today) };
}

// Панель нормы: текущая норма, остаток за сегодня и кнопки −100/+100,
// пресеты, «убрать». Точнее или с БЖУ — текстом (/goal 2200 б150 ж70 у200).
const GOAL_PRESETS = [1800, 2000, 2200, 2500];

function goalKeyboard(goal: Goal | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (goal) keyboard.text('−100', 'goal:adj:-100').text('+100', 'goal:adj:100').row();
  for (const preset of GOAL_PRESETS) {
    keyboard.text(goal?.kcal === preset ? `${preset} ✓` : String(preset), `goal:set:${preset}`);
  }
  keyboard.row();
  if (goal) keyboard.text('✖️ Убрать норму', 'goal:off');
  keyboard.text('📊 Итоги дня', `summary:${diaryDate(new Date())}`);
  if (!fsLinked()) keyboard.row().text('🔗 Привязать FatSecret', 'link:start');
  return keyboard;
}

async function goalPanel(): Promise<IntentReply> {
  const goal = loadGoal();
  const totals = goal && fsLinked() ? await dayTotalsLine(diaryDate(new Date())) : null;
  const text = [
    goal ? `🎯 Норма: ${formatGoal(goal)}.` : '🎯 Норма не задана — выбери кнопкой, и в итогах появится остаток до неё.',
    totals,
    'Точнее или с БЖУ — текстом: /goal 2150 или /goal 2200 б150 ж70 у200.',
  ]
    .filter(Boolean)
    .join('\n');
  return { text, keyboard: goalKeyboard(goal) };
}

// «/goal 2200 б150 ж70 у200» — задать, «/goal off» — убрать, без аргумента —
// панель с кнопками.
async function setGoalReply(arg: string): Promise<IntentReply> {
  if (!arg.trim()) return goalPanel();
  const goal = parseGoal(arg);
  if (goal === 'invalid') {
    return {
      text: 'Не поняла норму. Пример: /goal 2200 или /goal 2200 б150 ж70 у200; убрать — /goal off.',
      keyboard: goalKeyboard(loadGoal()),
    };
  }
  saveGoal(goal);
  return goalPanel();
}

async function showFoodCard(
  meal: FoodMeal,
  items: { name: string; amount: string; query: string }[],
  date?: string,
): Promise<IntentReply> {
  if (!fsLinked()) {
    return { text: 'Сначала привяжи аккаунт FatSecret — одна кнопка и PIN.', keyboard: linkKeyboard() };
  }
  const matches = await matchFoodItems(items);
  return buildFoodCard(meal, matches, { date });
}

// Ожидающая правка перехватывает сообщение до роутера: пересобираем карточку
// по фразе и заменяем старую (её ключ гасим, чтобы старые кнопки не жили).
async function maybeApplyFoodEdit(text: string): Promise<IntentReply | null> {
  const edit = state.edit;
  if (!edit) return null;
  state.setEdit(null);
  state.deleteCard(edit.key);
  const items = await reviseFoodItems(edit.matches, text);
  if (items.length === 0) {
    return { text: '❌ Ок, убрала всё — карточку закрыла.' };
  }
  const matches = await matchFoodItems(items);
  return buildFoodCard(edit.meal, matches, { date: edit.date });
}

export async function applyIntent(intent: Intent): Promise<IntentReply> {
  if (intent.intent === 'agenda') {
    return showAgenda(intent.from, intent.to, intent.period);
  }
  if (intent.intent === 'cancel_last') {
    return cancelLast();
  }
  if (intent.intent === 'food_log') {
    return showFoodCard(intent.meal, intent.items, validDate(intent.date));
  }
  if (intent.intent === 'food_summary') {
    return daySummaryReply(validDate(intent.date));
  }
  if (intent.intent === 'food_goal') {
    return setGoalReply(String(intent.kcal));
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
  const pending = state.getCard(ctx.match[1]);
  if (!pending) {
    await staleCard(ctx);
    return;
  }
  state.deleteCard(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'Записываю…' });

  // Имя записи — слова владельца («говяжий фарш»), а не английское имя из
  // базы: так итоги дня и приложение читаются по-русски. Полдень по Москве —
  // чтобы день записи не сдвинулся ни в какой таймзоне.
  const day = pending.date ?? diaryDate(new Date());
  const entries: BufferedEntry[] = [];
  for (const m of pending.matches) {
    if (!m.food || !m.servingId) continue;
    entries.push({
      foodId: m.food.foodId,
      name: m.name,
      servingId: m.servingId,
      units: m.numberOfUnits,
      meal: pending.meal,
      date: `${day}T12:00:00+03:00`,
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
      const totals = await dayTotalsLine(day);
      await ctx.reply(
        [`✅ Записала в FatSecret ${pluralRu(result.sent, ['позицию', 'позиции', 'позиций'])}.`, totals, 'powered by fatsecret']
          .filter(Boolean)
          .join('\n'),
      );
    }
  } catch (error) {
    logError('food-yes', error);
    await ctx.reply(`Ошибка записи: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.callbackQuery(/^food-no:(.+)$/, async (ctx) => {
  const existed = state.deleteCard(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: existed ? 'Ок, не записываю' : 'Эта карточка устарела' });
  if (existed) await ctx.reply('❌ Еду не записала.');
});

bot.callbackQuery(/^food-meal:([^:]+):(breakfast|lunch|dinner|other)$/, async (ctx) => {
  const key = ctx.match[1];
  const meal = ctx.match[2] as FoodMeal;
  const pending = state.getCard(key);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Эта карточка устарела' });
    return;
  }
  state.setCard(key, { ...pending, meal });
  const edit = state.edit;
  if (edit?.key === key) state.setEdit({ ...edit, meal });
  await ctx.answerCallbackQuery({ text: 'Приём пищи изменила' });
  try {
    await ctx.editMessageText(cardText(meal, pending.matches, pending.header, pending.date), {
      reply_markup: foodCardKeyboard(key, meal, pending.date),
    });
  } catch (error) {
    // Повторное нажатие той же кнопки: Telegram отвергает правку без изменений.
    logError('food-meal', error);
  }
});

bot.callbackQuery(/^food-date:([^:]+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const key = ctx.match[1];
  const date = ctx.match[2];
  const pending = state.getCard(key);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Эта карточка устарела' });
    return;
  }
  state.setCard(key, { ...pending, date });
  const edit = state.edit;
  if (edit?.key === key) state.setEdit({ ...edit, date });
  await ctx.answerCallbackQuery({ text: `Запишу на ${dayLabel(date, mskDate(new Date()))}` });
  try {
    await ctx.editMessageText(cardText(pending.meal, pending.matches, pending.header, date), {
      reply_markup: foodCardKeyboard(key, pending.meal, date),
    });
  } catch (error) {
    logError('food-date', error);
  }
});

bot.callbackQuery(/^summary:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const date = ctx.match[1];
  await ctx.answerCallbackQuery({ text: `Смотрю ${dayLabel(date, diaryDate(new Date()))}…` });
  try {
    await ctx.editMessageText(await foodDaySummary(date, 'manual'), {
      reply_markup: summaryKeyboard(date, diaryDate(new Date())),
    });
  } catch (error) {
    logError('summary-day', error);
  }
});

bot.callbackQuery(/^goal:(show|adj|set|off)(?::(-?\d+))?$/, async (ctx) => {
  const kind = ctx.match[1];
  const value = Number(ctx.match[2] ?? 0);
  if (kind === 'show') {
    await ctx.answerCallbackQuery();
    const panel = await goalPanel();
    await ctx.reply(panel.text, { reply_markup: panel.keyboard });
    return;
  }
  const current = loadGoal();
  const next = kind === 'off' ? null : kind === 'set' ? withKcal(current, value) : withKcal(current, (current?.kcal ?? 2000) + value);
  saveGoal(next);
  await ctx.answerCallbackQuery({ text: next ? `Норма ${next.kcal} ккал` : 'Норму убрала' });
  const panel = await goalPanel();
  try {
    await ctx.editMessageText(panel.text, { reply_markup: panel.keyboard });
  } catch (error) {
    // Тот же пресет второй раз: Telegram отвергает правку без изменений.
    logError('goal', error);
  }
});

bot.callbackQuery('link:start', async (ctx) => {
  await ctx.answerCallbackQuery();
  const reply = await startLinkReply();
  await ctx.reply(reply.text, { reply_markup: reply.keyboard });
});

bot.callbackQuery('summary-week', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Считаю неделю…' });
  try {
    await ctx.editMessageText(await foodWeekSummary(), { reply_markup: weekKeyboard(diaryDate(new Date())) });
  } catch (error) {
    logError('summary-week', error);
  }
});

bot.callbackQuery(/^food-edit:(.+)$/, async (ctx) => {
  const pending = state.getCard(ctx.match[1]);
  if (!pending) {
    await staleCard(ctx);
    return;
  }
  state.setEdit({ key: ctx.match[1], meal: pending.meal, matches: pending.matches, date: pending.date });
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

// /start показывает постоянную клавиатуру (у сообщения одна разметка,
// поэтому inline-кнопки помощи — отдельным сообщением).
bot.command(['start', 'help'], async (ctx) => {
  const help = helpReply();
  await ctx.reply(`Привет! Я — инбокс очков Rokid. Кнопки внизу — всё основное.\n\n${help.text}`, {
    reply_markup: MAIN_KEYBOARD,
  });
  if (help.keyboard) await ctx.reply('Быстрые действия:', { reply_markup: help.keyboard });
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

bot.command(['goal', 'norma'], async (ctx) => {
  const reply = await setGoalReply(String(ctx.match ?? ''));
  await ctx.reply(reply.text, { reply_markup: MAIN_KEYBOARD });
});

bot.command(['summary', 'itogi', 'today'], async (ctx) => {
  const arg = String(ctx.match ?? '').trim();
  const date = parseDayArg(arg, diaryDate(new Date()));
  if (!date) {
    await ctx.reply('Не поняла день. Можно так: /summary вчера, /summary 3 сентября, /summary 2026-09-03.', {
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }
  const reply = await daySummaryReply(date);
  await ctx.reply(reply.text, { reply_markup: reply.keyboard ?? MAIN_KEYBOARD });
});

bot.command('fatsecret_link', async (ctx) => {
  const reply = await startLinkReply();
  await ctx.reply(reply.text, { reply_markup: reply.keyboard });
});

bot.command('fatsecret_pin', async (ctx) => {
  const pin = (ctx.match ?? '').trim();
  if (!pin) {
    await ctx.reply('Нужен код: /fatsecret_pin 123456 (или просто пришли цифры после ссылки)');
    return;
  }
  const reply = await finishLinkReply(pin);
  await ctx.reply(reply.text, { reply_markup: reply.keyboard });
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
    const armed = state.barcodeArmed;
    state.setBarcodeArmed(false);
    const reply = await foodFromPhoto(buffer.toString('base64'), caption || undefined, armed);
    await ctx.reply(reply.text, { reply_markup: reply.keyboard });
  } catch (error) {
    logError('photo', error);
    await ctx.reply(`Ошибка обработки фото: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Список для меню команд Telegram (автодополнение по «/») и для ответа на
// незнакомую команду — чтобы опечатка вроде /barkode не уезжала в роутер.
export const BOT_COMMANDS = [
  { command: 'barcode', description: 'Следующее фото — только по штрихкоду (или /barcode <цифры>)' },
  { command: 'summary', description: 'Итоги дня по еде: ккал, БЖУ, чего не хватает (/summary вчера, 3 сентября)' },
  { command: 'goal', description: 'Дневная норма: /goal 2200 (с БЖУ: /goal 2200 б150 ж70 у200), /goal off' },
  { command: 'fatsecret_link', description: 'Привязать аккаунт FatSecret' },
  { command: 'help', description: 'Что умеет бот и какие есть кнопки' },
  { command: 'start', description: 'Показать кнопки' },
];

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text === BUTTON_BARCODE) {
    await ctx.reply(armBarcodeMode(), { reply_markup: MAIN_KEYBOARD });
    return;
  }
  if (text === BUTTON_PHOTO) {
    state.setBarcodeArmed(false);
    await ctx.reply('📷 Жду фото еды — распознаю блюда по снимку (штрихкод на упаковке тоже проверю).', {
      reply_markup: MAIN_KEYBOARD,
    });
    return;
  }
  if (text === BUTTON_SUMMARY) {
    const reply = await daySummaryReply();
    await ctx.reply(reply.text, { reply_markup: reply.keyboard ?? MAIN_KEYBOARD });
    return;
  }
  if (text === BUTTON_WEEK) {
    if (!fsLinked()) {
      await ctx.reply('Сначала привяжи аккаунт FatSecret — одна кнопка и PIN.', { reply_markup: linkKeyboard() });
      return;
    }
    await ctx.reply(await foodWeekSummary(), { reply_markup: weekKeyboard(diaryDate(new Date())) });
    return;
  }
  if (text === BUTTON_GOAL) {
    const panel = await goalPanel();
    await ctx.reply(panel.text, { reply_markup: panel.keyboard });
    return;
  }
  if (text === BUTTON_HELP) {
    const help = helpReply();
    await ctx.reply(help.text, { reply_markup: help.keyboard });
    return;
  }
  // PIN после ссылки привязки — просто цифры, без команды.
  if (linkPending && /^\d{4,10}$/.test(text)) {
    const reply = await finishLinkReply(text);
    await ctx.reply(reply.text, { reply_markup: reply.keyboard ?? MAIN_KEYBOARD });
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
