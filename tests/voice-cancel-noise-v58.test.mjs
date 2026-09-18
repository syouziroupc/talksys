import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V45, AUDIO_REVISION, __test as clientFlags } from '../src/talk-client-v45.js';
import { TELEPHONY_REVISION, highPassPcmFrame } from '../src/telephony/index.js';

test('v58 browser client remains syntactically valid', () => {
  assert.doesNotThrow(() => new Function(TALK_CLIENT_V45));
  assert.equal(AUDIO_REVISION, 'talksys-v58-noise-cancel-interrupt-r1');
});

test('browser mic uses native processing plus a rumble high-pass filter', () => {
  assert.equal(clientFlags.browserNoiseSuppression, true);
  assert.match(TALK_CLIENT_V45, /echoCancellation=true/);
  assert.match(TALK_CLIENT_V45, /noiseSuppression=true/);
  assert.match(TALK_CLIENT_V45, /autoGainControl=true/);
  assert.match(TALK_CLIENT_V45, /inputFilter\.type='highpass'/);
  assert.match(TALK_CLIENT_V45, /frequency\.value=90/);
  assert.match(TALK_CLIENT_V45, /getSettings/);
});

test('browser keeps listening while Gemini/search is busy and only confirmed STT cancels the old turn', () => {
  assert.equal(clientFlags.listenWhileProcessing, true);
  assert.equal(clientFlags.confirmedVoiceCancellation, true);
  assert.equal(clientFlags.holdOldAnswerUntilStt, true);
  assert.doesNotMatch(TALK_CLIENT_V45, /if\(busy&&!speech\)\{startHits=0;bargeHits=0/);
  assert.match(TALK_CLIENT_V45, /処理中の追加入力開始/);
  assert.match(TALK_CLIENT_V45, /confirmed-voice-interrupt/);
  assert.match(TALK_CLIENT_V45, /new AbortController\(\)/);
  assert.match(TALK_CLIENT_V45, /旧回答の表示を保留/);
  assert.match(TALK_CLIENT_V45, /STT完了 .*確定入力として前ターンを中断/);
});

test('phone audio high-pass suppresses steady low-frequency/DC energy', () => {
  const state = {};
  const input = new Int16Array(800).fill(4000);
  const out = highPassPcmFrame(input, state, 8000, 90);
  const head = Math.abs(out[0]);
  const tail = Math.abs(out[out.length - 1]);
  assert.ok(head > 1000);
  assert.ok(tail < head * 0.1);
});

test('phone path uses adaptive VAD, debounce, and confirmed-speech cancellation', () => {
  assert.match(TELEPHONY_REVISION, /^talksys-telephony-v5[89]-/);
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /noiseFloor/);
  assert.match(source, /startThreshold/);
  assert.match(source, /bargeHits >= 5/);
  assert.match(source, /speechHits >= 3/);
  assert.match(source, /pendingSttCount/);
  assert.match(source, /controller\.abort\('confirmed-voice-interrupt'\)/);
  assert.match(source, /myCapture < latestAcceptedCapture/);
  assert.match(source, /waitForPendingSpeechDecision/);
  assert.match(source, /90Hz HPF|90\)/);
  assert.doesNotMatch(source, /processing = processing\.then/);
});
