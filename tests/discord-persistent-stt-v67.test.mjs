import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord bridge prewarms a fresh STT websocket without reusing a finalized utterance socket', () => {
  assert.match(source, /function prewarmRealtimeSttSocket\(userId, sessionEpoch\)/);
  assert.match(source, /websocket prewarm user=/);
  assert.match(source, /websocket prewarm claimed user=/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'utterance-complete'\)/);
  assert.match(source, /prewarmRealtimeSttSocket\(userId, sessionEpoch\)/);
  assert.doesNotMatch(source, /websocket reuse user=/);
});

test('idle prewarmed STT sockets stay alive until claimed by the next utterance', () => {
  assert.match(source, /JSON\.stringify\(\{ type: 'KeepAlive' \}\)/);
  assert.match(source, /Date\.now\(\) - transport\.lastAudioAt < 3000/);
  assert.match(source, /existing\.claimed = true/);
  assert.match(source, /existing\.epoch === sessionEpoch && !existing\.claimed/);
});

test('Finalize remains a fallback while Nova speech_final completes immediately', () => {
  assert.match(source, /JSON\.stringify\(\{ type: 'Finalize' \}\)/);
  assert.match(source, /payload\?\.from_finalize/);
  assert.match(source, /complete\('from-finalize'\)/);
  assert.match(source, /detachWsListeners\(\)/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'utterance-complete'\)/);
  assert.match(source, /\}, 1500\)/);
  assert.match(source, /if \(reason === 'speech-final'\) \{\s*complete\('speech-final'\);/s);
  assert.match(source, /if \(payload\?\.speech_final && text\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => complete\('speech-final'\), 100\)/);
});

test('broken realtime STT always falls back and opens a bounded circuit breaker', () => {
  assert.match(source, /destroyReusableSttSocket\(userId, 'realtime-failed'\)/);
  assert.match(source, /registerRealtimeSttFailure\(realtimeFailureReason, statusCode\)/);
  assert.match(source, /realtimeSttFailureCount = Math\.min\(6, realtimeSttFailureCount \+ 1\)/);
  assert.match(source, /realtimeSttBackoffUntil = Math\.max/);
  assert.match(source, /if \(!text && pcm16\.length\) \{/);
  assert.match(source, /batchTranscribePcm16\(pcm16, realtimeFailureReason \|\| reason, fallbackController\.signal\)/);
  assert.match(source, /markRealtimeFailed\('finalize-timeout'\)/);
  assert.match(source, /Date\.now\(\) < realtimeSttBackoffUntil/);
  assert.match(source, /registerRealtimeSttHealthy\(\)/);
});

test('voice disconnect closes any current STT socket and exposes the responsiveness revision', () => {
  assert.match(source, /for \(const userId of \[\.\.\.realtimeSttSockets\.keys\(\)\]\)/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'voice-disconnect'\)/);
  assert.match(source, /const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v78-observability-common-turn-r1'/);
});
