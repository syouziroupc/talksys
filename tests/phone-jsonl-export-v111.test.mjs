import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('phone call export is authenticated NDJSON with parsed latency detail', () => {
  assert.match(source, /callExportJsonl/);
  assert.match(source, /adminAuthorized\(request, env\)/);
  assert.match(source, /application\/x-ndjson; charset=utf-8/);
  assert.match(source, /talksys-call-\$\{safeId\}\.jsonl/);
  assert.match(source, /parsedLatencyDetail/);
  assert.match(source, /export\\.jsonl/);
});

test('phone dashboard exposes JSONL download without changing answer/ack ordering', () => {
  assert.match(source, /id=\"exportBtn\"/);
  assert.match(source, /downloadExport/);
  const turnStart = source.indexOf('const turnPromise=answerWithTalkSys');
  const ackSpeak = source.indexOf('await speak(ackText');
  assert.ok(turnStart >= 0 && ackSpeak > turnStart);
});
