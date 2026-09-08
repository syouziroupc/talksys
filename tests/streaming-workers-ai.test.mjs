import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamWorkersAIText,
  readDelta,
  splitSpeechChunks,
  LIVE_VOICE_MODEL,
  GROUNDING_VOICE_MODEL,
  liveModelInput,
  isGroundedInput,
  withGroundedAnswerPolicy,
} from '../src/streaming-workers-ai.js';

test('live voice uses Qwen 3.8 27B with thinking disabled', () => {
  assert.equal(LIVE_VOICE_MODEL, '@cf/qwen/qwen3.8-27b');
  const input = liveModelInput({ messages: [], max_tokens: 220, temperature: 0.3 });
  assert.equal(input.stream, true);
  assert.equal(input.max_completion_tokens, 220);
  assert.equal(input.reasoning_effort, null);
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

test('grounded marker is detected and policy forbids user-supplied-search phrasing', () => {
  const input = {
    messages: [
      { role: 'system', content: '検索結果だけを根拠にする。' },
      { role: 'user', content: '大分から大阪への便はある？\n\n[ウェブ検索結果]\n[1] 時刻表' },
    ],
  };
  assert.equal(isGroundedInput(input), true);
  const prepared = withGroundedAnswerPolicy(input);
  assert.match(prepared.messages[0].content, /検索責任をユーザーへ返す表現は禁止/);
  assert.match(prepared.messages[0].content, /一段階で導ける結論/);
});

test('grounded policy allows useful advice when retrieved evidence is irrelevant', () => {
  const input = {
    messages: [
      { role: 'system', content: 'grounded' },
      { role: 'assistant', content: '3万円くらいならネット閲覧と動画視聴向けのノートPCを考えましょう。' },
      { role: 'user', content: 'どこで買うのがいいかな\n\n[ウェブ検索結果]\n有効な検索結果なし。外部事実は推測しないこと。' },
    ],
  };
  const prepared = withGroundedAnswerPolicy(input);
  const policy = prepared.messages[0].content;
  assert.match(policy, /回答全体を拒否しない/);
  assert.match(policy, /目的、予算、対象商品、用途/);
  assert.match(policy, /購入チャネル/);
  assert.match(policy, /最新価格、在庫、営業時間/);
});

test('search-grounded voice routes to gpt-oss instead of the live model', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"あります。"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"時刻表でも確認できます。"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const called = [];
  const ai = {
    async run(model, input) {
      called.push(model);
      assert.equal(model, GROUNDING_VOICE_MODEL);
      assert.equal(input.stream, true);
      assert.match(input.messages[0].content, /ユーザーが提示した資料ではない/);
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    },
  };
  const spoken = [];
  const text = await streamWorkersAIText(ai, LIVE_VOICE_MODEL, {
    messages: [
      { role: 'system', content: 'grounded' },
      { role: 'user', content: '[ウェブ検索結果]\n時刻表' },
    ],
  }, {
    onSpeechChunk(chunk, sequence) { spoken.push({ chunk, sequence }); },
  });
  assert.deepEqual(called, [GROUNDING_VOICE_MODEL]);
  assert.equal(text, 'あります。時刻表でも確認できます。');
  assert.deepEqual(spoken, [
    { chunk: 'あります。', sequence: 0 },
    { chunk: '時刻表でも確認できます。', sequence: 1 },
  ]);
});

test('grounding model opening failure falls back to requested live model', async () => {
  const encoder = new TextEncoder();
  const called = [];
  const ai = {
    async run(model) {
      called.push(model);
      if (model === GROUNDING_VOICE_MODEL) throw new Error('grounding unavailable');
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"代替回答です。"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
    },
  };
  const text = await streamWorkersAIText(ai, LIVE_VOICE_MODEL, {
    messages: [
      { role: 'system', content: 'grounded' },
      { role: 'user', content: '[ウェブ検索結果]\n根拠' },
    ],
  });
  assert.deepEqual(called, [GROUNDING_VOICE_MODEL, LIVE_VOICE_MODEL]);
  assert.equal(text, '代替回答です。');
});
