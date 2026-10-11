import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v119 caps slow-STT acknowledgement latency without changing the normal categorized ack path', () => {
  assert.match(source, /PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v119-r1'/);
  assert.match(source, /const PHONE_ACK_STT_GRACE_MS = 250/);
  assert.match(source, /PHONE_SLOW_STT_ACK_TEXTS/);
  assert.match(source, /const sttPromise=transcribeSamples\(env,samples\)/);
  assert.match(source, /ack_slow_stt_fallback/);
  assert.match(source, /if\(!slowAckStarted\)interruptPlayback\(\)/);
  assert.match(source, /if\(slowAckStarted\)\{queueLatency\(turnId,'ack_already_started'/);
  assert.match(source, /selectPhoneAckText\(reaction,phoneAckAudioCache\.keys\(\),recentAckTexts\)/);
});

test('v119 does not reopen the frozen v118 audio quality settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.doesNotMatch(source, /const FAST_ACK_TEXT = 'はい。'/);
});

test('batch ZIP avoids per-call D1 N+1 queries and dashboard supports real PUT options', () => {
  assert.match(source, /TALKSYS_LOG_DB\.batch\(\[/);
  assert.match(source, /WHERE call_id IN \(\$\{placeholders\}\)/);
  const zipStart = source.indexOf('async function recentCallsZip');
  const zipEnd = source.indexOf('async function texmlResponse', zipStart);
  const zipBlock = source.slice(zipStart, zipEnd);
  assert.doesNotMatch(zipBlock, /await callJsonlContent\(env, call\)/);
  assert.match(source, /async function api\(path,options=\{\}\)/);
  assert.match(source, /\.\.\.options,headers:\{\.\.\.auth\(\),\.\.\.\(options\.headers\|\|\{\}\)\}/);
  assert.match(source, /ZIP応答が破損しています/);
});
