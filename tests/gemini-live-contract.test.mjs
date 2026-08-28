import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker-v13.js';
import { GEMINI_LIVE_CLIENT } from '../src/gemini-live-client.js';

test('Gemini Live is the primary low-latency voice path', () => {
  assert.match(GEMINI_LIVE_CLIENT, /gemini-3\.1-flash-live-preview/);
  assert.match(GEMINI_LIVE_CLIENT, /BidiGenerateContentConstrained/);
  assert.match(GEMINI_LIVE_CLIENT, /audio\/pcm;rate=/);
  assert.match(GEMINI_LIVE_CLIENT, /OUTPUT_RATE = 24000/);
  assert.match(GEMINI_LIVE_CLIENT, /CHUNK_SAMPLES = 640/);
  assert.doesNotMatch(GEMINI_LIVE_CLIENT, /SpeechSynthesisUtterance/);
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

test('v13 health reports Gemini primary and explicit legacy fallback', async () => {
  const response = await worker.fetch(new Request('https://example.com/voice-health'), {}, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.voiceRevision, 'gemini-live-v13');
  assert.equal(body.primary, 'gemini-live');
  assert.equal(body.googleSearchGrounding, true);
  assert.equal(body.sessionResumption, true);
  assert.equal(body.contextWindowCompression, true);
  assert.equal(body.typedChatSharesLiveSession, true);
  assert.equal(body.legacyCloudflareVoiceFallback, true);
  assert.equal(body.geminiLiveConfigured, false);
});

test('Gemini token endpoint fails closed when server API key is absent', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/gemini-live-token', { method: 'POST' }), {}, {});
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.reason, 'GEMINI_API_KEY_not_configured');
});
