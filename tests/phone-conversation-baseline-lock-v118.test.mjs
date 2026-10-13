import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const stt = fs.readFileSync(new URL('../src/stt-v45.js', import.meta.url), 'utf8');

test('phone conversation baseline locks conservative capture and output settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"3\.0"/);
  assert.match(stt, /normalizeQuietPhoneWav/);
  assert.match(stt, /PHONE_STT_CONTEXT_PROMPT/);
});

test('phone acknowledgement behavior is the 10/10 Fast Reaction v2 contract', () => {
  assert.match(telephony, /const FAST_ACK_TEXT = 'はい、確認しますね。'/);
  assert.match(telephony, /trackTask\(warmPhoneAckPrimaries\(env,deps\)/);
  assert.doesNotMatch(telephony, /earlyAckPromise/);
  const sttEnd = telephony.search(/queueLatency\(turnId,\s*'stt_end'/);
  const ackHit = telephony.search(/queueLatency\(turnId,\s*'ack_cache_hit'/);
  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'ack selection/playback must remain transcript-confirmed');
});

test('assistant playback keeps the existing guarded barge-in contract', () => {
  assert.match(telephony, /bargeThreshold=Math\.max\(threshold\*1\.25,noiseFloor\*3\.2,0\.010\)/);
  assert.match(telephony, /assistantPlaying/);
});

test('phone ZIP and dedicated profile administration routes are reachable', () => {
  assert.match(telephony, /pathname === '\/phone\/api\/calls\/export\.zip'/);
  assert.match(telephony, /pathname === '\/phone-profiles'/);
  assert.match(telephony, /pathname === '\/phone\/api\/profiles'/);
  assert.match(telephony, /function profilesDashboardHtml\(request\)/);
  assert.match(telephony, /async function listPhoneProfiles\(request, env\)/);
});

test('caller personalization is text-only context and does not block the audio pipeline', () => {
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /\.\.\.\(phoneProfile \? \{ phoneProfile \} : \{\}\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
  assert.match(integrated, /const phoneProfilePrefix = phoneProfileContext\(body\)/);
  assert.match(integrated, /現在の利用者発言と矛盾する場合は現在の発言を優先/);
});
