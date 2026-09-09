import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  streamGrokConversationV27,
  GROK_CONVERSATION_MODEL_V27,
  GROK_FALLBACK_MODEL_V27,
  GROK_EMERGENCY_MODEL_V27,
} from '../src/grok-conversation-v27.js';

async function collect(iterable) {
  let out = '';
  for await (const chunk of iterable) out += chunk;
  return out;
}

test('v27 uses Grok 4.20 non-reasoning as primary with GLM and Qwen fallbacks', () => {
  assert.equal(GROK_CONVERSATION_MODEL_V27, 'xai/grok-4.20-0309-non-reasoning');
  assert.equal(GROK_FALLBACK_MODEL_V27, '@cf/zai-org/glm-5.3-flash');
  assert.equal(GROK_EMERGENCY_MODEL_V27, '@cf/qwen/qwen3.8-27b');
});

test('Grok primary receives chat-completions streaming input without reasoning fields', async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return { choices: [{ message: { content: 'Grokの応答です。' } }] };
    },
  };
  const text = await collect(streamGrokConversationV27(ai, [{ role: 'user', content: 'こんにちは' }], {
    maxTokens: 123,
  }));
  assert.equal(text, 'Grokの応答です。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, GROK_CONVERSATION_MODEL_V27);
  assert.equal(calls[0].input.stream, true);
  assert.equal(calls[0].input.max_completion_tokens, 123);
  assert.deepEqual(calls[0].input.stream_options, { include_usage: true });
  assert.equal('reasoning_effort' in calls[0].input, false);
  assert.equal('chat_template_kwargs' in calls[0].input, false);
});

test('Grok unified-billing failure immediately falls through to Cloudflare-hosted GLM', async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      if (model === GROK_CONVERSATION_MODEL_V27) throw new Error('2021: Insufficient AI Gateway credits');
      if (model === GROK_FALLBACK_MODEL_V27) return { choices: [{ message: { content: 'GLMで継続できます。' } }] };
      throw new Error('unexpected model');
    },
  };
  const text = await collect(streamGrokConversationV27(ai, [{ role: 'user', content: 'テスト' }]));
  assert.equal(text, 'GLMで継続できます。');
  assert.deepEqual(calls.map((item) => item.model), [GROK_CONVERSATION_MODEL_V27, GROK_FALLBACK_MODEL_V27]);
  assert.equal(calls[1].input.reasoning_effort, 'low');
});

test('v27 production keeps Android v26 capture fixes while moving conversation to Grok', () => {
  const worker = fs.readFileSync(new URL('../src/worker-v27.js', import.meta.url), 'utf8');
  const production = fs.readFileSync(new URL('../src/worker-v27-production.js', import.meta.url), 'utf8');
  const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(worker, /grok-primary-bounded-cascade-v27/);
  assert.match(worker, /MeloJapaneseTTS/);
  assert.match(worker, /androidAudioWorkletPreferred/);
  assert.match(production, /cloudflare-agent-v27-grok-conversation-android-realtime/);
  assert.match(wrangler, /worker-v27-production\.js/);
});
