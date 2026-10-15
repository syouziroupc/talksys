// Quality-first v61 regression contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __test,
} from '../src/integrated-entry.js';
import {
  FAST_REACTION_REVISION,
  fastReaction,
} from '../src/voice-fast-reaction.js';

const {
  buildTalkSysSystemInstruction,
  runGeminiTurn,
} = __test;

test('v84 quality-first prompt avoids duplicate search while keeping external facts grounded', () => {
  const prompt = buildTalkSysSystemInstruction(new Date('2026-09-18T05:00:00Z'));
  assert.match(prompt, /質問へ直接、正確かつ簡潔に答えて/);
  assert.match(prompt, /外部事実や現在情報が必要な質問ではGoogle検索を使い/);
  assert.match(prompt, /古い値を現在値として断定しない/);
  assert.match(prompt, /検索結果や会話履歴にない固有名詞/);
});

test('pure greeting does not even expose Google Search to Gemini', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    assert.equal(Object.hasOwn(req, 'tools'), false);
    return new Response(JSON.stringify({
      id: 'greeting',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'こんにちは。' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn(
      { text: 'こんにちは', history: [] },
      { GEMINI_API_KEY: 'test-key' },
    );
    assert.equal(calls, 1);
    assert.equal(result.search, false);
    assert.equal(result.genericVerificationAttempted, false);
    assert.match(result.answer, /こんにちは/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fast reaction is deliberately longer while quality-first answer is being prepared', () => {
  assert.equal(FAST_REACTION_REVISION, 'talksys-v61-quality-buffer-r1');

  const lookup = fastReaction('今日の天気を調べて');
  assert.equal(lookup.kind, 'lookup');
  assert.match(lookup.text, /調べ|確認|検索/);
  assert.ok(lookup.text.length >= 8);

  const question = fastReaction('このCPUは対応していますか？');
  assert.equal(question.kind, 'lookup');

  const request = fastReaction('文章を考えてほしい');
  assert.equal(request.kind, 'request');
  assert.equal(request.text, 'はい、内容を確認しますね。');

  const genericQuestion = fastReaction('これは大丈夫ですか？');
  assert.equal(genericQuestion.kind, 'question');
  assert.equal(genericQuestion.text, 'はい、確認してお答えしますね。');
});
