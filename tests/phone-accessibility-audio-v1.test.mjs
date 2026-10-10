import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PHONE_TTS_DELIVERY_DEFAULT,
  phoneTtsDeliveryMode,
  phoneTtsDeliveryText,
  synthesizeGrokPhonePcmu,
} from '../src/telephony/phone-tts.js';
import {
  PHONE_STT_CONTEXT_PROMPT,
  STT_REVISION,
  analyzeWav,
  normalizeQuietPhoneWav,
} from '../src/stt-v45.js';

function pcm16Wav(samples, sampleRate = 8000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return buffer;
}

test('phone TTS defaults to loud and brighter expressive delivery', () => {
  assert.equal(PHONE_TTS_DELIVERY_DEFAULT, 'loud-bright');
  assert.equal(phoneTtsDeliveryMode({}), 'loud-bright');
  assert.equal(phoneTtsDeliveryText({}, 'こんにちは。'), '<loud><higher-pitch>こんにちは。</higher-pitch></loud>');
  assert.equal(phoneTtsDeliveryText({ TELEPHONY_TTS_DELIVERY: 'plain' }, 'こんにちは。'), 'こんにちは。');
});

test('Grok phone request carries expressive tags without changing PCMU transport', async () => {
  const calls = [];
  const raw = new Uint8Array(320).fill(0xff);
  const env = {
    TELEPHONY_TTS_VOICE: 'eve',
    TELEPHONY_TTS_DELIVERY: 'loud-bright',
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { result: { audio: 'https://audio.example.test/phone' } };
      },
    },
  };
  const result = await synthesizeGrokPhonePcmu(env, '別府駅をご案内します。', {
    fetchImpl: async () => ({ ok: true, headers: { get: () => 'audio/basic' }, arrayBuffer: async () => raw.buffer }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.voice_id, 'eve');
  assert.deepEqual(calls[0].input.output_format, { codec: 'mulaw', sample_rate: 8000 });
  assert.match(calls[0].input.text, /^<loud><higher-pitch>/);
  assert.match(calls[0].input.text, /別府駅/);
  assert.equal(result.metadata.delivery, 'loud-bright');
});

test('quiet phone speech is boosted before Whisper with bounded gain', () => {
  const samples = Array.from({ length: 4000 }, (_, i) => Math.round(Math.sin(i / 7) * 180));
  const wav = pcm16Wav(samples);
  const metrics = analyzeWav(wav);
  assert.equal(metrics.valid, true);
  const boosted = normalizeQuietPhoneWav(wav, metrics);
  assert.ok(boosted.gain > 1);
  assert.ok(boosted.gain <= 2.5);
  assert.ok(boosted.gainDb > 0 && boosted.gainDb <= 8.0);
  const boostedMetrics = analyzeWav(boosted.buffer);
  assert.ok(boostedMetrics.rms > metrics.rms);
  assert.ok(boostedMetrics.peak < 1);
});

test('phone STT prompt contains guarded Beppu Station proper-noun context', () => {
  assert.match(STT_REVISION, /phone-accessibility-gain-beppu/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /別府駅/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /明確/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /置き換えない/);
});

test('production sensitivity is raised while adaptive noise safeguards remain', () => {
  const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"/);
  assert.match(telephony, /noiseFloor\*2\.7/);
  assert.match(telephony, /snr>=1\.6/);
  assert.match(telephony, /speechHits>=3/);
  assert.match(telephony, /bargeThreshold=Math\.max\(threshold\*1\.25,noiseFloor\*3\.2,0\.010\)/);
});