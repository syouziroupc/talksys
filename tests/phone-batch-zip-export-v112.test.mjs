import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zipStoreFiles } from '../src/telephony/index.js';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('batch phone export produces a valid stored ZIP container', () => {
  const zip = zipStoreFiles([{ name: 'talksys-call-demo.jsonl', content: '{"type":"call"}\n' }]);
  assert.ok(zip instanceof Uint8Array);
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.match(new TextDecoder().decode(zip), /talksys-call-demo\.jsonl/);
});

test('phone dashboard exposes authenticated recent-call ZIP presets', () => {
  assert.match(source, /recentCallsZip/);
  assert.match(source, /adminAuthorized\(request, env\)/);
  assert.match(source, /application\/zip/);
  assert.match(source, /\/phone\/api\/calls\/export\.zip/);
  assert.match(source, /id="batchExportBtn"/);
  assert.match(source, /value="10"/);
  assert.match(source, /value="20" selected/);
  assert.match(source, /value="50"/);
  assert.match(source, /Math\.min\(50/);
});
