import assert from 'node:assert/strict';
import { test } from 'node:test';

// Раньше остальных локальных импортов: barcode.js тянет config.js, который
// без этих переменных завершает процесс.
import './test-env.js';

const { normalizeBarcode } = await import('./barcode.js');

test('EAN-13 с верной контрольной цифрой проходит как есть', () => {
  assert.equal(normalizeBarcode('5901234123457'), '5901234123457');
  assert.equal(normalizeBarcode('4006381333931'), '4006381333931');
});

test('пробелы и мусор вокруг цифр не мешают', () => {
  assert.equal(normalizeBarcode('  590 1234 123457 '), '5901234123457');
  assert.equal(normalizeBarcode('штрихкод: 4006381333931.'), '4006381333931');
});

test('ошибка в одной цифре отсекается контрольной суммой', () => {
  assert.equal(normalizeBarcode('5901234123456'), null);
  assert.equal(normalizeBarcode('4006381333932'), null);
});

test('EAN-8 и UPC-A дополняются нулями до GTIN-13', () => {
  assert.equal(normalizeBarcode('96385074'), '0000096385074');
  assert.equal(normalizeBarcode('036000291452'), '0036000291452');
});

test('не штрихкодовая длина и «none» → null', () => {
  assert.equal(normalizeBarcode('none'), null);
  assert.equal(normalizeBarcode('12345'), null);
  assert.equal(normalizeBarcode(''), null);
});

const { hasBarcodeKeyword, parseBarcodeText, parseOffProduct, stripBarcodeKeyword } = await import('./barcode.js');

test('parseBarcodeText: «штрихкод …», голые цифры, хвост — подпись', () => {
  assert.deepEqual(parseBarcodeText('штрихкод 5901234123457'), { code: '5901234123457', caption: undefined });
  assert.deepEqual(parseBarcodeText('Штрих-код: 590 1234 123457 всю банку'), {
    code: '5901234123457',
    caption: 'всю банку',
  });
  assert.deepEqual(parseBarcodeText('4006381333931'), { code: '4006381333931', caption: undefined });
});

test('parseBarcodeText: обычный текст и невалидные цифры — не штрихкод', () => {
  assert.equal(parseBarcodeText('съел борщ'), null);
  assert.equal(parseBarcodeText('4006381333932'), null);
  assert.equal(parseBarcodeText('позвони +7 999 123 45 67'), null);
});

test('parseOffProduct: имя, бренд, граммы упаковки, ккал на 100 г, английский запрос', () => {
  const product = parseOffProduct({
    status: 1,
    product: {
      product_name: 'Творожное зерно в сливках 5%',
      brands: 'Савушкин, Savushkin',
      quantity: '320 г',
      categories_tags: ['en:dairies', 'en:cheeses', 'en:cottage-cheeses'],
      nutriments: { 'energy-kcal_100g': 143, proteins_100g: '9.5' },
    },
  });
  assert.deepEqual(product, {
    name: 'Творожное зерно в сливках 5%',
    brand: 'Савушкин',
    queryEn: 'cottage cheeses',
    quantityGrams: 320,
    kcalPer100g: 143,
  });
});

test('parseOffProduct: product_name_en важнее категории, нет товара → null', () => {
  const product = parseOffProduct({
    status: 1,
    product: { product_name: 'Йогурт', product_name_en: 'Plain yogurt', quantity: '0,5 l' },
  });
  assert.equal(product?.queryEn, 'Plain yogurt');
  assert.equal(product?.quantityGrams, null);
  assert.equal(product?.kcalPer100g, null);
  assert.equal(parseOffProduct({ status: 0 }), null);
  assert.equal(parseOffProduct({ status: 1, product: { brands: 'X' } }), null);
});

test('ключевое слово режима штрихкода в подписи: ловится и вычищается, остаток — подпись', () => {
  assert.equal(hasBarcodeKeyword('штрихкод'), true);
  assert.equal(hasBarcodeKeyword('Штрих-код, всю банку'), true);
  assert.equal(hasBarcodeKeyword('это barcode'), true);
  assert.equal(hasBarcodeKeyword('творожные сливки 320 грамм'), false);
  assert.equal(stripBarcodeKeyword('штрихкод'), undefined);
  assert.equal(stripBarcodeKeyword('штрихкод, всю банку 320 г'), 'всю банку 320 г');
  assert.equal(stripBarcodeKeyword('баркод всю банку'), 'всю банку');
});

test('decodeBarcodeImage: EAN-13, нарисованный zxing, декодируется обратно из PNG-байтов', async () => {
  const { writeBarcode } = await import('zxing-wasm/full');
  const { decodeBarcodeImage } = await import('./barcode.js');
  const written = await writeBarcode('4600605030288', { format: 'EAN-13', sizeHint: 600, withQuietZones: true });
  assert.ok(written.image, written.error);
  const png = Buffer.from(await written.image!.arrayBuffer());
  assert.equal(await decodeBarcodeImage(png), '4600605030288');
});

test('decodeBarcodeImage: картинка без штрихкода → null', async () => {
  const { decodeBarcodeImage } = await import('./barcode.js');
  // 1×1 PNG без полос — декодеру нечего читать.
  const blank = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  assert.equal(await decodeBarcodeImage(blank), null);
});
