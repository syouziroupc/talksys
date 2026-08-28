import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GEMINI_LIVE_PRIMARY } from '../src/gemini-live-primary.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v13.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Gemini Live is the primary low-latency native audio path', () => {
  assert.match(GEMINI_LIVE_PRIMARY, /gemini-3\.1-flash-live-preview/);
  assert.match(GEMINI_LIVE_PRIMARY, /audio\/pcm;rate=/);
  assert.match(GEMINI_LIVE_PRIMARY, /OUTPUT_RATE = 24000/);
  assert.match(GEMINI_LIVE_PRIMARY, /FRAME_SAMPLES = 640/);
  assert.match(GEMINI_LIVE_PRIMARY, /thinkingLevel: 'MINIMAL'/);
  assert.doesNotMatch(GEMINI_LIVE_PRIMARY, /SpeechSynthesisUtterance/);
  assert.match(wranglerSource, /"main":\s*"src\/worker-v13\.js"/);
});

test('Gemini Live owns search, transcription, resumption and context compression', () => {
  assert.match(GEMINI_LIVE_PRIMARY, /googleSearch: \{\}/);
  assert.match(GEMINI_LIVE_PRIMARY, /inputAudioTranscription: \{\}/);
  assert.match(GEMINI_LIVE_PRIMARY, /outputAudioTranscription: \{\}/);
  assert.match(GEMINI_LIVE_PRIMARY, /sessionResumption:/);
  assert.match(GEMINI_LIVE_PRIMARY, /contextWindowCompression: \{ slidingWindow: \{\} \}/);
  assert.match(GEMINI_LIVE_PRIMARY, /languageCode: 'ja-JP'/);
  assert.match(GEMINI_LIVE_PRIMARY, /START_OF_ACTIVITY_INTERRUPTS/);
});

test('hybrid VAD finalizes Japanese speech early while server VAD remains enabled', () => {
  assert.match(GEMINI_LIVE_PRIMARY, /END_SILENCE_MS = 480/);
  assert.match(GEMINI_LIVE_PRIMARY, /audioStreamEnd: true/);
  assert.match(GEMINI_LIVE_PRIMARY, /automaticActivityDetection:/);
  assert.match(GEMINI_LIVE_PRIMARY, /disabled: false/);
});

test('typed chat uses Gemini 3.1 realtimeInput.text in the same Live session', () => {
  assert.match(GEMINI_LIVE_PRIMARY, /realtimeInput: \{ text \}/);
  assert.doesNotMatch(GEMINI_LIVE_PRIMARY, /clientContent:/);
  assert.match(GEMINI_LIVE_PRIMARY, /inspect_current_screen/);
  assert.match(GEMINI_LIVE_PRIMARY, /toolResponse:/);
});

test('transcription finalization tolerates out-of-order turnComplete and transcription events', () => {
  assert.match(GEMINI_LIVE_PRIMARY, /TRANSCRIPT_SETTLE_MS = 320/);
  assert.match(GEMINI_LIVE_PRIMARY, /turnCompleteSeen/);
  assert.match(GEMINI_LIVE_PRIMARY, /scheduleTranscriptFinalization/);
});

test('v13 worker exposes Gemini primary and constrained ephemeral token contract', () => {
  assert.match(workerSource, /VOICE_REVISION = 'gemini-live-v13'/);
  assert.match(workerSource, /primary: 'gemini-live'/);
  assert.match(workerSource, /googleSearchGrounding: true/);
  assert.match(workerSource, /hybridVad: true/);
  assert.match(workerSource, /typedChatTransport: 'realtimeInput\.text'/);
  assert.match(workerSource, /legacyCloudflareVoiceFallback: true/);
  assert.match(workerSource, /liveConnectConstraints/);
  assert.match(workerSource, /GEMINI_API_KEY_not_configured/);
});

test('long-lived Gemini API key stays server-side', () => {
  assert.match(workerSource, /generativelanguage\.googleapis\.com\/v1beta\/auth_tokens/);
  assert.match(workerSource, /x-goog-api-key/);
  assert.match(workerSource, /uses: 1/);
  assert.doesNotMatch(GEMINI_LIVE_PRIMARY, /GEMINI_API_KEY/);
  assert.match(GEMINI_LIVE_PRIMARY, /\/api\/gemini-live-token/);
});
