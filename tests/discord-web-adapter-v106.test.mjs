import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord v107 is web-authoritative by default', () => {
  assert.match(source, /talksys-discord-bridge-v107-web-parity-r1/);
  assert.match(source, /const WEB_UNIFIED_MODE = process\.env\.TALKSYS_WEB_UNIFIED !== '0'/);
  assert.match(source, /speechAlternatives: WEB_UNIFIED_MODE \? \[\]/);
  assert.match(source, /if \(!WEB_UNIFIED_MODE\) \{\s*const correction = correctLowConfidenceTranscript/);
  assert.match(source, /STT-AUTH.*web transcript accepted without Discord-side semantic rewrite/);
});

test('Discord adapter delegates semantic services to Web\/Worker endpoints', () => {
  for (const endpoint of ['/api/transcribe', '/api/fast-reaction', '/api/search-preface', '/api/turn']) {
    assert.ok(source.includes(endpoint), endpoint + ' missing');
  }
});
