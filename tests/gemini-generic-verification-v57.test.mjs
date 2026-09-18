import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERIC_VERIFICATION_REVISION,
  __test,
} from '../src/integrated-entry.js';

const {
  buildGenericVerificationInput,
  buildVerificationSystemInstruction,
  isLowRiskSinglePassQuestion,
  shouldRunGenericVerification,
  runGeminiTurn,
} = __test;

const FIXED = new Date('2026-09-17T11:00:00Z'); // 20:00 JST

test('v57 generic verifier is Gemini-led and explicitly repair-first rather than blanket fail-closed', () => {
  assert.equal(GENERIC_VERIFICATION_REVISION, 'talksys-v57-gemini-self-verify-r1');
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
  assert.match(input, /質問: 今営業している店を教えて/);
  assert.match(input, /一次回答: A店が営業中です/);
  assert.match(input, /Google検索で独立に確認/);
  const system = buildVerificationSystemInstruction(FIXED);
  assert.match(system, /最終回答検証器/);
  assert.match(system, /2026-09-17T20:00:00\+09:00/);
  assert.match(system, /価格、在庫、営業状態/);
  assert.match(system, /確認できた部分まで捨てず/);
});

test('generic verifier skips only explicit low-risk turns', () => {
  assert.equal(isLowRiskSinglePassQuestion('ありがとう', {}), true);
  assert.equal(isLowRiskSinglePassQuestion('12345÷15', {}), true);
  assert.equal(isLowRiskSinglePassQuestion('この文章を短くして', {}), true);
  assert.equal(isLowRiskSinglePassQuestion('富士山の高さは？', {}), false);
  assert.equal(isLowRiskSinglePassQuestion('このCPUはWindows 11に対応してる？', {}), false);
  assert.equal(shouldRunGenericVerification('今営業している店を教えて', {}), true);
  assert.equal(shouldRunGenericVerification('ありがとう', {}), false);
  assert.equal(shouldRunGenericVerification('12345÷15', {}), false);
  assert.equal(shouldRunGenericVerification('この文章を短くして', {}), false);
  assert.equal(shouldRunGenericVerification('この文章を短くして', {
    steps: [{ type: 'google_search_call', arguments: { queries: ['test'] } }],
  }), true);
});

test('same Gemini repairs a stale current-state answer instead of TalkSys deciding the fact', async () => {
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

    assert.match(req.system_instruction, /最終回答検証器/);
    assert.match(req.system_instruction, /2026-09-17T20:00:00\+09:00/);
    assert.match(req.input, /一次回答: A店は今営業しています/);
    assert.match(req.input, /Google検索を実行して事実確認/);
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

test('verifier failure is fail-open and keeps the useful primary Gemini answer', async () => {
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
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, false);
    assert.equal(result.verificationFailOpen, true);
    assert.match(result.answer, /5点2/);
    assert.doesNotMatch(result.answer, /確認できません|分かりません/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('primary search miss is handled by the forced-search verifier in the second call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'primary-no-search',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '製品Xは5.2です。' }] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(calls, 2);
    assert.match(req.system_instruction, /最終回答検証器/);
    assert.match(req.input, /Google検索を実行して事実確認/);
    return new Response(JSON.stringify({
      id: 'verified',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['製品X 最新 バージョン'] } },
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
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, true);
    assert.equal(result.searchRetried, false);
    assert.ok(result.timings.primaryMs >= 0);
    assert.ok(result.timings.verifierMs >= 0);
    assert.match(result.answer, /5点3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
