import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord client posts end-to-end latency metrics without blocking the response path', () => {
  assert.match(source, /async function postVoiceMetrics\(text, timings = \{\}, utteranceId = ''\)/);
  assert.match(source, /TALKSYS_BASE_URL \+ '\/api\/voice-metrics'/);
  assert.match(source, /authorization: 'Bearer ' \+ BRIDGE_TOKEN/);
  assert.match(source, /postVoiceMetrics\(text, clientTimings, utteranceId\)\.catch\(\(\) => \{\}\)/);
});

test('Discord turn stream exposes server timing fields to client metrics', () => {
  assert.match(source, /clientElapsedMs: elapsed/);
  assert.match(source, /timings: doneBody\?\.timings \|\| \{\}/);
  assert.match(source, /clientTimings\.serverTotalMs/);
  assert.match(source, /clientTimings\.primaryMs/);
  assert.match(source, /clientTimings\.verifierMs/);
});

test('Discord records first TTS, first audio, playback, and pipeline completion', () => {
  assert.match(source, /clientTimings\.firstTtsMs = prefetched\.elapsedMs/);
  assert.match(source, /clientTimings\.firstAudioReadyMs = Date\.now\(\) - pipelineStarted/);
  assert.match(source, /speechEndToPlaybackStartMs/);
  assert.match(source, /\[latency-summary\].*sttMs=.*batchSttMs=.*primaryMs=.*verifierMs=.*firstTtsMs=.*firstAudioReadyMs=/);
  assert.match(source, /clientTimings\.playbackMs = totalPlaybackMs/);
  assert.match(source, /clientTimings\.pipelineCompleteMs = Date\.now\(\) - pipelineStarted/);
});

test('STT completion reports realtime versus batch and records prewarmed socket claims', () => {
  assert.match(source, /let inputEndedAt = 0/);
  assert.match(source, /usedBatchStt = true/);
  assert.match(source, /sttMode: usedBatchStt \? 'batch' : 'realtime'/);
  assert.match(source, /sttReused: reusedSocket/);
  assert.match(source, /return \{ transport: createRealtimeSttTransport\(userId, sessionEpoch, true\), reused: false \}/);
  assert.match(source, /return \{ transport: existing, reused: true \}/);
  assert.match(source, /sttMs,/);
});

test('queued turns preserve their original speech metrics', () => {
  assert.match(source, /pendingTurns\.push\(\{ text, userId, sessionEpoch, speechMetrics \}\)/);
  assert.match(source, /processTranscript\(next\.text, next\.userId, next\.sessionEpoch, next\.speechMetrics\)/);
  assert.match(source, /talksys-discord-bridge-v76-interaction-supervisor-r1/);
});

test('one utterance id links the turn request and its voice metrics event', () => {
  assert.match(source, /const utteranceId = String\(speechMetrics\?\.utteranceId \|\| `utt-\$\{randomUUID\(\)\}`\)/);
  assert.match(source, /talkStream\(text, queueSentence, utteranceId, controller\.signal, prefetchSpeculative\)/);
  assert.match(source, /utteranceId,/);
  assert.match(source, /postVoiceMetrics\(text, clientTimings, utteranceId\)/);
});
