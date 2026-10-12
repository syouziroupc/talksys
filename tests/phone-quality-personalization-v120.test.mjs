import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gateTurnPayload } from '../src/entry.js';
import { PHONE_PERSONALIZATION_ACTIVE_REVISION, PHONE_RELEASE_VERSION, PHONE_RUNTIME_LOG_REVISION } from '../src/telephony/index.js';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v120 distinguishes stable knowledge from current or externally verified facts', () => {
  const answer = '株式会社という形態について、一般的な仕組みを説明します。';
  const stable = gateTurnPayload({ answer, searchUseful: false, sources: [], apiSources: [] }, '株式会社について教えてください');
  assert.equal(stable.answer, answer);
  assert.doesNotMatch(stable.answer, /根拠では|挙げられません/);
  assert.match(entry, /時点に依存しにくい一般知識/);
  assert.match(entry, /外部根拠が無いという理由だけで/);

  const dynamic = gateTurnPayload({ answer: '近くなら架空病院がおすすめです。', searchUseful: false, sources: [], apiSources: [] }, '近くの病院をおすすめして');
  assert.doesNotMatch(dynamic.answer, /架空病院/);
  assert.ok(dynamic.truthGate.applied);
});

test('v120 removes wait-language from receipt ack and never preplays an unvalidated slow-STT capture', () => {
  assert.match(telephony, /const FAST_ACK_TEXT = 'はい、確認しますね。'/);
  assert.doesNotMatch(telephony.slice(0, telephony.indexOf('export const PHONE_SEARCH_PROGRESS_REVISION')), /FAST_ACK_TEXT = 'はい、少々お待ちください。'/);
  assert.match(telephony, /if\(sttSettled\|\|closed\|\|latestAcceptedCapture===0\)return/);
  assert.match(telephony, /const PHONE_ACK_STT_GRACE_MS = 250/);
  const timerStart = telephony.indexOf('const slowAckTimer=setTimeout');
  const timerEnd = telephony.indexOf('},PHONE_ACK_STT_GRACE_MS);', timerStart);
  assert.ok(timerStart >= 0 && timerEnd > timerStart);
  assert.doesNotMatch(telephony.slice(timerStart, timerEnd), /\bspeak\s*\(/);
  assert.match(telephony, /ack_slow_stt_armed/);
  assert.match(telephony, /ack_slow_stt_committed/);
});

test('v120 keeps the frozen phone audio and answer-quality baseline intact', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.match(telephony, /bargeThreshold=Math\.max\(threshold\*1\.25,noiseFloor\*3\.2,0\.010\)/);
  assert.match(telephony, /streamPcmu20ms\(audio\.bytes/);
});

test('phone-number personalization is an active text-only TalkSys feature, not a parallel answer engine', () => {
  assert.equal(PHONE_PERSONALIZATION_ACTIVE_REVISION, 'talksys-phone-personalization-v121-r1');
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /displayName: clean\(callerProfile\?\.displayName \|\| '', 80\)/);
  assert.match(telephony, /personalizationText: clean\(callerProfile\?\.personalizationText \|\| '', 4000\)/);
  assert.match(telephony, /memoryText: clean\(callerProfile\?\.memoryText \|\| '', 8000\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
  assert.match(integrated, /呼び名:/);
  assert.match(integrated, /応答方針:/);
  assert.match(integrated, /継続メモ:/);
  assert.match(integrated, /現在の利用者発言と矛盾する場合は現在の発言を優先/);
  assert.match(telephony, /pathname === '\/phone-profiles'/);
  assert.doesNotMatch(telephony, /await\s+loadCallerProfileForSession\(/);
});

test('v120 records the executable phone version in every new call log', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v122');
  assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v122-r1');
  assert.match(wrangler, /"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"\s*\}/);
  assert.match(telephony, /workerVersionId: clean\(meta\?\.id \|\| '', 200\)/);
  assert.match(telephony, /workerVersionTag: clean\(meta\?\.tag \|\| '', 200\)/);
  assert.match(telephony, /workerVersionTimestamp: clean\(meta\?\.timestamp \|\| '', 120\)/);
  assert.match(telephony, /queueLatency\(runtimeTurnId,'runtime_revision',0,phoneRuntimeVersionDetail\(env\)\)/);
});
