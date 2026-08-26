import assert from 'node:assert/strict';
import { test } from 'node:test';

// Раньше остальных локальных импортов: meeting.js тянет config.js, который
// без этих переменных завершает процесс.
import './test-env.js';

const { splitTranscript } = await import('./meeting.js');

test('короткий текст — один кусок без изменений', () => {
  assert.deepEqual(splitTranscript('привет, это короткая расшифровка', 100), [
    'привет, это короткая расшифровка',
  ]);
});

test('режет по границе строки, куски не длиннее лимита', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `строка номер ${i} с каким-то содержимым`);
  const text = lines.join('\n');
  const chunks = splitTranscript(text, 80);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 80, `кусок длиннее лимита: ${chunk.length}`);
  }
  // Ни одна строка не разорвана посередине: каждая строка целиком в каком-то куске.
  for (const line of lines) {
    assert.ok(chunks.some((chunk) => chunk.includes(line)), `строка потерялась: ${line}`);
  }
});

test('режет по границе предложения, точка остаётся в конце куска', () => {
  const text = `${'а'.repeat(60)}. ${'б'.repeat(60)}`;
  const chunks = splitTranscript(text, 80);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith('.'));
  assert.equal(chunks[1], 'б'.repeat(60));
});

test('без удобных границ — жёсткий рез, текст не теряется', () => {
  const text = 'х'.repeat(250);
  const chunks = splitTranscript(text, 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.equal(chunks.join(''), text);
});
