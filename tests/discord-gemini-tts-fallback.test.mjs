import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_TTS_MODEL, GEMINI_TTS_FALLBACK_MODEL, __test as integrated } from '../src/integrated-entry.js';

test('Discord Gemini TTS fallback uses low-latency primary plus current fallback model', () => {
  assert.equal(GEMINI_TTS_MODEL, 'gemini-2.5-flash-preview-tts');
  assert.equal(GEMINI_TTS_FALLBACK_MODEL, 'gemini-3.1-flash-tts-preview');
});

test('PCM16 mono is wrapped as a valid 24 kHz WAV for Discord playback', () => {
  const pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 1, 0]);
  const wav = new Uint8Array(integrated.pcm16MonoToWav(pcm, 24000));
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(new TextDecoder().decode(wav.subarray(36, 40)), 'data');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), pcm.byteLength);
  assert.deepEqual([...wav.subarray(44)], [...pcm]);
});
