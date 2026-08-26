import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

// «Проба зрения»: очки показывают 40 карточек (4 размера × 2 начертания ×
// 5 зон, glasses-app/vision/TestPlan.kt) и шлют ответы на POST /vision/report.
// Профиль считает и хранит сервер — очки только показывают вердикт, поэтому
// арифметика здесь чистая и покрыта тестами (vision.test.ts).
// Модуль восстановлен по контракту использования (inbox.ts, VisionApi.kt,
// ApiClient.visionProfile): оригинал не был закоммичен. Если рабочая копия
// на VDS отличается — её вариант главнее, закоммитить поверх этого.

export const ZONES = ['center', 'top', 'bottom', 'left', 'right'] as const;
export type Zone = (typeof ZONES)[number];

export type VisionAnswer = { size: number; bold: boolean; zone: Zone; read: boolean };
export type VisionProfile = { size: number; bold: boolean; zone: Zone; updatedAt: string };
export type VisionResult = {
  profile: VisionProfile;
  report: string;
  screen: { title: string; text: string };
};

const ZONE_RU: Record<Zone, string> = {
  center: 'центр',
  top: 'верх',
  bottom: 'низ',
  left: 'слева',
  right: 'справа',
};

export function analyzeVision(answers: VisionAnswer[]): VisionResult {
  const sizes = [...new Set(answers.map((a) => a.size))].sort((a, b) => a - b);

  const allRead = (size: number, bold: boolean): boolean => {
    const group = answers.filter((a) => a.size === size && a.bold === bold);
    return group.length > 0 && group.every((a) => a.read);
  };

  // Комфорт — самый мелкий размер, прочитанный во всех зонах; жирность
  // «бесплатна» для места на экране, поэтому жирный мелкий лучше обычного
  // крупного. Совсем ничего не читается целиком — максимально крупно и жирно.
  let size = sizes[sizes.length - 1];
  let bold = true;
  for (const candidate of sizes) {
    if (allRead(candidate, false)) {
      size = candidate;
      bold = false;
      break;
    }
    if (allRead(candidate, true)) {
      size = candidate;
      bold = true;
      break;
    }
  }

  const zoneReads = (zone: Zone) => answers.filter((a) => a.zone === zone && a.read).length;
  const zoneTotal = (zone: Zone) => answers.filter((a) => a.zone === zone).length;
  const zonesPresent = ZONES.filter((z) => zoneTotal(z) > 0);
  // При равенстве выигрывает более ранняя зона списка — центр прежде всего.
  const zone = zonesPresent.reduce((best, z) => (zoneReads(z) > zoneReads(best) ? z : best), zonesPresent[0]);

  const profile: VisionProfile = { size, bold, zone, updatedAt: new Date().toISOString() };

  const bySize = sizes
    .map((s) => {
      const group = answers.filter((a) => a.size === s);
      return `${s} — ${group.filter((a) => a.read).length}/${group.length}`;
    })
    .join(', ');
  const report = [
    `👁 Проба зрения: ${answers.length} карточек.`,
    `Комфортный размер: ${size}, ${bold ? 'жирный' : 'обычный'}.`,
    `Лучшая зона: ${ZONE_RU[zone]} (${zoneReads(zone)}/${zoneTotal(zone)}).`,
    `По размерам: ${bySize}.`,
  ].join('\n');

  const screen = {
    title: 'ГОТОВО',
    text: `Размер ${size}${bold ? ', жирный' : ''}\nЗона: ${ZONE_RU[zone]}`,
  };

  return { profile, report, screen };
}

function profilePath(): string {
  return config.SQLITE_PATH.replace(/\.sqlite$/, '.vision.json');
}

export function loadProfile(): VisionProfile | null {
  try {
    const parsed = JSON.parse(readFileSync(profilePath(), 'utf8')) as VisionProfile;
    return typeof parsed.size === 'number' && ZONES.includes(parsed.zone) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: VisionProfile): void {
  mkdirSync(path.dirname(profilePath()), { recursive: true });
  writeFileSync(profilePath(), JSON.stringify(profile, null, 2));
}
