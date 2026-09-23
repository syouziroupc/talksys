import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord posts end-to-end metrics asynchronously after an utterance', () => {
  assert.match(source, /async function postVoiceMetrics\(\{/);
  assert.match(source, /TALKSYS_BASE_URL \+ '\/api\/voice-metrics'/);
  assert.match(source, /authorization: 'Bearer ' \+ BRIDGE_TOKEN/);
  assert.match(source, /postVoiceMetrics\(\{[\s\S]*\}\)\.catch\(\(\) => \{\}\)/);
});

test('metrics carry capture, Whisper, common turn, TTS and playback timings', () => {
  for (const key of [
    'captureMs','sttMs','speechEndToSttFinalMs','answerStartMs','primaryMs',
    'verifierMs','answerGenerationTotalMs','firstTtsMs','firstAudioReadyMs',
    'speechEndToPlaybackStartMs','pipelineCompleteMs','ffmpegSpawnMs','playbackMs',
  ]) assert.match(source, new RegExp(key));
  assert.match(source, /sttMode: 'web-whisper'/);
  assert.doesNotMatch(source, /batchSttMs|batchTranscribePcm16|fallbackController|realtimeSttBackoff|realtimeSttSockets/);
});

test('one utterance id links /api/transcribe, /api/turn, TTS and metrics', () => {
  assert.match(source, /const utteranceId = `utt-\$\{randomUUID\(\)\}`/);
  assert.match(source, /x-talksys-utterance': utteranceId/);
  assert.match(source, /talk\(confirmedTranscript, utteranceId/);
  assert.match(source, /synthesize\(turn\.answer, controller\.signal, \{ utteranceId/);
  assert.match(source, /utteranceId,/);
});

test('metrics prove the exact confirmed transcript passed to Gemini', () => {
  assert.match(source, /confirmedTranscript,/);
  assert.match(source, /geminiInputText: confirmedTranscript/);
  assert.match(source, /realtimeTranscript: ''/);
});
