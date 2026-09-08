import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamResult,
  streamCloudflareLiveConversation,
} from '../src/cloudflare-llm.js';

async function collect(iterable) {
  let text = '';
  for await (const part of iterable) text += String(part || '');
  return text;
}

function sseStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

test('real ReadableStream SSE bytes are decoded before generic async iteration', async () => {
  const stream = sseStream([
    'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  // This is the exact trap that broke v18.2: ReadableStream is also async iterable.
  assert.equal(typeof stream[Symbol.asyncIterator], 'function');
  assert.equal(await collect(streamResult(stream, { firstTokenTimeoutMs: 1000 })), 'こんにちは');
});

test('empty live byte stream falls back once instead of silently ending the turn', async () => {
  let calls = 0;
  const ai = {
    async run(_model, input) {
      calls += 1;
      if (input.stream) return sseStream(['data: [DONE]\n\n']);
      return { choices: [{ message: { content: '復旧応答' } }] };
    },
  };

  const answer = await collect(streamCloudflareLiveConversation(
    ai,
    [{ role: 'user', content: 'こんにちは' }],
    { firstTokenTimeoutMs: 1000 },
  ));

  assert.equal(answer, '復旧応答');
  assert.equal(calls, 2);
});
