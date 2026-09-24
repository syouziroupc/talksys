import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const stt = fs.readFileSync(new URL('../src/stt-v45.js', import.meta.url), 'utf8');
const logs = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');

test('v94 correction is bounded to low-confidence glossary evidence', () => {
  assert.match(bridge, /STT_LOW_CONFIDENCE_THRESHOLD = 0\.88/);
  assert.match(bridge, /correctLowConfidenceTranscript/);
  for (const term of ['TalkSys','Discord','Gemini','Whisper']) assert.match(bridge, new RegExp(term));
  assert.match(bridge, /rawTranscript/);
  assert.match(bridge, /correctedTranscript/);
  assert.match(bridge, /correctionReason/);
});

test('v94 relaxed barge-in keeps 150ms continuity and self-voice guard', () => {
  assert.match(bridge, /BARGE_IN_CONFIRM_MS = 150/);
  assert.match(bridge, /BARGE_IN_RELAX_FACTOR = 0\.85/);
  assert.match(bridge, /pcm16Level/);
  assert.match(bridge, /looksLikeRecentBotEcho\(value/);
  assert.match(bridge, /interruptActiveAnswer\('confirmed-user-barge-in'\)/);
  assert.match(bridge, /bargeInTriggerMs/);
});

test('v94 server persists transcript provenance and barge-in latency', () => {
  for (const key of ['rawTranscript','correctedTranscript','correctionReason','bargeInTriggerMs']) assert.match(entry, new RegExp(key));
});


test('v94 rejects common subtitle outro hallucinations unconditionally', () => {
  assert.match(stt, /ご視聴ありがとうございました/);
  assert.match(stt, /outro hallucinations are not valid TalkSys conversation turns/);
  assert.doesNotMatch(stt, /ご視聴ありがとうございました[^\n]+&& \(!metrics/);
});

test('v94 ordinary short utterances are never deferred or timeout-dropped', () => {
  assert.doesNotMatch(bridge, /FRAGMENT_JOIN_WINDOW_MS/);
  assert.doesNotMatch(bridge, /isLikelyIncompleteFragment/);
  assert.doesNotMatch(bridge, /incomplete-fragment-timeout/);
  assert.match(bridge, /shouldDropUncorroboratedBotOverlap/);
});

test('v94 STT only pre-drops physically tiny or effectively silent captures', () => {
  assert.match(stt, /durationMs < 60/);
  assert.match(stt, /peak < 0\.004/);
  assert.match(stt, /rms < 0\.0008/);
  assert.match(stt, /activeMs < 40/);
  assert.doesNotMatch(stt, /clearShortSpeech/);
});

test('v94 rescues usable realtime transcript when Whisper returns an ignorable 422', () => {
  assert.match(bridge, /STT-RESCUE/);
  assert.match(bridge, /realtime-rescue-after-whisper-failure/);
  assert.match(bridge, /Whisper failed -> realtime/);
  assert.match(bridge, /processConfirmedTranscript/);
});

test('v94 retries strong-signal empty Whisper transcript only once', () => {
  assert.match(stt, /strongSpeechSignalForRetry/);
  assert.match(stt, /vad_filter: false/);
  assert.match(stt, /no_speech_threshold: 0\.72/);
  assert.match(stt, /empty-transcript-after-retry/);
  assert.match(stt, /retryUsed/);
});

test('v94 searches unknown entity explanation questions and contextual follow-ups', () => {
  assert.match(entry, /ENTITY_EXPLANATION_RE/);
  assert.match(entry, /shouldContinueExternalSearch/);
  assert.match(entry, /shouldStronglyPreferSearch\(text\) \|\| shouldContinueExternalSearch\(text, body\)/);
  assert.match(entry, /について\(\?:教えて\|知りたい/);
});

test('v94 system prompt requires plain Japanese and stepwise guidance', () => {
  assert.match(entry, /高齢者やパソコンに詳しくない人/);
  assert.match(entry, /中学生でも分かる日常の日本語/);
  assert.match(entry, /一文に一つの操作/);
  assert.match(entry, /CPUなら「パソコンの頭脳にあたる部品」/);
  assert.match(entry, /SSDなら「データを保存する部品」/);
  assert.match(entry, /次に何を押せばよいかを先に/);
});

test('v94 hard-blocks common IT jargon in spoken output', () => {
  assert.match(entry, /simplifyForSenior/);
  for (const word of ['アドレス','アカウント','ログイン','ブラウザ','クリック','ダウンロード','ストレージ','スペック']) {
    assert.match(entry, new RegExp(word));
  }
  assert.match(entry, /ホームページの場所/);
  assert.match(entry, /利用者の登録/);
  assert.match(entry, /インターネットを見る画面/);
  assert.match(entry, /simplifyForSenior\(normalizeSpokenJapanese\(interaction\.answer\)\)/);
});

test('v94 D1 compact logs preserve voice correction and barge-in diagnostics', () => {
  for (const key of ['rawTranscript','correctedTranscript','correctionReason','bargeInTriggerMs']) {
    assert.match(logs, new RegExp(key));
  }
});
