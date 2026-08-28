import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GEMINI_LIVE_CLIENT } from '../src/gemini-live-client.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v13.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Gemini Live is the primary low-latency voice path', () => {
  assert.match(GEMINI_LIVE_CLIENT, /gemini-3\.1-flash-live-preview/);
  assert.match(GEMINI_LIVE_CLIENT, /BidiGenerateContentConstrained/);
  assert.match(GEMINI_LIVE_CLIENT, /audio\/pcm;rate=/);
  assert.match(GEMINI_LIVE_CLIENT, /OUTPUT_RATE = 24000/);
  assert.match(GEMINI_LIVE_CLIENT, /CHUNK_SAMPLES = 640/);
  assert.doesNotMatch(GEMINI_LIVE_CLIENT, /SpeechSynthesisUtterance/);
  assert.match(wranglerSource, /"main":\s*"src\/worker-v13\.js"/);
});

test('Gemini Live session owns search, transcription and long-running context', () => {
  assert.match(GEMINI_LIVE_CLIENT, /googleSearch: \{\}/);
  assert.match(GEMINI_LIVE_CLIENT, /inputAudioTranscription: \{\}/);
  assert.match(GEMINI_LIVE_CLIENT, /outputAudioTranscription: \{\}/);
  assert.match(GEMINI_LIVE_CLIENT, /sessionResumption:/);
  assert.match(GEMINI_LIVE_CLIENT, /contextWindowCompression: \{ slidingWindow: \{\} \}/);
  assert.match(GEMINI_LIVE_CLIENT, /languageCode: 'ja-JP'/);
  assert.match(GEMINI_LIVE_CLIENT, /START_OF_ACTIVITY_INTERRUPTS/);
});

test('typed chat and screen inspection share the same Live session', () => {
  assert.match(GEMINI_LIVE_CLIENT, /clientContent:/);
  assert.match(GEMINI_LIVE_CLIENT, /turnComplete: true/);
  assert.match(GEMINI_LIVE_CLIENT, /inspect_current_screen/);
  assert.match(GEMINI_LIVE_CLIENT, /toolResponse:/);
});

test('v13 worker exposes Gemini primary and explicit legacy fallback contract', () => {
  assert.match(workerSource, /VOICE_REVISION = 'gemini-live-v13'/);
  assert.match(workerSource, /primary: 'gemini-live'/);
  assert.match(workerSource, /googleSearchGrounding: true/);
  assert.match(workerSource, /sessionResumption: true/);
  assert.match(workerSource, /contextWindowCompression: true/);
  assert.match(workerSource, /typedChatSharesLiveSession: true/);
  assert.match(workerSource, /legacyCloudflareVoiceFallback: true/);
  assert.match(workerSource, /GEMINI_API_KEY_not_configured/);
});

test('Gemini ephemeral token remains server-side and client receives only token endpoint output', () => {
  assert.match(workerSource, /generativelanguage\.googleapis\.com\/v1beta\/auth_tokens/);
  assert.match(workerSource, /x-goog-api-key/);
  assert.match(workerSource, /uses: 1/);
  assert.doesNotMatch(GEMINI_LIVE_CLIENT, /GEMINI_API_KEY/);
  assert.match(GEMINI_LIVE_CLIENT, /\/api\/gemini-live-token/);
});
