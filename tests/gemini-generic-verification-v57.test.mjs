import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERIC_VERIFICATION_REVISION,
  __test,
} from '../src/integrated-entry.js';

const {
  buildGenericVerificationInput,
  shouldRunGenericVerification,
  shouldStronglyPreferSearch,
  runGeminiTurn,
} = __test;

const FIXED = new Date('2026-09-17T11:00:00Z'); // 20:00 JST

test('quality-first verifier preserves the detailed review prompt while reusing inherited evidence', () => {
  assert.equal(GENERIC_VERIFICATION_REVISION, 'talksys-v59-evidence-reuse-verify-r1');
  const input = buildGenericVerificationInput(
    { text: '今営業している店を教えて' },
    {
      answer: 'A店が営業中です。',
      payload: {
        steps: [
          { type: 'google_search_call', arguments: { queries: ['A店 営業時間'] } },
          { type: 'google_search_result', result: [{ title: 'A店公式', url: 'https://example.com/a' }] },
        ],
      },
    },
    FIXED,
  );
  assert.match(input, /最終回答前の自己検証/);
  assert.match(input, /2026-09-17T20:00:00\+09:00/);
  assert.match(input, /元の利用者の質問: 今営業している店を教えて/);
  assert.match(input, /候補回答: A店が営業中です/);
  assert.match(input, /価格、在庫、営業状態/);
  assert.match(input, /別地域、別型番、別条件/);
  assert.match(input, /Google検索を使って再確認/);
  assert.match(input, /回答全体を「確認できません」「分かりません」に置き換えない/);
});

test('only trivial greeting-like conversation skips search and verification', () => {
  for (const text of ['こんにちは', 'ありがとう', 'はい', '了解']) {
    assert.equal(shouldStronglyPreferSearch(text), false, text);
    assert.equal(shouldRunGenericVerification(text, {}), false, text);
  }
  for (const text of [
    '12345÷15',
    'この文章を短くして',
    '富士山の高さは？',
    'このCPUはWindows 11に対応してる？',
    'おすすめを教えて',
  ]) {
    assert.equal(shouldStronglyPreferSearch(text), true, text);
    assert.equal(shouldRunGenericVerification(text, {}), true, text);
  }
});

test('same Gemini repairs a stale current-state answer after an independent search verification', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    assert.equal(req.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(req.tools, [{ type: 'google_search' }]);

    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'primary',
        status: 'completed',
        steps: [
          { type: 'google_search_call', arguments: { queries: ['A店 営業時間'] } },
          { type: 'model_output', content: [{ type: 'text', text: 'A店は今営業しています。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    assert.match(req.system_instruction, /Google検索は積極的に使って/);
    assert.match(req.system_instruction, /Google検索を必ず実行/);
    assert.match(req.input, /最終回答前の自己検証/);
    assert.match(req.input, /候補回答: A店は今営業しています/);
    assert.match(req.input, /2026-09-17T20:00:00\+09:00/);
    return new Response(JSON.stringify({
      id: 'verified',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['A店 営業時間 2026年9月17日'] } },
        { type: 'model_output', content: [{ type: 'text', text: 'A店は19時に閉店しているため、現在は営業していません。' }] },
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
    assert.equal(calls, 2);
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, true);
    assert.equal(result.verifierSearched, true);
    assert.equal(result.verificationFailOpen, false);
    assert.doesNotMatch(result.answer, /今営業しています/);
    assert.match(result.answer, /19時に閉店/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-greeting primary is search-forced from the first call and verification stays second', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);

    if (calls === 1) {
      assert.match(req.system_instruction, /Google検索を必ず実行/);
      assert.match(req.input, /Google検索を実行して事実確認/);
      return new Response(JSON.stringify({
        id: 'primary-grounded',
        status: 'completed',
        steps: [
          { type: 'google_search_call', arguments: { queries: ['製品X 最新 バージョン'] } },
          { type: 'model_output', content: [{ type: 'text', text: '製品Xの最新バージョンは5.3です。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    assert.equal(calls, 2);
    assert.match(req.system_instruction, /Google検索を必ず実行/);
    assert.match(req.input, /最終回答前の自己検証/);
    assert.match(req.input, /候補回答: 製品Xの最新バージョンは5.3です/);
    return new Response(JSON.stringify({
      id: 'verified',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['製品X 5.3 公式'] } },
        { type: 'model_output', content: [{ type: 'text', text: '製品Xの最新バージョンは5.3です。' }] },
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
    assert.equal(calls, 2);
    assert.equal(result.searchRetried, false);
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, true);
    assert.equal(result.verifierSearched, true);
    assert.ok(result.timings.searchRetryMs >= 0);
    assert.ok(result.timings.verifierMs >= 0);
    assert.match(result.answer, /5点3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifier failure fails open only after the grounded primary answer exists', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'primary',
        status: 'completed',
        steps: [
          { type: 'google_search_call', arguments: { queries: ['製品X 最新 バージョン'] } },
          { type: 'model_output', content: [{ type: 'text', text: '製品Xの最新バージョンは5.2です。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'temporary verifier outage' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await runGeminiTurn(
      { text: '製品Xの最新バージョンは？', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: FIXED },
    );
    assert.equal(calls, 2);
    assert.equal(result.search, true);
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, false);
    assert.equal(result.verificationFailOpen, true);
    assert.match(result.answer, /5点2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
