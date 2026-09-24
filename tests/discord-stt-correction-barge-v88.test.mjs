import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const stt = fs.readFileSync(new URL('../src/stt-v45.js', import.meta.url), 'utf8');
const logs = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');

test('v91 correction is bounded to low-confidence glossary evidence', () => {
  assert.match(bridge, /STT_LOW_CONFIDENCE_THRESHOLD = 0\.88/);
  assert.match(bridge, /correctLowConfidenceTranscript/);
  for (const term of ['TalkSys','Discord','Gemini','Whisper']) assert.match(bridge, new RegExp(term));
  assert.match(bridge, /rawTranscript/);
  assert.match(bridge, /correctedTranscript/);
  assert.match(bridge, /correctionReason/);
});

test('v91 relaxed barge-in keeps 150ms continuity and self-voice guard', () => {
  assert.match(bridge, /BARGE_IN_CONFIRM_MS = 150/);
  assert.match(bridge, /BARGE_IN_RELAX_FACTOR = 0\.85/);
  assert.match(bridge, /pcm16Level/);
  assert.match(bridge, /looksLikeRecentBotEcho\(value/);
  assert.match(bridge, /interruptActiveAnswer\('confirmed-user-barge-in'\)/);
  assert.match(bridge, /bargeInTriggerMs/);
});

test('v91 server persists transcript provenance and barge-in latency', () => {
  for (const key of ['rawTranscript','correctedTranscript','correctionReason','bargeInTriggerMs']) assert.match(entry, new RegExp(key));
});


test('v91 rejects common subtitle outro hallucinations unconditionally', () => {
  assert.match(stt, /ご視聴ありがとうございました/);
  assert.match(stt, /outro hallucinations are not valid TalkSys conversation turns/);
  assert.doesNotMatch(stt, /ご視聴ありがとうございました[^\n]+&& \(!metrics/);
});

test('v91 ordinary short utterances are never deferred or timeout-dropped', () => {
  assert.doesNotMatch(bridge, /FRAGMENT_JOIN_WINDOW_MS/);
  assert.doesNotMatch(bridge, /isLikelyIncompleteFragment/);
  assert.doesNotMatch(bridge, /incomplete-fragment-timeout/);
  assert.match(bridge, /shouldDropUncorroboratedBotOverlap/);
});

test('v91 STT only pre-drops physically tiny or effectively silent captures', () => {
  assert.match(stt, /durationMs < 60/);
  assert.match(stt, /peak < 0\.004/);
  assert.match(stt, /rms < 0\.0008/);
  assert.match(stt, /activeMs < 40/);
  assert.doesNotMatch(stt, /clearShortSpeech/);
});

test('v91 rescues usable realtime transcript when Whisper returns an ignorable 422', () => {
  assert.match(bridge, /STT-RESCUE/);
  assert.match(bridge, /realtime-rescue-after-whisper-failure/);
  assert.match(bridge, /Whisper failed -> realtime/);
  assert.match(bridge, /processConfirmedTranscript/);
});

test('v91 D1 compact logs preserve voice correction and barge-in diagnostics', () => {
  for (const key of ['rawTranscript','correctedTranscript','correctionReason','bargeInTriggerMs']) {
    assert.match(logs, new RegExp(key));
  }
});
