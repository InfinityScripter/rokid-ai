import type { Intent } from './router.js';

type CalendarEventFields = {
  title: string;
  start: string;
  durationMinutes: number;
  calendar: 'work' | 'personal';
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
  return `«${event.title}» — ${when}, ${event.durationMinutes} мин (${calendar})`;
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
    case 'food_log': {
      const meals = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', other: 'перекус' };
      const items = intent.items.map((i) => `• ${i.name} — ${i.amount}`).join('\n');
      return [`🍽 Еда (${meals[intent.meal]}):`, items, '(запись в дневник подключим на этапе 4)', ...skippedLine(intent.skipped)].join(
        '\n',
      );
    }
    case 'meeting_audio':
      return `🎙 Похоже на запись встречи: «${intent.topic}». Конвейер саммари подключим на этапе 5.`;
    case 'note':
      return [`📝 Заметка: ${intent.text}`, ...skippedLine(intent.skipped)].join('\n');
  }
}
