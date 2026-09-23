import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERIC_VERIFICATION_REVISION,
  __test,
} from '../src/integrated-entry.js';

const {
  shouldRunGenericVerification,
  shouldStronglyPreferSearch,
  runGeminiTurn,
} = __test;

const FIXED = new Date('2026-09-17T11:00:00Z');

test('v84 disables serial generic verification while preserving the revision marker', () => {
  assert.equal(GENERIC_VERIFICATION_REVISION, 'talksys-v59-evidence-reuse-verify-r1');
  for (const text of ['こんにちは', '12345÷15', '富士山の高さは？', 'A店は今営業していますか？']) {
    assert.equal(shouldRunGenericVerification(text, {}), false, text);
  }
});

test('search preference still identifies nontrivial external-fact turns', () => {
  assert.equal(shouldStronglyPreferSearch('こんにちは'), false);
  assert.equal(shouldStronglyPreferSearch('ありがとう'), false);
  assert.equal(shouldStronglyPreferSearch('富士山の高さは？'), true);
  assert.equal(shouldStronglyPreferSearch('A店は今営業していますか？'), true);
});

test('dynamic factual turn uses one grounded Gemini interaction', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    assert.equal(req.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(req.tools, [{ type: 'google_search' }]);
    assert.match(req.system_instruction, /同じ内容を検証目的で二重検索しない/);
    return new Response(JSON.stringify({
      id: 'primary-grounded',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['A店 営業時間'] } },
        { type: 'google_search_result', result: [{ title: 'A店公式', url: 'https://example.com/a' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'A店は19時に閉店しています。' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn(
      { text: 'A店は今営業していますか？', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: FIXED },
    );
    assert.equal(calls, 1);
    assert.equal(result.search, true);
    assert.equal(result.genericVerificationAttempted, false);
    assert.equal(result.genericVerificationSucceeded, false);
    assert.equal(result.verifierSearched, false);
    assert.equal(result.verificationFailOpen, false);
    assert.match(result.answer, /19時/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dynamic fact without any search evidence fails closed in one pass', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: 'primary-ungrounded',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: '製品Xの最新バージョンは5.2です。' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn(
      { text: '製品Xの最新バージョンは？', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: FIXED },
    );
    assert.equal(calls, 1);
    assert.equal(result.groundingRequired, true);
    assert.equal(result.groundingFailClosed, true);
    assert.doesNotMatch(result.answer, /5点2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
