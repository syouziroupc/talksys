import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, wrapAI, TEXT_MODEL, VISION_MODEL } from '../src/worker.js';

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

test('vision requests are routed to current UI-capable model', async () => {
  let seen;
  const ai = wrapAI({
    async run(model, input) {
      seen = { model, input };
      return { choices: [{ message: { content: '{"found":false,"x":0,"y":0,"label":"","note":"none"}' } }] };
    },
  });
  const image = 'data:image/png;base64,AA==';
  const result = await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', { messages: [], image });
  assert.equal(seen.model, VISION_MODEL);
  assert.equal(seen.input.image, image);
  assert.match(result.response, /"found":false/);
});
