import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('legacy realtime STT transport is absent from Discord bridge', () => {
  assert.doesNotMatch(source, /WebSocket|realtimeSttSockets|prewarmRealtimeSttSocket|acquireRealtimeSttSocket/);
  assert.doesNotMatch(source, /KeepAlive|Finalize|speech_final|from_finalize/);
  assert.doesNotMatch(source, /registerRealtimeSttFailure|realtimeSttBackoffUntil|circuit/i);
});

test('Whisper /api/transcribe is called for every accepted captured utterance', () => {
  assert.match(source, /async function handleCapturedUtterance/);
  assert.match(source, /const stt = await transcribeCapturedUtterance\(pcm, utteranceId, timeline, controller\.signal\)/);
  assert.match(source, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(source, /confirmedTranscript: stt\.confirmedTranscript/);
  assert.doesNotMatch(source, /if \(!text && pcm16\.length\)|batchTranscribePcm16/);
});

test('Discord transport silence is only a safety guard behind web-compatible PCM finalization', () => {
  assert.match(source, /EndBehaviorType\.AfterSilence, duration: 1600/);
  assert.match(source, /capture\.shouldFinalize\(Date\.now\(\)\)/);
  assert.match(source, /finalize\('web-compatible-silence'\)/);
  assert.match(source, /const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v79-web-audio-adapter-r1'/);
});

test('receiver is rearmed after each utterance to protect the next utterance pre-roll', () => {
  assert.match(source, /queueMicrotask\(\(\) => \{/);
  assert.match(source, /startReceiverSession\(userId, false\)/);
  assert.match(source, /prearmed user=/);
});
