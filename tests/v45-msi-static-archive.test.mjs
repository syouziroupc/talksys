import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDirectPrimaryTargets } from '../src/direct-primary-v45.js';

test('X79A-GD45 firmware lookup includes MSI official static archive without calling it latest', () => {
  const targets = resolveDirectPrimaryTargets('MSI X79A-GD45の最新BIOSを公式で確認して');
  const archive = targets.find(x => x.role === 'official_archive');
  assert.ok(archive);
  assert.equal(archive.url, 'https://download.msi.com/bos_exe/mb/7735v28.zip');
  assert.equal(archive.version, '2.8');
  assert.equal(archive.currentFirmwareVersionConfirmed, false);
});

test('MSI static archive fetch uses a one-byte Range probe and explicit non-latest semantics', () => {
  const source = fs.readFileSync(new URL('../src/direct-primary-v45.js', import.meta.url), 'utf8');
  assert.match(source, /range: 'bytes=0-0'/);
  assert.match(source, /最新バージョンであることまでは証明しない/);
});

test('static archive cannot satisfy latest firmware evidence by itself', () => {
  const source = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');
  assert.match(source, /currentFirmwareVersionConfirmed === true/);
  assert.match(source, /does not establish that no newer version exists/);
});
