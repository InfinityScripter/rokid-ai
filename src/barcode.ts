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

export async function readBarcodeFromPhoto(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png',
): Promise<string | null> {
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
              'Если штрихкода нет или цифры не читаются полностью — ответь одним словом: none.',
          },
        ],
      },
    ],
  });
  const answer = (response.choices[0]?.message.content ?? '').trim();
  return normalizeBarcode(answer);
}
