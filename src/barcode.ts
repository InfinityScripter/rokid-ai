import OpenAI from 'openai';

import { config } from './config.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

// Штрихкод с фото читаем не декодером полос, а цифрами, напечатанными под
// ними: их видит та же vision-модель, что распознаёт еду, — без новой
// зависимости. Ошибка чтения на одну цифру отсекается контрольной суммой.

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

// Штрихкод текстом: «штрихкод 4606605030288 всю банку» или просто цифры —
// запасной путь, когда с фото цифры не читаются. Хвост после цифр — подпись.
export function parseBarcodeText(text: string): { code: string; caption: string | undefined } | null {
  const match = text.trim().match(/^(?:штрих\s*-?\s*код[:\s]*)?(\d[\d\s]{6,18}\d)(?:\s+(.+))?$/iu);
  if (!match) return null;
  const code = normalizeBarcode(match[1]);
  if (!code) return null;
  return { code, caption: match[2]?.trim() || undefined };
}

// unreadable — штрихкод на фото есть, но цифры не разобрать (или контрольная
// сумма не сошлась): бот подскажет прислать цифры текстом. null — штрихкода
// нет вовсе, обычное фото еды.
export type BarcodeRead = { code: string } | 'unreadable' | null;

export async function readBarcodeFromPhoto(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png',
): Promise<BarcodeRead> {
  const response = await client.chat.completions.create({
    model: config.ROUTER_MODEL,
    max_tokens: 40,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
          {
            type: 'text',
            text:
              'Есть ли на фото штрихкод товара с цифрами под полосами (EAN-13, EAN-8 или UPC)? ' +
              'Если да и цифры читаются целиком — ответь ТОЛЬКО этими цифрами подряд, без пробелов и слов. ' +
              'Если штрихкод есть, но цифры не читаются полностью (темно, размыто, обрезано) — ответь одним словом: unreadable. ' +
              'Если штрихкода на фото нет — ответь одним словом: none.',
          },
        ],
      },
    ],
  });
  const answer = (response.choices[0]?.message.content ?? '').trim().toLowerCase();
  const code = normalizeBarcode(answer);
  if (code) return { code };
  return answer.includes('unreadable') || /\d{8,}/.test(answer) ? 'unreadable' : null;
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
  const kcalRaw = product.nutriments?.['energy-kcal_100g'];
  const kcal = typeof kcalRaw === 'string' ? Number(kcalRaw) : kcalRaw;
  return {
    name,
    brand,
    queryEn,
    quantityGrams: quantity ? Number(quantity[1].replace(',', '.')) : null,
    kcalPer100g: typeof kcal === 'number' && Number.isFinite(kcal) ? kcal : null,
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
