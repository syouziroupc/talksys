import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GEMINI_PHONE_CLIENT } from '../src/gemini-phone-client.js';

const worker = fs.readFileSync(new URL('../src/worker-v13.js', import.meta.url), 'utf8');

test('Gemini phone mode is the primary voice client', () => {
  assert.match(worker, /GEMINI_PHONE_CLIENT/);
  assert.match(worker, /phoneMode: true/);
  assert.match(GEMINI_PHONE_CLIENT, /gemini-3\.1-flash-live-preview/);
  assert.doesNotMatch(GEMINI_PHONE_CLIENT, /SpeechSynthesisUtterance/);
});

test('phone mode uses fast hybrid VAD and barge-in', () => {
  assert.match(GEMINI_PHONE_CLIENT, /LOCAL_END_SILENCE_MS = 440/);
  assert.match(GEMINI_PHONE_CLIENT, /BARGE_FRAMES = 3/);
  assert.match(GEMINI_PHONE_CLIENT, /audioStreamEnd: true/);
  assert.match(GEMINI_PHONE_CLIENT, /START_OF_ACTIVITY_INTERRUPTS/);
  assert.match(worker, /bargeInDetectionMs: 120/);
});

test('typed chat, grounding and session state stay inside the Live session', () => {
  assert.match(GEMINI_PHONE_CLIENT, /realtimeInput: \{ text \}/);
  assert.match(GEMINI_PHONE_CLIENT, /googleSearch: \{\}/);
  assert.match(GEMINI_PHONE_CLIENT, /sessionResumption:/);
  assert.match(GEMINI_PHONE_CLIENT, /contextWindowCompression:/);
  assert.match(GEMINI_PHONE_CLIENT, /thinkingLevel: 'minimal'/);
});

test('phone mode recovers common Live websocket failures', () => {
  assert.match(GEMINI_PHONE_CLIENT, /event\.code === 1007 \|\| event\.code === 1011/);
  assert.match(GEMINI_PHONE_CLIENT, /sessionStorage\.removeItem\(HANDLE_KEY\)/);
  assert.match(GEMINI_PHONE_CLIENT, /RECONNECT_MS = 250/);
});
