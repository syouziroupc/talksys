import test from 'node:test';
import assert from 'node:assert/strict';
import { streamWorkersAIText, readDelta, splitSpeechChunks } from '../src/streaming-workers-ai.js';

test('readDelta accepts OpenAI and Workers AI streaming shapes', () => {
  assert.equal(readDelta({ choices: [{ delta: { content: 'こんにちは' } }] }), 'こんにちは');
  assert.equal(readDelta({ response: '世界' }), '世界');
});

test('splitSpeechChunks emits completed Japanese sentences early', () => {
  const first = splitSpeechChunks('まず結論です。次の文は途中', false);
  assert.deepEqual(first.chunks, ['まず結論です。']);
  assert.equal(first.rest, '次の文は途中');
  const final = splitSpeechChunks(first.rest, true);
  assert.deepEqual(final.chunks, ['次の文は途中']);
});

test('streamWorkersAIText emits speech chunks before stream completion', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"最初の答えです。"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"続きも説明します。"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const ai = {
    async run(_model, input) {
      assert.equal(input.stream, true);
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    },
  };
  const spoken = [];
  const text = await streamWorkersAIText(ai, '@cf/test', { messages: [] }, {
    onSpeechChunk(chunk, sequence) { spoken.push({ chunk, sequence }); },
  });
  assert.equal(text, '最初の答えです。続きも説明します。');
  assert.deepEqual(spoken, [
    { chunk: '最初の答えです。', sequence: 0 },
    { chunk: '続きも説明します。', sequence: 1 },
  ]);
});
