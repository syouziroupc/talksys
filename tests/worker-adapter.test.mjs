import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractText,
  wrapAI,
  cleanSpeechText,
  parseScreenDecision,
  MeloJapaneseTTS,
  TEXT_MODEL,
  VISION_MODEL,
  JAPANESE_TTS_MODEL,
} from '../src/voice-helpers.js';

test('extractText supports OpenAI-compatible choices', () => {
  assert.equal(extractText({ choices: [{ message: { content: '  こんにちは  ' } }] }), 'こんにちは');
});

test('extractText keeps legacy Workers AI response format', () => {
  assert.equal(extractText({ response: ' legacy ' }), 'legacy');
});

test('text requests are routed to current multilingual model', async () => {
  let seen;
  const ai = wrapAI({
    async run(model, input) {
      seen = { model, input };
      return { choices: [{ message: { content: 'ok' } }] };
    },
  });
  const result = await ai.run('@cf/meta/llama-3.1-8b-instruct-fast', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.model, TEXT_MODEL);
  assert.equal(result.response, 'ok');
});

test('vision requests are routed to current UI-capable model in non-thinking JSON mode', async () => {
  let seen;
  const ai = wrapAI({
    async run(model, input) {
      seen = { model, input };
      return { choices: [{ message: { content: '{"found":false,"x":0,"y":0,"label":"","note":"none"}' } }] };
    },
  });
  const image = 'data:image/png;base64,AA==';
  const result = await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', { messages: [], image, max_tokens: 180 });
  assert.equal(seen.model, VISION_MODEL);
  assert.equal(seen.input.image, image);
  assert.equal(seen.input.chat_template_kwargs.enable_thinking, false);
  assert.ok(seen.input.max_tokens >= 512);
  assert.match(result.response, /"found":false/);
});

test('screen decision parser accepts only explicit inspect true', () => {
  assert.deepEqual(
    parseScreenDecision('prefix {"inspect":true,"query":"保存ボタン"} suffix'),
    { inspect: true, query: '保存ボタン' },
  );
  assert.deepEqual(parseScreenDecision('{"inspect":"true","query":"x"}'), { inspect: false, query: 'x' });
  assert.deepEqual(parseScreenDecision('not json'), { inspect: false, query: '' });
});

test('speech cleaner removes visual-only markup and raw urls', () => {
  const cleaned = cleanSpeechText('**確認** https://example.com を見てください。');
  assert.equal(cleaned, '確認 リンク を見てください。');
});

test('Japanese TTS uses MeloTTS JP and decodes Workers AI base64 audio', async () => {
  let seen;
  const expected = new Uint8Array([1, 2, 3, 4]);
  const base64 = Buffer.from(expected).toString('base64');
  const tts = new MeloJapaneseTTS({
    async run(model, input, options) {
      seen = { model, input, options };
      return { audio: base64 };
    },
  });
  const audio = await tts.synthesize('こんにちは。');
  assert.equal(seen.model, JAPANESE_TTS_MODEL);
  assert.equal(seen.input.lang, 'JP');
  assert.equal(seen.input.prompt, 'こんにちは。');
  assert.equal(seen.options, undefined);
  assert.deepEqual(new Uint8Array(audio), expected);
});
