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
  deterministicLocationClarificationResult,
} = __test;

const FIXED = new Date('2026-09-17T22:45:00Z');

test('v86 keeps Gemini 3.5 Flash-Lite and defines a compact phone-first personalized system instruction', () => {
  assert.equal(GEMINI_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(PERSONALIZATION_REVISION, 'talksys-v87-jst-location-personalization-r1');
  const prompt = buildTalkSysSystemInstruction(FIXED);
  assert.match(prompt, /電話で読み上げ/);
  assert.match(prompt, /外部事実や現在情報が必要な質問ではGoogle検索を使い/);
  assert.match(prompt, /回答全体を「確認できません」で終わらせない/);
  assert.match(prompt, /正しく答えられる他の部分まで捨てない/);
  assert.match(prompt, /穴埋めで作ってはいけません/);
  assert.match(prompt, /事実確認の材料としてだけ扱って/);
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

test('search preference targets external facts and skips local or conversational work', () => {
  assert.equal(shouldStronglyPreferSearch('別府で中古パソコンのおすすめ店ある？'), true);
  assert.equal(shouldStronglyPreferSearch('QCM1250とこのACアダプタは互換性ある？'), true);
  assert.equal(shouldStronglyPreferSearch('今のソニックの時刻を教えて'), true);
  assert.equal(shouldStronglyPreferSearch('12345÷15'), false);
  assert.equal(shouldStronglyPreferSearch('この文章を短くして'), false);
  assert.equal(shouldStronglyPreferSearch('ありがとう'), false);
  assert.equal(shouldStronglyPreferSearch('こんにちは'), false);
  assert.equal(shouldStronglyPreferSearch('これ変わったな'), false);
  assert.equal(shouldStronglyPreferSearch('会話が成立し始めた'), false);
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
    assert.match(req.system_instruction, /Google検索を一度実行し、取得できた根拠だけで答えて/);
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

test('factual question searches on a single grounded primary call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    assert.match(req.system_instruction, /Google検索を一度実行し、取得できた根拠だけで答えて/);
    assert.match(req.input, /Google検索を実行して事実確認/);
    return new Response(JSON.stringify({
      id: 'interaction-search',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['別府 今日 天気'] } },
        { type: 'google_search_result', result: [{ title: '天気情報', url: 'https://example.com/weather' }] },
        { type: 'model_output', content: [{ type: 'text', text: '検索して確認した情報を案内します。' }] },
      ],
    }), { status: 200 });
  };
  try {
    const result = await runGeminiTurn({ text: '別府の今日の天気は？' }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(calls, 1);
    assert.equal(result.search, true);
    assert.equal(result.searchRetried, false);
    assert.equal(result.genericVerificationAttempted, false);
    assert.equal(result.genericVerificationSucceeded, false);
    assert.equal(result.interactionId, 'interaction-search');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('integrated browser and Telnyx turns share the same personalized Gemini runner', () => {
  const source = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
  assert.match(source, /turn: \(body, signal\) => runTalkSysTurn\(request, env, body, signal \|\| request\.signal, ctx\)/);
  assert.match(source, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.match(source, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(source, /scheduleConversationLog\(ctx, env, request, commonBody, result, 'turn', 200\)/);
  assert.match(source, /url\.pathname === '\/api\/turn'/);
  assert.match(source, /import fallbackWorker from '\.\/worker-v44\.js'/);
  assert.match(source, /runCloudflareRegionalRescue/);
});


test('current time is answered deterministically from authoritative JST without Gemini or search', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should not fetch'); };
  try {
    const result = await runGeminiTurn(
      { text: '今何時ですか?', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: new Date('2026-09-23T13:42:00Z') },
    );
    assert.equal(calls, 0);
    assert.equal(result.route, 'deterministic-jst-clock');
    assert.equal(result.search, false);
    assert.equal(result.answer, '日本時間では現在22時42分です。');
    assert.equal(result.authoritativeJst, '2026-09-23T22:42:00+09:00');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('casual contextual speech does not force Google Search', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const req = JSON.parse(options.body);
    assert.equal(req.tools, undefined);
    assert.doesNotMatch(req.system_instruction, /この回答ではGoogle検索を実行/);
    return new Response(JSON.stringify({
      id: 'casual-turn',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'そうですね、前より会話はつながっています。' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn({
      text: 'これ変わったな',
      history: [{ role: 'user', content: '会話が成立し始めた' }],
    }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(result.search, false);
    assert.match(result.answer, /前より会話/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('empty Gemini interaction output is retried once without failing the voice turn', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'empty-first',
        status: 'completed',
        steps: [{ type: 'google_search_call', arguments: { queries: ['ビバンテ'] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(req.previous_interaction_id, undefined);
    return new Response(JSON.stringify({
      id: 'retry-good',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '確認できる範囲で説明します。' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runGeminiTurn({ text: 'ビバンテ知ってますか', history: [] }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(calls, 2);
    assert.match(result.answer, /確認できる範囲/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('v86 compact core reduces recurring prompt size and adds one-pass quality guards', () => {
  const prompt = buildTalkSysSystemInstruction(FIXED);
  assert.ok(prompt.length < 4200, `prompt too long: ${prompt.length}`);
  assert.match(prompt, /信頼できない外部データ/);
  assert.match(prompt, /同じ内容や相槌を重複していないか/);
  assert.match(prompt, /確認過程は読み上げない/);
});


test('v87 answers common time phrasings in JST without Gemini and clarifies only location-dependent turns', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should_not_fetch'); };
  try {
    for (const text of ['今の時間教えて', '時間を教えて', '現在時刻を教えてください']) {
      const result = await runGeminiTurn({ text, history: [] }, { GEMINI_API_KEY: 'test-key' }, undefined, { now: new Date('2026-09-23T13:42:00Z') });
      assert.equal(result.route, 'deterministic-jst-clock');
      assert.equal(result.answer, '日本時間では現在22時42分です。');
    }
    const weather = await runGeminiTurn({ text: '今日の天気は？', history: [] }, { GEMINI_API_KEY: 'test-key' });
    assert.equal(weather.route, 'deterministic-location-clarification');
    assert.match(weather.answer, /どの地域/);

    const known = deterministicLocationClarificationResult('今日の天気は？', { history: [{ role: 'user', content: '別府市にいます' }] });
    assert.equal(known, null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('v97 rescues Gemini regional rejection through the Cloudflare Workers AI route', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const modelCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    assert.match(String(url), /\/v1beta\/interactions$/);
    return new Response(JSON.stringify({
      error: { message: 'This API is not available in your current location. See https://ai.google.dev/gemini-api/docs/available-regions.' },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const env = {
    GEMINI_API_KEY: 'test-key',
    AI: {
      async run(model) {
        modelCalls.push(model);
        return { response: '地域制限時も会話を継続できます。' };
      },
    },
  };
  try {
    const result = await runGeminiTurn({
      text: 'これ変わったな',
      history: [{ role: 'user', content: '会話が成立し始めた' }],
      previousInteractionId: 'old-interaction',
    }, env);
    assert.equal(fetchCalls, 1);
    assert.equal(result.ok, true);
    assert.match(result.route, /^cloudflare-region-rescue:/);
    assert.equal(result.generationTransport, 'workers-ai');
    assert.equal(result.generationProvider, 'workers-ai');
    assert.equal(result.interactionsRegionFallback, true);
    assert.equal(result.interactionReset, true);
    assert.equal(result.interactionId, '');
    assert.equal(result.legacyGlmExecution, true);
    assert.ok(modelCalls.some((model) => /@cf\/zai-org\/glm-/.test(model)));
    assert.match(result.answer, /会話を継続/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v97 does not hide unrelated Interactions HTTP 400 errors behind the regional rescue', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'Bad request for another reason' },
  }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      runGeminiTurn({ text: 'ファナテックって知ってる？', history: [] }, { GEMINI_API_KEY: 'test-key' }),
      /gemini_interactions_http_400:Bad request for another reason/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v97 web client clears stale interaction state while Discord remains current V103 bridge', () => {
  const webClient = fs.readFileSync(new URL('../src/talk-client-v45.js', import.meta.url), 'utf8');
  const discord = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
  assert.match(webClient, /if\(j\.interactionReset\)geminiInteractionId=''/);
  assert.match(discord, /talksys-discord-bridge-v103-contextual-jp-stt-r1/);
});
