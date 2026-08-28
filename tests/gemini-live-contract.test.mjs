import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GEMINI_PHONE_CLIENT } from '../src/gemini-phone-client.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v13.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Gemini Live is the primary low-latency native audio phone path', () => {
  assert.match(GEMINI_PHONE_CLIENT, /gemini-3\.1-flash-live-preview/);
  assert.match(GEMINI_PHONE_CLIENT, /audio\/pcm;rate=/);
  assert.match(GEMINI_PHONE_CLIENT, /OUTPUT_RATE = 24000/);
  assert.match(GEMINI_PHONE_CLIENT, /CHUNK_SAMPLES = 640/);
  assert.match(GEMINI_PHONE_CLIENT, /thinkingLevel: 'minimal'/);
  assert.doesNotMatch(GEMINI_PHONE_CLIENT, /SpeechSynthesisUtterance/);
  assert.match(wranglerSource, /"main":\s*"src\/worker-v13\.js"/);
});

test('Gemini Live owns search, transcription, resumption and context compression', () => {
  assert.match(GEMINI_PHONE_CLIENT, /googleSearch: \{\}/);
  assert.match(GEMINI_PHONE_CLIENT, /inputAudioTranscription: \{\}/);
  assert.match(GEMINI_PHONE_CLIENT, /outputAudioTranscription: \{\}/);
  assert.match(GEMINI_PHONE_CLIENT, /sessionResumption:/);
  assert.match(GEMINI_PHONE_CLIENT, /contextWindowCompression: \{ slidingWindow: \{\} \}/);
  assert.match(GEMINI_PHONE_CLIENT, /languageCode: 'ja-JP'/);
  assert.match(GEMINI_PHONE_CLIENT, /START_OF_ACTIVITY_INTERRUPTS/);
});

test('hybrid VAD finalizes Japanese speech early while server VAD remains enabled', () => {
  assert.match(GEMINI_PHONE_CLIENT, /LOCAL_END_SILENCE_MS = 440/);
  assert.match(GEMINI_PHONE_CLIENT, /audioStreamEnd: true/);
  assert.match(GEMINI_PHONE_CLIENT, /automaticActivityDetection:/);
  assert.match(GEMINI_PHONE_CLIENT, /disabled: false/);
});

test('typed chat uses Gemini realtimeInput.text in the same Live session', () => {
  assert.match(GEMINI_PHONE_CLIENT, /realtimeInput: \{ text \}/);
  assert.doesNotMatch(GEMINI_PHONE_CLIENT, /clientContent:/);
  assert.match(GEMINI_PHONE_CLIENT, /inspect_current_screen/);
  assert.match(GEMINI_PHONE_CLIENT, /toolResponse:/);
});

test('transcription finalization tolerates out-of-order turnComplete and transcription events', () => {
  assert.match(GEMINI_PHONE_CLIENT, /TRANSCRIPT_SETTLE_MS = 420/);
  assert.match(GEMINI_PHONE_CLIENT, /scheduleSettle/);
});

test('v13 worker exposes phone mode and constrained ephemeral token contract', () => {
  assert.match(workerSource, /VOICE_REVISION = 'gemini-live-v13'/);
  assert.match(workerSource, /primary: 'gemini-live'/);
  assert.match(workerSource, /phoneMode: true/);
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
  assert.doesNotMatch(GEMINI_PHONE_CLIENT, /GEMINI_API_KEY/);
  assert.match(GEMINI_PHONE_CLIENT, /\/api\/gemini-live-token/);
});
