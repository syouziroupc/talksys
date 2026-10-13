import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v126 restores v119 pre-STT acknowledgement playout after the bounded grace', () => {
  assert.match(source, /PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v126-restored-r1'/);
  assert.match(source, /const PHONE_ACK_STT_GRACE_MS = 250/);
  assert.match(source, /PHONE_SLOW_STT_ACK_TEXTS/);
  assert.match(source, /const sttPromise=transcribeSamples\(env,samples\)/);
  assert.match(source, /ack_slow_stt_fallback/);
  assert.match(source, /ack_already_started/);
  assert.match(source, /if\(sttSettled\|\|closed\)return/);
  const timerStart = source.indexOf('const slowAckTimer=setTimeout');
  const timerEnd = source.indexOf('},PHONE_ACK_STT_GRACE_MS);', timerStart);
  const timerBlock = source.slice(timerStart, timerEnd);
  assert.ok(timerStart >= 0 && timerEnd > timerStart);
  assert.match(timerBlock, /\bspeak\s*\(/, 'slow-STT acknowledgement must start while STT is still pending');
  assert.match(source, /if\(!slowAckStarted\)interruptPlayback\(\)/);
  assert.match(source, /selectPhoneAckText\(reaction,phoneAckAudioCache\.keys\(\),recentAckTexts\)/);
});

test('v120 does not reopen the frozen v118 audio quality settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"3\.0"/);
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
