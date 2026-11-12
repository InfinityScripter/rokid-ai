import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readJsonFile, writeJsonFile } from './json-file.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rokid-ai-jsonfile-test-'));
const file = (name: string) => path.join(dir, name);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('writeJsonFile создаёт каталог и пишет читаемый JSON', () => {
  const target = path.join(dir, 'вложенная', 'папка', 'data.json');
  writeJsonFile(target, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { a: 1 });
});

test('writeJsonFile не оставляет временных файлов рядом', () => {
  writeJsonFile(file('clean.json'), { ok: true });
  assert.equal(
    readdirSync(dir).filter((name) => name.includes('.tmp-')).length,
    0,
    'временный файл должен быть переименован, а не брошен',
  );
});

test('writeJsonFile умеет закрывать файл от чужих процессов', () => {
  const target = file('secret.json');
  writeJsonFile(target, { token: 'x' }, 0o600);
  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test('readJsonFile: файла нет — возвращаем запасное значение молча', () => {
  assert.deepEqual(readJsonFile(file('нет-такого.json'), { entries: [] }, 'test'), { entries: [] });
});

test('readJsonFile: битый файл не исчезает молча, а откладывается с пометкой', () => {
  const target = file('broken.json');
  writeFileSync(target, '{ это не json');
  assert.deepEqual(readJsonFile(target, { entries: [] }, 'test'), { entries: [] });
  assert.equal(existsSync(target), false, 'битый файл должен уехать из-под рабочего имени');
  assert.ok(
    readdirSync(dir).some((name) => name.startsWith('broken.json.corrupt-')),
    'улика должна остаться на диске под именем .corrupt-*',
  );
});
