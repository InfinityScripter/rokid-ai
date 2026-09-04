import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

// Дневная норма: ккал обязательно, БЖУ по желанию. В API FatSecret цели не
// отдаются, поэтому храним свою (*.goal.json) — командой /goal или голосом.

export type Goal = { kcal: number; protein?: number; fat?: number; carbs?: number };

function goalPath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.goal.json');
}

export function loadGoal(): Goal | null {
  try {
    const raw = JSON.parse(readFileSync(goalPath(), 'utf8')) as Partial<Goal>;
    return typeof raw.kcal === 'number' && raw.kcal > 0 ? (raw as Goal) : null;
  } catch {
    return null;
  }
}

export function saveGoal(goal: Goal | null): void {
  mkdirSync(path.dirname(goalPath()), { recursive: true });
  writeFileSync(goalPath(), JSON.stringify(goal, null, 2));
}

// «2200», «2200 ккал», «2200 б150 ж70 у200», «2200 Б 150 Ж 70 У 200»;
// «0», «off», «нет» — убрать норму. Мусор → null.
export function parseGoal(text: string): Goal | null | 'invalid' {
  const arg = text.trim().toLowerCase();
  if (/^(0|off|выкл|нет|убрать|сброс)$/.test(arg)) return null;
  const kcal = arg.match(/^(\d{3,5})(?:\s*ккал)?/);
  if (!kcal) return 'invalid';
  const goal: Goal = { kcal: Number(kcal[1]) };
  if (goal.kcal < 500 || goal.kcal > 10_000) return 'invalid';
  const macro = (letter: string): number | undefined => {
    const m = arg.match(new RegExp(`(?:^|[\\s,;])${letter}\\s*:?\\s*(\\d{1,4})(?:\\s*г)?(?=$|[\\s,;])`, 'u'));
    return m ? Number(m[1]) : undefined;
  };
  const protein = macro('б');
  const fat = macro('ж');
  const carbs = macro('у');
  if (protein !== undefined) goal.protein = protein;
  if (fat !== undefined) goal.fat = fat;
  if (carbs !== undefined) goal.carbs = carbs;
  return goal;
}

export function formatGoal(goal: Goal): string {
  const macros = [
    goal.protein !== undefined ? `Б ${goal.protein} г` : null,
    goal.fat !== undefined ? `Ж ${goal.fat} г` : null,
    goal.carbs !== undefined ? `У ${goal.carbs} г` : null,
  ].filter(Boolean);
  return `${goal.kcal} ккал${macros.length > 0 ? ` · ${macros.join(' · ')}` : ''}`;
}

// «🎯 Норма 2200 ккал: осталось 750» / «перебор на 120»; с БЖУ — «Б 78/150».
export function goalLine(
  goal: Goal,
  totals: { calories: number; protein: number; fat: number; carbs: number },
): string {
  const left = Math.round(goal.kcal - totals.calories);
  const kcalPart = left >= 0 ? `осталось ${left} ккал` : `перебор на ${-left} ккал`;
  const macros = [
    goal.protein !== undefined ? `Б ${Math.round(totals.protein)}/${goal.protein}` : null,
    goal.fat !== undefined ? `Ж ${Math.round(totals.fat)}/${goal.fat}` : null,
    goal.carbs !== undefined ? `У ${Math.round(totals.carbs)}/${goal.carbs}` : null,
  ].filter(Boolean);
  return `🎯 Норма ${goal.kcal} ккал: ${kcalPart}${macros.length > 0 ? ` · ${macros.join(' · ')}` : ''}`;
}
