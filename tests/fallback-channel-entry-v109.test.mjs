import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v109 exposes stable browser voice aliases without duplicating the voice pipeline', () => {
  assert.match(integrated, /talksys-v109-fallback-voice-entry-r1/);
  assert.match(integrated, /url\.pathname === '\/call'/);
  assert.match(integrated, /url\.pathname === '\/line-voice'/);
  assert.match(integrated, /return talksys\.fetch\(webVoiceAliasRequest\(request, channel\), env, ctx\)/);
  assert.match(integrated, /target\.pathname = '\/'/);
  assert.doesNotMatch(integrated, /line-voice[\s\S]{0,800}(?:new WebSocketPair|transcribeV45|CloudflareJapaneseTTS)/);
});

test('v109 channel health reports LINE as a web-link fallback, not native LINE Call media', () => {
  assert.match(integrated, /url\.pathname === '\/channel-health'/);
  assert.match(integrated, /nativeLineCallMedia: false/);
  assert.match(integrated, /mode: 'web-voice-link'/);
  assert.match(integrated, /provider: 'telnyx'/);
  assert.match(integrated, /sharedTokenConfigured: telephonyTokenConfigured/);
});

test('PSTN stays disabled by default until the Telnyx runtime is ready', () => {
  assert.match(wrangler, /"TELEPHONY_ENABLED": "false"/);
});
