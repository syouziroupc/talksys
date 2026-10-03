import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arbitrateSuccessfulTranscript,
  classifySttFailure,
  realtimeBelongsToUtterance,
  rescueFailedWhisper,
} from '../src/voice-transcript-arbiter.js';

function metrics(text, confidence = 0.95, speechStartedAt = 1200) {
  return {
    realtimeTranscript: text,
    realtimeConfidence: confidence,
    realtimeWords: [],
    realtimeSpeechStartedAt: speechStartedAt,
  };
}

test('classifies hallucination before generic 422 text', () => {
  assert.equal(classifySttFailure('stt_http_422: hallucinated transcript rejected; rejected=hallucination-guard'), 'hallucination');
  assert.equal(classifySttFailure('stt_http_422: no speech detected rejected=empty-transcript'), 'no-speech');
});

test('realtime transcript must belong to current utterance generation', () => {
  assert.equal(realtimeBelongsToUtterance(metrics('フィリピンの時間', 0.95, 1200), { firstPcmAt: 1000 }), true);
  assert.equal(realtimeBelongsToUtterance(metrics('前の発話', 0.95, 400), { firstPcmAt: 1000 }), false);
});

test('promotes strong current realtime when Whisper is only a short tail', () => {
  const result = arbitrateSuccessfulTranscript({
    whisperText: '時間は',
    captureMetrics: metrics('フィリピンの今の時間は何時ですか', 0.96, 1100),
    timeline: { firstPcmAt: 1000 },
  });
  assert.equal(result.action, 'accept-realtime');
  assert.match(result.text, /フィリピン/);
});

test('drops high-confidence substantial disagreement instead of guessing', () => {
  const result = arbitrateSuccessfulTranscript({
    whisperText: '瓶の時差は何時間ですか',
    captureMetrics: metrics('日本とフィリピンの時差は何時間ですか', 0.96, 1100),
    timeline: { firstPcmAt: 1000 },
  });
  assert.equal(result.action, 'drop');
  assert.equal(result.reason, 'high-confidence-transcript-conflict');
});

test('keeps Whisper when realtime evidence is stale', () => {
  const result = arbitrateSuccessfulTranscript({
    whisperText: '今のロンドンの時間は何時ですか',
    captureMetrics: metrics('前の発話', 0.99, 500),
    timeline: { firstPcmAt: 1200 },
  });
  assert.equal(result.action, 'accept-whisper');
});

test('never rescues no-speech with a realtime fragment', () => {
  const result = rescueFailedWhisper({
    error: 'stt_http_422: no speech detected rejected=empty-transcript',
    captureMetrics: metrics('？ 北', 0.99, 1100),
    timeline: { firstPcmAt: 1000 },
  });
  assert.equal(result.action, 'drop');
  assert.equal(result.reason, 'whisper-no-speech');
});

test('never rescues hallucination-guard failures', () => {
  const result = rescueFailedWhisper({
    error: 'stt_http_422: hallucinated transcript rejected rejected=hallucination-guard',
    captureMetrics: metrics('フィリピンの今の時間は何時ですか', 0.99, 1100),
    timeline: { firstPcmAt: 1000 },
  });
  assert.equal(result.action, 'drop');
  assert.equal(result.reason, 'whisper-hallucination');
});

test('allows strong same-utterance realtime rescue only for weak-speech or timeout', () => {
  const result = rescueFailedWhisper({
    error: 'weak-speech-signal',
    captureMetrics: metrics('パソコンの買い替えについて相談したい', 0.95, 1100),
    timeline: { firstPcmAt: 1000 },
  });
  assert.equal(result.action, 'accept-realtime');
});
