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
  assert.match(prompt, /明確なあいさつ、礼、短い相づち、単純計算/);
  assert.match(prompt, /外部事実を含む回答は検索根拠を優先/);
  assert.match(prompt, /同じ内容を検証目的で二重検索しない/);
  assert.match(prompt, /根拠がない固有名詞/);
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
