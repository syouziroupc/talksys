import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arithmeticExpressionFromQuestion,
  evaluateArithmeticExpression,
  shouldForceVerifierSearch,
  runGeminiTurn,
} from '../src/integrated-entry.js';

function searchedPayload() {
  return {
    id: 'primary-search',
    steps: [
      { type: 'google_search_call', arguments: { queries: ['Panasonic CF-SV8 Windows 11 対応'] } },
      { type: 'google_search_result', result: [{ title: 'Microsoft', url: 'https://example.com/windows11' }] },
      { type: 'model_output', content: [{ type: 'text', text: '候補回答です。' }] },
    ],
  };
}

test('pure arithmetic is detected only when the remaining input is an arithmetic expression', () => {
  assert.equal(arithmeticExpressionFromQuestion('12345÷15は？'), '12345/15');
  assert.equal(arithmeticExpressionFromQuestion('(12 + 3) × 4 はいくつですか？'), '(12+3)*4');
  assert.equal(arithmeticExpressionFromQuestion('CF-SV8はWindows 11に対応している？'), '');
});

test('deterministic arithmetic evaluator keeps precedence and parentheses', () => {
  assert.equal(evaluateArithmeticExpression('12345/15'), 823);
  assert.equal(evaluateArithmeticExpression('(12+3)*4'), 60);
  assert.equal(evaluateArithmeticExpression('10-2*3'), 4);
  assert.throws(() => evaluateArithmeticExpression('1/0'));
});

test('pure arithmetic never calls Gemini or Google and returns immediately through the normal turn contract', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network must not be used for deterministic arithmetic');
  };
  try {
    const result = await runGeminiTurn({ text: '12345÷15は？', history: [] }, {});
    assert.equal(calls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.route, 'deterministic-arithmetic');
    assert.equal(result.answer, '823です。');
    assert.equal(result.search, false);
    assert.equal(result.genericVerificationAttempted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stable factual verification reuses inherited search evidence while dynamic facts still force a fresh search', () => {
  const payload = searchedPayload();
  assert.equal(shouldForceVerifierSearch('Panasonic CF-SV8はWindows 11に対応している？', payload), false);
  assert.equal(shouldForceVerifierSearch('別府市の今日の天気は？', payload), true);
  assert.equal(shouldForceVerifierSearch('A店は今営業している？', payload), true);
  assert.equal(shouldForceVerifierSearch('次の電車は何時？', payload), true);
  assert.equal(shouldForceVerifierSearch('この法律は現在どうなっている？', payload), true);
});

test('verifier must force a new search when the primary interaction has no search evidence', () => {
  assert.equal(shouldForceVerifierSearch('富士山の高さは？', { id: 'primary', steps: [] }), true);
});
