import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectPhoneAckText, PHONE_FAST_ACK_REVISION } from '../src/telephony/index.js';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('phone fast reaction v2 selects a cached category acknowledgement and avoids the recent phrase', () => {
  const reaction = { kind: 'lookup', shouldSpeak: true, terminal: false };
  const cached = ['はい、少々お待ちください。', 'はい、少し調べますね。', '関連情報を確認しますね。'];
  const selected = selectPhoneAckText(reaction, cached, ['はい、少し調べますね。']);
  assert.equal(selected.text, '関連情報を確認しますね。');
  assert.equal(selected.fallbackUsed, false);
});

test('phone fast reaction v2 falls back to the known-good receipt ack while a category phrase warms', () => {
  const reaction = { kind: 'question', shouldSpeak: true, terminal: false };
  const selected = selectPhoneAckText(reaction, ['はい、少々お待ちください。'], []);
  assert.equal(selected.text, 'はい、少々お待ちください。');
  assert.equal(selected.fallbackUsed, true);
  assert.equal(selected.warmText, 'はい、確認してお答えしますね。');
});

test('phone fast reaction v2 keeps terminal or unknown reactions on the conservative fallback', () => {
  assert.equal(selectPhoneAckText({ kind: 'thanks', shouldSpeak: true, terminal: true }, ['はい、少々お待ちください。'], []).text, 'はい、少々お待ちください。');
  assert.equal(selectPhoneAckText({ kind: 'none', shouldSpeak: false, terminal: false }, ['はい、少々お待ちください。'], []).text, 'はい、少々お待ちください。');
});

test('phone fast reaction v2 keeps answer generation concurrent with the acknowledgement and preserves transport', () => {
  assert.equal(PHONE_FAST_ACK_REVISION, 'talksys-phone-fast-ack-v2-r1');
  const turnStart = source.indexOf('const turnPromise=answerWithTalkSys');
  const ackSpeak = source.indexOf('await speak(ackText');
  assert.ok(turnStart >= 0 && ackSpeak > turnStart, 'TalkSys answer generation must start before the acknowledgement is played');
  assert.match(source, /spokenBackchannel=ackPrepared\?ackText:''/);
  assert.match(source, /streamPcmu20ms\(audio\.bytes/);
  assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(source, /const FAST_ACK_TEXT = 'はい、少々お待ちください。'/);
});

test('phone fast reaction v2 uses single-flight TTS warming rather than regenerating the same phrase', () => {
  assert.match(source, /phoneAckAudioPromises\.has\(ackText\)/);
  assert.match(source, /phoneAckAudioPromises\.set\(ackText, promise\)/);
  assert.match(source, /phoneAckAudioPromises\.delete\(ackText\)/);
  assert.match(source, /warmPhoneAckPrimaries/);
  assert.match(source, /phone_fast_ack_lazy_warm/);
});
