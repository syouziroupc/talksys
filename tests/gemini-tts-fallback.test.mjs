import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_TTS_MODEL,
  GEMINI_TTS_FALLBACK_MODEL,
  __test as integrated,
} from '../src/integrated-entry.js';

test('Gemini TTS reads generateContent inlineData audio', () => {
  const encoded = Buffer.from([1, 2, 3, 4]).toString('base64');
  assert.equal(integrated.geminiTtsAudioData({
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'audio/L16;codec=pcm;rate=24000',
            data: encoded,
          },
        }],
      },
    }],
  }), encoded);
});

test('Gemini TTS uses generateContent AUDIO contract and wraps PCM as WAV', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body || '{}')) });
      const pcm = Buffer.alloc(2400, 1).toString('base64');
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: 'audio/L16;codec=pcm;rate=24000',
                data: pcm,
              },
            }],
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const wav = await integrated.synthesizeGeminiJapaneseTtsModel(
      'フォーンズです。接続しました。',
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      GEMINI_TTS_MODEL,
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-flash-preview-tts:generateContent$/);
    assert.deepEqual(calls[0].body.contents, [{ parts: [{ text: 'フォーンズです。接続しました。' }] }]);
    assert.deepEqual(calls[0].body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(calls[0].body.generationConfig.speechConfig.languageCode, 'ja-JP');
    assert.equal(
      calls[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      'Kore',
    );

    const bytes = new Uint8Array(wav);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
    assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), 'WAVE');
    assert.ok(bytes.byteLength > 44);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini TTS model cascade keeps a second model available', () => {
  assert.equal(GEMINI_TTS_MODEL, 'gemini-2.5-flash-preview-tts');
  assert.equal(GEMINI_TTS_FALLBACK_MODEL, 'gemini-3.1-flash-tts-preview');
});
