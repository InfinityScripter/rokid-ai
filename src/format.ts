import type { FoodMatch, FoodMeal } from './food.js';
import type { Intent } from './router.js';

type CalendarEventFields = {
  title: string;
  start: string;
  durationMinutes: number;
  calendar: 'work' | 'personal';
  location?: string;
};

export function formatEventLine(event: CalendarEventFields): string {
  const when = new Date(event.start).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const calendar = event.calendar === 'work' ? 'рабочий' : 'личный';
  const place = event.location ? `, 📍 ${event.location}` : '';
  return `«${event.title}» — ${when}, ${event.durationMinutes} мин (${calendar})${place}`;
}

// Этикеточные калории (Open Food Facts) рядом с аналогом из FatSecret —
// чтобы расхождение было видно до записи, а не после.
function labelLine(m: FoodMatch): string {
  if (!m.labelKcalPer100g || !m.grams) return '';
  return ` (по этикетке ~${Math.round((m.labelKcalPer100g * m.grams) / 100)} ккал)`;
}

// «1 позицию», «4 позиции», «5 позиций».
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} ${forms[2]}`;
  if (last === 1) return `${n} ${forms[0]}`;
  if (last >= 2 && last <= 4) return `${n} ${forms[1]}`;
  return `${n} ${forms[2]}`;
}

// dayLabel — «вчера, 4 сентября», когда еда пишется не на календарный
// сегодняшний день; за сегодня подпись не нужна.
export function formatFoodCard(meal: FoodMeal, matches: FoodMatch[], dayLabel?: string): string {
  const meals = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', other: 'перекус' };
  const lines = matches.map((m) =>
    m.food
      ? `• ${m.name} (${m.amount}) → ${m.food.foodName}${m.grams ? `, ${m.grams} г` : ''} — ${Math.round(m.calories ?? 0)} ккал${labelLine(m)}`
      : `• ${m.name} (${m.amount}) — ${m.note}`,
  );
  const total = matches.reduce((sum, m) => sum + (m.calories ?? 0), 0);
  const title = dayLabel ? `🍽 ${meals[meal]}, ${dayLabel}:` : `🍽 ${meals[meal]}:`;
  return [title, ...lines, `Итого: ${Math.round(total)} ккал`, 'powered by fatsecret'].join('\n');
}

function skippedLine(skipped: string[]): string[] {
  return skipped.length > 0 ? [`⚠️ Пропустила: ${skipped.join('; ')}`] : [];
}

export function formatIntent(intent: Intent): string {
  switch (intent.intent) {
    case 'calendar_event': {
      const lines = intent.events.map((event) => `📅 ${formatEventLine(event)}`);
      if (intent.uncertain.length > 0) {
        lines.push(`⚠️ Не поняла: ${intent.uncertain.join('; ')}`, 'В календарь НЕ записала — уточни и надиктуй ещё раз.');
      }
      lines.push(...skippedLine(intent.skipped));
      return lines.join('\n');
    }
    // Недостижимо: food_log перехватывается в applyIntent (showFoodCard) до
    // вызова formatIntent — ветка нужна только для exhaustiveness-проверки TS.
    case 'food_log':
      return '';
    case 'meeting_audio':
      return (
        `🎙 Похоже на разговор про встречу: «${intent.topic}». ` +
        'Пришли саму запись голосовым или аудиофайлом (длиннее 3 минут) — сделаю саммари.'
      );
    case 'other':
      return [
        `🤷 Не поняла, что сделать с «${intent.text}». Умею: встречи в календарь, еду в FatSecret ` +
          '(голосом, текстом, фото, штрихкод), саммари записи, повестку («что у меня сегодня») ' +
          'и итоги дня по еде («сколько я сегодня съел»).',
        ...skippedLine(intent.skipped),
      ].join('\n');
    case 'food_summary':
      return '📊 Считаю итоги дня…';
    // Обычно перехватываются в applyIntent до форматирования.
    case 'cancel_last':
      return '↩️ Отменяю последнюю запись…';
    case 'agenda':
      return `📅 Смотрю ${intent.period}…`;
  }
}
