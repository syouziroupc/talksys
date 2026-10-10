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
    assert.match(req.system_instruction, /まずGoogle検索を実行/);
    return new Response(JSON.stringify({
      id: 'primary-grounded',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['A店 営業時間'] } },
        { type: 'google_search_result', result: [{ title: 'A店公式', url: 'https://example.com/a' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'A店は19時に閉店しています。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/a', title: 'A店公式' }] }] },
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

test('dynamic fact retries through generateContent when Interactions skips required search', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'primary-ungrounded',
        status: 'completed',
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: '製品Xの最新バージョンは5.2です。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const retry = JSON.parse(options.body);
    assert.deepEqual(retry.tools, [{ google_search: {} }]);
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '公式情報では製品Xの最新バージョンは5.3です。' }] },
        groundingMetadata: {
          webSearchQueries: ['製品X 最新バージョン'],
          groundingChunks: [{ web: { uri: 'https://example.com/product-x', title: '製品X公式' } }],
          groundingSupports: [{ segment: { startIndex: 0, endIndex: 4 }, groundingChunkIndices: [0] }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn(
      { text: '製品Xの最新バージョンは？', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: FIXED },
    );
    assert.equal(calls, 2);
    assert.equal(result.groundingRequired, true);
    assert.equal(result.groundingFailClosed, false);
    assert.equal(result.groundingRecoveryUsed, true);
    assert.equal(result.searchRetried, true);
    assert.equal(result.search, true);
    assert.equal(result.generationTransport, 'generateContent');
    assert.match(result.answer, /5点3/);
    assert.doesNotMatch(result.answer, /5点2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dynamic fact fails closed only after both grounding attempts return no search evidence', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'primary-ungrounded',
        status: 'completed',
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: '製品Xの最新バージョンは5.2です。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '製品Xの最新バージョンは5.4です。' }] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn(
      { text: '製品Xの最新バージョンは？', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: FIXED },
    );
    assert.equal(calls, 2);
    assert.equal(result.groundingRequired, true);
    assert.equal(result.groundingFailClosed, true);
    assert.equal(result.groundingRecoveryUsed, false);
    assert.equal(result.searchRetried, true);
    assert.doesNotMatch(result.answer, /5点2|5点4/);
    assert.match(result.answer, /推測では答えません/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
