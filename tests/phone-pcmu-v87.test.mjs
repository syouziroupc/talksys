import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHONE_TTS_FRAME_BYTES,
  PHONE_TTS_MODEL,
  PHONE_TTS_SAMPLE_RATE,
  extractMulawPayload,
  inspectPcmu,
  streamPcmu20ms,
  synthesizeGrokPhonePcmu,
  validatePcmuResponse,
} from '../src/telephony/phone-tts.js';

function mulawWav(data) {
  const bytes = Uint8Array.from(data);
  const buffer = new ArrayBuffer(44 + bytes.length);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) out[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 7, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, bytes.length, true);
  out.set(bytes, 44);
  return out;
}

test('phone TTS contract is Grok PCMU 8 kHz with 20 ms frames', () => {
  assert.equal(PHONE_TTS_MODEL, 'xai/grok-tts');
  assert.equal(PHONE_TTS_SAMPLE_RATE, 8000);
  assert.equal(PHONE_TTS_FRAME_BYTES, 160);
});

test('raw PCMU is accepted and inspected', () => {
  const raw = Uint8Array.from({ length: 8000 }, (_, i) => (i % 2 ? 0xff : 0x7f));
  const result = validatePcmuResponse(raw, 'audio/basic; rate=8000');
  assert.equal(result.bytes.length, 8000);
  assert.equal(result.metadata.container, 'raw');
  assert.equal(result.metadata.durationMs, 1000);
  assert.equal(result.metadata.sampleRate, 8000);
});

test('valid G.711 mu-law WAV is accepted and its data chunk extracted', () => {
  const wav = mulawWav(new Array(320).fill(0xff));
  const result = validatePcmuResponse(wav, 'audio/wav');
  assert.equal(result.bytes.length, 320);
  assert.equal(result.metadata.container, 'wav-mulaw');
  assert.equal(result.metadata.durationMs, 40);
});

test('PCM WAV, MP3, JSON, HTML, empty and wrong content types are rejected', () => {
  const pcmWav = mulawWav(new Array(320).fill(0xff));
  new DataView(pcmWav.buffer).setUint16(20, 1, true);
  assert.throws(() => extractMulawPayload(pcmWav, 'audio/wav'), /unexpected_wav_format/);
  assert.throws(() => validatePcmuResponse(Uint8Array.from([0x49, 0x44, 0x33, 0x04]), 'audio/mpeg'), /unexpected_mp3/);
  assert.throws(() => validatePcmuResponse(new TextEncoder().encode('{"error":"bad"}'), 'application/json'), /unexpected_text_payload/);
  assert.throws(() => validatePcmuResponse(new TextEncoder().encode('<html>bad</html>'), 'text/html'), /unexpected_text_payload/);
  assert.throws(() => validatePcmuResponse(new Uint8Array(), 'audio/basic'), /empty_audio/);
  assert.throws(() => validatePcmuResponse(new Uint8Array(320).fill(0xff), 'audio/ogg'), /unexpected_content_type/);
});

test('too-short and too-long PCMU are rejected', () => {
  assert.throws(() => inspectPcmu(new Uint8Array(80).fill(0xff)), /too_short/);
  assert.throws(() => inspectPcmu(new Uint8Array(8000 * 121).fill(0xff)), /too_long/);
});

test('Grok request asks Cloudflare for Japanese mulaw 8 kHz through gateway', async () => {
  const calls = [];
  const raw = new Uint8Array(320).fill(0xff);
  const env = {
    TELEPHONY_AI_GATEWAY_ID: 'default',
    AI: {
      async run(model, input, options) {
        calls.push({ model, input, options });
        return { result: { audio: 'https://audio.example.test/phone.bin' }, gatewayMetadata: { keySource: 'Unified' } };
      },
    },
  };
  const result = await synthesizeGrokPhonePcmu(env, 'こんにちは。音声テストです。', {
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'audio/basic' : null },
      arrayBuffer: async () => raw.buffer,
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'xai/grok-tts');
  assert.equal(calls[0].input.language, 'ja');
  assert.deepEqual(calls[0].input.output_format, { codec: 'mulaw', sample_rate: 8000 });
  assert.equal(calls[0].input.text_normalization, false);
  assert.equal(calls[0].options.gateway.id, 'default');
  assert.equal(result.metadata.gatewayKeySource, 'Unified');
  assert.equal(result.metadata.codec, 'PCMU');
});

test('20 ms streamer sends 160-byte frames in order and paces between frames', async () => {
  const bytes = Uint8Array.from({ length: 400 }, (_, i) => i & 0xff);
  const payloads = [];
  const sleeps = [];
  const result = await streamPcmu20ms(bytes, {
    sendPayload: (payload) => payloads.push(Buffer.from(payload, 'base64')),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(result.completed, true);
  assert.equal(result.frames, 3);
  assert.equal(result.sentBytes, 400);
  assert.deepEqual(payloads.map((x) => x.length), [160, 160, 80]);
  assert.deepEqual(sleeps, [20, 20]);
  assert.deepEqual(Buffer.concat(payloads), Buffer.from(bytes));
});

test('20 ms streamer stops before sending more data after cancellation', async () => {
  const bytes = new Uint8Array(640).fill(0xff);
  let sends = 0;
  let cancelled = false;
  const result = await streamPcmu20ms(bytes, {
    sendPayload: () => { sends += 1; },
    sleep: async () => { cancelled = true; },
    isCancelled: () => cancelled,
  });
  assert.equal(result.completed, false);
  assert.equal(result.cancelled, true);
  assert.equal(sends, 1);
  assert.equal(result.sentBytes, 160);
});
