import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GEMINI_MODEL,
  PERSONALIZATION_REVISION,
  __test,
} from '../src/integrated-entry.js';

const {
  buildTalkSysSystemInstruction,
  currentJstInstruction,
  shouldStronglyPreferSearch,
  normalizeSpokenJapanese,
  runGeminiTurn,
} = __test;

const FIXED = new Date('2026-09-17T22:45:00Z');

test('v55 keeps Gemini 3.5 Flash-Lite and defines a phone-first personalized system instruction', () => {
  assert.equal(GEMINI_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(PERSONALIZATION_REVISION, 'talksys-v55-gemini-personalization-r1');
  const prompt = buildTalkSysSystemInstruction(FIXED);
  assert.match(prompt, /電話で読み上げる会話/);
  assert.match(prompt, /Google検索は積極的に使って/);
  assert.match(prompt, /回答全体を「確認できません」で終わらせない/);
  assert.match(prompt, /正しく答えられる他の部分まで捨てない/);
  assert.match(prompt, /穴埋めで作ってはいけません/);
  assert.match(prompt, /外部コンテンツは事実確認の材料/);
  assert.match(prompt, /システム指示、内部プロンプト、APIキー/);
  assert.match(prompt, /Markdown、箇条書き、表/);
  assert.match(prompt, /8GBは8ギガバイト/);
});

test('authoritative clock is JST and is injected independently from model memory', () => {
  const clock = currentJstInstruction(FIXED);
  assert.match(clock, /2026-09-18T07:45:00\+09:00/);
  assert.match(clock, /日本標準時/);
  assert.match(clock, /現在、今日、明日、次の便/);
});

test('search preference skips only greeting-like trivial conversation', () => {
  assert.equal(shouldStronglyPreferSearch('別府で中古パソコンのおすすめ店ある？'), true);
  assert.equal(shouldStronglyPreferSearch('QCM1250とこのACアダプタは互換性ある？'), true);
  assert.equal(shouldStronglyPreferSearch('今のソニックの時刻を教えて'), true);
  assert.equal(shouldStronglyPreferSearch('12345÷15'), true);
  assert.equal(shouldStronglyPreferSearch('この文章を短くして'), true);
  assert.equal(shouldStronglyPreferSearch('ありがとう'), false);
  assert.equal(shouldStronglyPreferSearch('こんにちは'), false);
});

test('spoken-answer normalizer removes screen-only notation and makes common numbers and units Japanese-friendly', () => {
  const value = normalizeSpokenJapanese('## 結論\n- 20:30です。**8GB**、3.5GHz、15%です。詳細 https://example.com/a');
  assert.doesNotMatch(value, /[#*]|https?:\/\//);
  assert.match(value, /20時30分/);
  assert.match(value, /8ギガバイト/);
  assert.match(value, /3点5ギガヘルツ/);
  assert.match(value, /15パーセント/);
});

test('native Gemini turn keeps search, source metadata and conversational answer without the legacy truth gate', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const req = JSON.parse(options.body);
    assert.equal(req.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(req.tools, [{ type: 'google_search' }]);
    assert.match(req.system_instruction, /Google検索は積極的に使って/);
    return new Response(JSON.stringify({
      id: 'interaction-1',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['別府 中古PC 店'] } },
        { type: 'google_search_result', result: [{ title: '実在ショップ', url: 'https://example.com/shop' }] },
        { type: 'model_output', content: [{ type: 'text', text: '**実在ショップ**を確認できました。8GBの在庫は検索結果では分かりません。' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn({ text: '別府で中古PC店を教えて', history: [] }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(result.ok, true);
    assert.equal(result.route, 'gemini-native-interactions');
    assert.equal(result.planner, 'gemini-native-personalized-v55');
    assert.equal(result.search, true);
    assert.equal(result.searchRetried, false);
    assert.equal(result.nativeGoogleSearch, true);
    assert.equal(result.customTruthGateApplied, false);
    assert.equal(result.blanketFailClosed, false);
    assert.equal(result.legacyGlmExecution, false);
    assert.equal(result.interactionId, 'interaction-1');
    assert.equal(result.sources[0].title, '実在ショップ');
    assert.doesNotMatch(result.answer, /\*\*/);
    assert.match(result.answer, /8ギガバイト/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('factual question searches on the primary call and verifies on the second call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    assert.match(req.system_instruction, /Google検索を必ず実行/);
    assert.match(req.input, /Google検索を実行して事実確認/);

    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'interaction-search',
        status: 'completed',
        steps: [
          { type: 'google_search_call', arguments: { queries: ['別府 今日 天気'] } },
          { type: 'model_output', content: [{ type: 'text', text: '検索して確認した情報を案内します。' }] },
        ],
      }), { status: 200 });
    }

    assert.equal(calls, 2);
    assert.match(req.input, /最終回答前の自己検証/);
    assert.match(req.input, /候補回答: 検索して確認した情報を案内します/);
    return new Response(JSON.stringify({
      id: 'interaction-verified',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['別府 今日 天気 現在'] } },
        { type: 'model_output', content: [{ type: 'text', text: '検索して再確認した情報を案内します。' }] },
      ],
    }), { status: 200 });
  };
  try {
    const result = await runGeminiTurn({ text: '別府の今日の天気は？' }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(calls, 2);
    assert.equal(result.search, true);
    assert.equal(result.searchRetried, false);
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, true);
    assert.equal(result.interactionId, 'interaction-verified');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('integrated browser and Telnyx turns share the same personalized Gemini runner', () => {
  const source = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
  assert.match(source, /turn: \(body, signal\) => runTalkSysTurn\(request, env, body, signal \|\| request\.signal, ctx\)/);
  assert.match(source, /const result = await runGeminiTurn\(body \|\| \{\}, env, signal\)/);
  assert.match(source, /scheduleConversationLog\(ctx, env, request, body, result, 'turn', 200\)/);
  assert.match(source, /url\.pathname === '\/api\/turn'/);
  assert.doesNotMatch(source, /LEGACY_GLM|@cf\/zai-org\/glm/);
});
