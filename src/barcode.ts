import OpenAI from 'openai';
import { readBarcodes } from 'zxing-wasm/full';

import { config } from './config.js';
import { logError } from './log.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

// Штрихкод с фото сначала декодируется по полосам (zxing, WASM — без
// нативных зависимостей, JPEG разбирает сам), и только если декодер ничего
// не нашёл — vision-модель читает цифры под полосами. Модель на идеально
// чётком штрихкоде отвечала «нет», декодер детерминирован. Ошибка чтения на
// одну цифру в любом случае отсекается контрольной суммой.

// Контрольная сумма GTIN (EAN-8, UPC-A/GTIN-12, EAN-13) — единый алгоритм:
// справа налево веса 3,1,3,1…, контрольная цифра дополняет сумму до десятка.
function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

// Строка с цифрами (пробелы и мусор допускаются) → GTIN-13 для FatSecret или
// null, если длина не штрихкодовая или не сходится контрольная цифра.
export function normalizeBarcode(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (![8, 12, 13].includes(digits.length)) return null;
  const body = digits.slice(0, -1);
  if (gtinCheckDigit(body) !== Number(digits[digits.length - 1])) return null;
  return digits.padStart(13, '0');
}

// Первые три цифры GTIN — префикс GS1: страна, где производитель
// зарегистрировал код (не обязательно страна продажи). По нему выбираем
// регион базы FatSecret: параметр region там один на запрос, «по всем
// странам» API не умеет. 02x/04x/2xx — внутренние коды магазинов, 977–999 —
// ISSN/ISBN/купоны: страны у них нет.
const GS1_PREFIXES: [from: number, to: number, region: string][] = [
  [0, 19, 'US'], [30, 39, 'US'], [60, 139, 'US'],
  [300, 379, 'FR'], [380, 380, 'BG'], [383, 383, 'SI'], [385, 385, 'HR'], [387, 387, 'BA'],
  [389, 389, 'ME'], [400, 440, 'DE'], [450, 459, 'JP'], [460, 469, 'RU'], [470, 470, 'KG'],
  [471, 471, 'TW'], [474, 474, 'EE'], [475, 475, 'LV'], [476, 476, 'AZ'], [477, 477, 'LT'],
  [478, 478, 'UZ'], [479, 479, 'LK'], [480, 480, 'PH'], [481, 481, 'BY'], [482, 482, 'UA'],
  [483, 483, 'TM'], [484, 484, 'MD'], [485, 485, 'AM'], [486, 486, 'GE'], [487, 487, 'KZ'],
  [488, 488, 'TJ'], [489, 489, 'HK'], [490, 499, 'JP'], [500, 509, 'GB'], [520, 521, 'GR'],
  [528, 528, 'LB'], [529, 529, 'CY'], [530, 530, 'AL'], [531, 531, 'MK'], [535, 535, 'MT'],
  [539, 539, 'IE'], [540, 549, 'BE'], [560, 560, 'PT'], [569, 569, 'IS'], [570, 579, 'DK'],
  [590, 590, 'PL'], [594, 594, 'RO'], [599, 599, 'HU'], [600, 601, 'ZA'], [603, 603, 'GH'],
  [608, 608, 'BH'], [609, 609, 'MU'], [611, 611, 'MA'], [613, 613, 'DZ'], [616, 616, 'KE'],
  [618, 618, 'CI'], [619, 619, 'TN'], [621, 621, 'SY'], [622, 622, 'EG'], [624, 624, 'LY'],
  [625, 625, 'JO'], [626, 626, 'IR'], [627, 627, 'KW'], [628, 628, 'SA'], [629, 629, 'AE'],
  [640, 649, 'FI'], [690, 699, 'CN'], [700, 709, 'NO'], [729, 729, 'IL'], [730, 739, 'SE'],
  [740, 740, 'GT'], [741, 741, 'SV'], [742, 742, 'HN'], [743, 743, 'NI'], [744, 744, 'CR'],
  [745, 745, 'PA'], [746, 746, 'DO'], [750, 750, 'MX'], [754, 755, 'CA'], [759, 759, 'VE'],
  [760, 769, 'CH'], [770, 771, 'CO'], [773, 773, 'UY'], [775, 775, 'PE'], [777, 777, 'BO'],
  [778, 779, 'AR'], [780, 780, 'CL'], [784, 784, 'PY'], [786, 786, 'EC'], [789, 790, 'BR'],
  [800, 839, 'IT'], [840, 849, 'ES'], [850, 850, 'CU'], [858, 858, 'SK'], [859, 859, 'CZ'],
  [860, 860, 'RS'], [865, 865, 'MN'], [867, 867, 'KP'], [868, 869, 'TR'], [870, 879, 'NL'],
  [880, 881, 'KR'], [884, 884, 'KH'], [885, 885, 'TH'], [888, 888, 'SG'], [890, 890, 'IN'],
  [893, 893, 'VN'], [896, 896, 'PK'], [899, 899, 'ID'], [900, 919, 'AT'], [930, 939, 'AU'],
  [940, 949, 'NZ'], [955, 955, 'MY'], [958, 958, 'MO'],
];

export function regionFromBarcode(gtin: string): string | null {
  // EAN-8 после дополнения до 13 знаков начинается с пяти нулей — его
  // префикс стоит в шестой позиции, а не в первой.
  const digits = /^0{5}\d{8}$/.test(gtin) ? gtin.slice(5) : gtin;
  const prefix = Number(digits.slice(0, 3));
  const hit = GS1_PREFIXES.find(([from, to]) => prefix >= from && prefix <= to);
  return hit ? hit[2] : null;
}

// Штрихкод текстом: «штрихкод 4606605030288 всю банку» или просто цифры —
// запасной путь, когда с фото цифры не читаются. Хвост после цифр — подпись.
export function parseBarcodeText(text: string): { code: string; caption: string | undefined } | null {
  const match = text.trim().match(/^(?:штрих\s*-?\s*код[:\s]*)?(\d[\d\s]{6,18}\d)(?:\s+(.+))?$/iu);
  if (!match) return null;
  const code = normalizeBarcode(match[1]);
  if (!code) return null;
  return { code, caption: match[2]?.trim() || undefined };
}

// Явный режим «это штрихкод»: слово в подписи к фото. Режим отключает
// угадывание по снимку — либо продукт по коду, либо честный ответ, почему нет.
const BARCODE_KEYWORD = /(^|[\s,.;:!])(штрих\s*-?\s*код|баркод|barcode)(?=$|[\s,.;:!])/iu;

export function hasBarcodeKeyword(text: string): boolean {
  return BARCODE_KEYWORD.test(text);
}

export function stripBarcodeKeyword(text: string): string | undefined {
  const rest = text.replace(BARCODE_KEYWORD, '$1').replace(/^[\s,.;:!]+/, '').replace(/\s+/g, ' ').trim();
  return rest || undefined;
}

// UPC-E не берём: zxing отдаёт его 8-значным с чужой контрольной суммой, а
// базам нужен развёрнутый UPC-A; в России он и не встречается.
const DECODER_FORMATS = ['EAN-13', 'EAN-8', 'UPC-A'] as const;

export async function decodeBarcodeImage(image: Buffer): Promise<string | null> {
  const results = await readBarcodes(new Blob([new Uint8Array(image)]), {
    formats: [...DECODER_FORMATS],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
  });
  for (const result of results) {
    const code = normalizeBarcode(result.text);
    if (code) return code;
  }
  return null;
}

// unreadable — штрихкод на фото есть, но цифры не разобрать (или контрольная
// сумма не сошлась): бот подскажет прислать цифры текстом. null — штрихкода
// нет вовсе, обычное фото еды.
export type BarcodeRead = { code: string } | 'unreadable' | null;

export async function readBarcodeFromPhoto(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png',
): Promise<BarcodeRead> {
  try {
    const decoded = await decodeBarcodeImage(Buffer.from(imageBase64, 'base64'));
    if (decoded) return { code: decoded };
  } catch (error) {
    // Декодер — ускорение, не единственный путь: при сбое WASM едем дальше.
    logError('barcode-decoder', error);
  }
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 40,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
          {
            type: 'text',
            text:
              'На фото может быть штрихкод товара (EAN-13, EAN-8 или UPC) — полосы и напечатанные под ними цифры. ' +
              'Перепиши эти цифры: ответь ТОЛЬКО цифрами подряд, без пробелов и слов. ' +
              'Если штрихкод есть, но цифры не читаются полностью (темно, размыто, обрезано) — ответь одним словом: unreadable. ' +
              'Если штрихкода на фото нет — ответь одним словом: none. Не отвечай другими словами.',
          },
        ],
      },
    ],
  });
  const answer = (response.choices[0]?.message.content ?? '').trim().toLowerCase();
  const code = normalizeBarcode(answer);
  if (code) return { code };
  // Модель иногда отвечает по-русски вопреки инструкции: «размыто», «не
  // читается» — это unreadable, а «нет»/«none» — штрихкода нет.
  const unreadable = /unreadable|размыт|не\s*чита|не\s*разобр|обрез|темн/u.test(answer) || /\d{8,}/.test(answer);
  return unreadable ? 'unreadable' : null;
}

// Open Food Facts — открытая база штрихкодов с российскими товарами и КБЖУ с
// этикетки; у FatSecret база американская, и 460… там почти всегда пусто.
// В дневник FatSecret всё равно пишется их продукт-аналог (своих там не
// создать), а этикеточные калории показываем рядом для сверки.
export type OffProduct = {
  name: string;
  brand: string | null;
  queryEn: string;
  quantityGrams: number | null;
  kcalPer100g: number | null;
  proteinPer100g: number | null;
  fatPer100g: number | null;
  carbsPer100g: number | null;
};

export type OffRaw = {
  status?: number;
  product?: {
    product_name?: string;
    product_name_ru?: string;
    product_name_en?: string;
    brands?: string;
    quantity?: string;
    categories_tags?: string[];
    nutriments?: Record<string, number | string>;
  };
};

export function parseOffProduct(raw: OffRaw): OffProduct | null {
  const product = raw.product;
  if (raw.status !== 1 || !product) return null;
  const name = (product.product_name_ru || product.product_name || product.product_name_en || '').trim();
  if (!name) return null;
  const brand = product.brands?.split(',')[0]?.trim() || null;
  // Английское имя для поиска аналога в FatSecret: своё поле, иначе самая
  // узкая английская категория («en:cottage-cheeses» → «cottage cheeses»).
  const category = product.categories_tags
    ?.filter((tag) => tag.startsWith('en:'))
    .at(-1)
    ?.slice(3)
    .replace(/-/g, ' ');
  const queryEn = product.product_name_en?.trim() || category || name;
  // Без \b: в JS-регулярке без флага u граница слова — только ASCII, после
  // кириллической «г» она не срабатывает и «320 г» терялось.
  const quantity = product.quantity?.match(/(\d+(?:[.,]\d+)?)\s*(?:гр|г|ml|мл|g)(?!\p{L})/iu);
  const nutrient = (key: string): number | null => {
    const raw = product.nutriments?.[key];
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  return {
    name,
    brand,
    queryEn,
    quantityGrams: quantity ? Number(quantity[1].replace(',', '.')) : null,
    kcalPer100g: nutrient('energy-kcal_100g'),
    proteinPer100g: nutrient('proteins_100g'),
    fatPer100g: nutrient('fat_100g'),
    carbsPer100g: nutrient('carbohydrates_100g'),
  };
}

export async function lookupOpenFoodFacts(barcode: string): Promise<OffProduct | null> {
  const fields = 'product_name,product_name_ru,product_name_en,brands,quantity,categories_tags,nutriments';
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=${fields}`, {
    headers: { 'User-Agent': 'rokid-ai/0.1 (https://github.com/InfinityScripter/rokid-ai)' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Open Food Facts: HTTP ${res.status}`);
  return parseOffProduct((await res.json()) as OffRaw);
}
