import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TALKSYS_CONVERSATION_MODEL_V28,
  streamQwenConversationV28,
} from '../src/qwen-conversation-v28.js';

async function collect(iterable) {
  let out = '';
  for await (const chunk of iterable) out += String(chunk || '');
  return out;
}

function sseStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

test('v28 has exactly one active conversation model and disables Qwen thinking', async () => {
  const calls = [];
  const ai = {
    run(model, input) {
      calls.push({ model, input });
      return Promise.resolve(sseStream('簡潔に答えます。'));
    },
  };
  const text = await collect(streamQwenConversationV28(ai, [{ role: 'user', content: 'こんにちは' }]));
  assert.equal(text, '簡潔に答えます。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, '@cf/qwen/qwen3.8-27b');
  assert.equal(TALKSYS_CONVERSATION_MODEL_V28, calls[0].model);
  assert.equal(calls[0].input.chat_template_kwargs.enable_thinking, false);
  assert.equal(calls[0].input.chat_template_kwargs.clear_thinking, true);
  assert.equal(calls[0].input.reasoning_effort, null);
});

test('v28 retries the same Qwen model once instead of switching models', async () => {
  const calls = [];
  const ai = {
    run(model, input) {
      calls.push({ model, input });
      if (calls.length === 1) return Promise.reject(new Error('temporary stream failure'));
      return Promise.resolve({ response: '同じモデルで復旧しました。' });
    },
  };
  const text = await collect(streamQwenConversationV28(ai, [{ role: 'user', content: '相談です' }], {
    openTimeoutMs: 100,
    retryTimeoutMs: 300,
  }));
  assert.equal(text, '同じモデルで復旧しました。');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.model), [TALKSYS_CONVERSATION_MODEL_V28, TALKSYS_CONVERSATION_MODEL_V28]);
  assert.equal(calls[0].input.stream, true);
  assert.equal(calls[1].input.stream, false);
});

test('v28 production path contains no active GLM, Grok, DeepSeek, or GPT-OSS model route', async () => {
  const [worker, production, helper, wrangler] = await Promise.all([
    readFile(new URL('../src/worker-v28.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/worker-v28-production.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/qwen-conversation-v28.js', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  ]);
  const active = `${worker}\n${production}\n${helper}`;
  assert.match(active, /@cf\/qwen\/qwen3\.8-27b/);
  assert.doesNotMatch(active, /xai\/grok-|@cf\/zai-org\/glm-|@cf\/deepseek-ai\/deepseek-|@cf\/openai\/gpt-oss-/i);
  assert.doesNotMatch(worker, /worker-v2[5-7]\.js/);
  assert.match(worker, /CLOUDFLARE_LIVE_CLIENT_V26/);
  assert.match(worker, /collectGroundedEvidenceV26/);
  assert.match(production, /conversationModelFallback:\s*null/);
  assert.match(production, /conversationEmergencyFallback:\s*null/);
  assert.match(production, /multiModelFallback:\s*false/);
  assert.match(wrangler, /"main":\s*"src\/worker-v28-production\.js"/);
});
