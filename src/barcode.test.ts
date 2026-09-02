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
