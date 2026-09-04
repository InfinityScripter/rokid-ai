import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FoodMatch, FoodMeal } from './food.js';

// Карточки еды с кнопками, ожидающая правка и режим «штрихкод» — на диске:
// деплой перезапускает бота на каждый мерж в main, и «✅ Записать» на карточке
// минутной давности отвечало «устарела» всплывашкой, которую легко не
// заметить. Карточек не больше MAX_CARDS и не старше TTL — файл не растёт.

// date — дневниковый день YYYY-MM-DD; нет у карточек, сохранённых до этого
// поля: тогда день — сегодняшний на момент записи.
export type PendingCard = { meal: FoodMeal; matches: FoodMatch[]; header?: string; date?: string; createdAt: string };
export type PendingEdit = { key: string; meal: FoodMeal; matches: FoodMatch[]; date?: string };
type CardInput = Omit<PendingCard, 'createdAt'> & { createdAt?: string };
type StateFile = { cards: Record<string, PendingCard>; edit: PendingEdit | null; barcodeArmed: boolean };

const MAX_CARDS = 50;
const CARD_TTL_MS = 24 * 60 * 60 * 1000;

export class PendingState {
  private data: StateFile;

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.data = load(file);
    if (this.prune()) this.save();
  }

  getCard(key: string): PendingCard | undefined {
    if (this.prune()) this.save();
    return this.data.cards[key];
  }

  setCard(key: string, card: CardInput): void {
    this.data.cards[key] = { ...card, createdAt: card.createdAt ?? this.now().toISOString() };
    this.prune();
    this.save();
  }

  deleteCard(key: string): boolean {
    if (!(key in this.data.cards)) return false;
    delete this.data.cards[key];
    if (this.data.edit?.key === key) this.data.edit = null;
    this.save();
    return true;
  }

  get edit(): PendingEdit | null {
    return this.data.edit;
  }

  setEdit(edit: PendingEdit | null): void {
    this.data.edit = edit;
    this.save();
  }

  get barcodeArmed(): boolean {
    return this.data.barcodeArmed;
  }

  setBarcodeArmed(armed: boolean): void {
    this.data.barcodeArmed = armed;
    this.save();
  }

  // Просроченные — вон, из остальных остаются MAX_CARDS самых свежих; правка
  // к исчезнувшей карточке тоже снимается. true — что-то изменилось.
  private prune(): boolean {
    const cutoff = this.now().getTime() - CARD_TTL_MS;
    const fresh = Object.entries(this.data.cards)
      .filter(([, card]) => Date.parse(card.createdAt) >= cutoff)
      .sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))
      .slice(0, MAX_CARDS);
    let changed = false;
    if (fresh.length !== Object.keys(this.data.cards).length) {
      this.data.cards = Object.fromEntries(fresh);
      changed = true;
    }
    if (this.data.edit && !(this.data.edit.key in this.data.cards)) {
      this.data.edit = null;
      changed = true;
    }
    return changed;
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

function load(file: string): StateFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>;
    return { cards: raw.cards ?? {}, edit: raw.edit ?? null, barcodeArmed: raw.barcodeArmed ?? false };
  } catch {
    return { cards: {}, edit: null, barcodeArmed: false };
  }
}
