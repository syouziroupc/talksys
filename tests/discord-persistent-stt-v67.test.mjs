import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('realtime STT exists only as the Web-compatible fast-reaction helper', () => {
  assert.match(source, /new WebSocket\(realtimeSttUrl\(\)\)/);
  assert.match(source, /\/api\/fast-reaction/);
  assert.match(source, /speech_final/);
  assert.doesNotMatch(source, /prewarmRealtimeSttSocket|acquireRealtimeSttSocket|registerRealtimeSttFailure|realtimeSttBackoffUntil|circuit|type:\s*['"]Finalize['"]/i);
});

test('Whisper /api/transcribe is called for every accepted captured utterance', () => {
  assert.match(source, /async function handleCapturedUtterance/);
  assert.match(source, /const stt = await transcribeCapturedUtterance\(pcm, utteranceId, timeline, controller\.signal\)/);
  assert.match(source, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(source, /confirmedTranscript: stt\.confirmedTranscript/);
  assert.doesNotMatch(source, /if \(!text && pcm16\.length\)|batchTranscribePcm16/);
});

test('Discord transport gate owns segmentation and finalizes after the stabilized Discord PCM gap', () => {
  assert.match(source, /EndBehaviorType\.AfterSilence, duration: 1600/);
  assert.match(source, /const DISCORD_SEGMENT_SILENCE_MS = WEB_VOICE_CAPTURE_POLICY\.silenceMs/);
  assert.match(source, /Date\.now\(\) - lastPcmAt >= DISCORD_SEGMENT_SILENCE_MS/);
  assert.match(source, /finalize\('discord-pcm-silence'\)/);
  assert.match(source, /browserVadBypassed: true/);
  assert.match(source, /const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v84-dedupe-telephony-ready-r1'/);
  assert.doesNotMatch(source, /capture\.shouldFinalize|web-compatible-silence|WebCompatibleCapture/);
});

test('receiver is rearmed after each utterance to protect the next utterance pre-roll', () => {
  assert.match(source, /queueMicrotask\(\(\) => \{/);
  assert.match(source, /startReceiverSession\(userId, false\)/);
  assert.match(source, /prearmed user=/);
});
