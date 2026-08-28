import test from 'node:test';
import assert from 'node:assert/strict';
import { streamWorkersAIText, readDelta, splitSpeechChunks, LIVE_VOICE_MODEL, liveModelInput } from '../src/streaming-workers-ai.js';

test('live voice uses one GLM 5.3 Flash model', () => {
  assert.equal(LIVE_VOICE_MODEL, '@cf/zai-org/glm-5.3-flash');
  const input = liveModelInput({ messages: [], max_tokens: 220, temperature: 0.3 });
  assert.equal(input.stream, true);
  assert.equal(input.max_completion_tokens, 220);
  assert.equal(input.reasoning_effort, 'low');
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.equal(input.chat_template_kwargs.clear_thinking, true);
});

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

test('streamWorkersAIText ignores logical tier and streams the unified live model', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"最初の答えです。"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"続きも説明します。"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const ai = {
    async run(model, input) {
      assert.equal(model, LIVE_VOICE_MODEL);
      assert.equal(input.stream, true);
      assert.equal(input.chat_template_kwargs.enable_thinking, false);
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    },
  };
  const spoken = [];
  const text = await streamWorkersAIText(ai, '@cf/openai/gpt-oss-120b', { messages: [] }, {
    onSpeechChunk(chunk, sequence) { spoken.push({ chunk, sequence }); },
  });
  assert.equal(text, '最初の答えです。続きも説明します。');
  assert.deepEqual(spoken, [
    { chunk: '最初の答えです。', sequence: 0 },
    { chunk: '続きも説明します。', sequence: 1 },
  ]);
});
