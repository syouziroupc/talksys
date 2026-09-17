import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_ADAPTER_REVISION,
  GEMINI_MODEL,
  RESPONSE_QUALITY_REVISION,
  __test,
} from '../src/entry.js';

const {
  LEGACY_GLM_PRIMARY,
  LEGACY_GLM_FALLBACK,
  buildGeminiRequest,
  hasGeminiKey,
  isDirectTransitCandidate,
  normalizeGenerationMetadata,
  sanitizeProviderSelfIdentification,
  structuredTransitAuthorized,
  withGeminiGenerationProvider,
} = __test;

test('v47 Gemini adapter exposes the expected stable model and runtime key contract', () => {
  assert.equal(GEMINI_ADAPTER_REVISION, 'talksys-v47-gemini-cutover-r1');
  assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v48-interrupt-transit-speed-r1');
  assert.equal(GEMINI_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(hasGeminiKey({ GEMINI_API_KEY: 'abc' }), true);
  assert.equal(hasGeminiKey({ GEMINI_API_KEY: '   ' }), false);
  assert.equal(hasGeminiKey({}), false);
});

test('Gemini request mapping preserves roles, injects TalkSys identity, and respects the requested output budget', () => {
  const body = buildGeminiRequest({
    messages: [
      { role: 'system', content: '日本語で短く答える' },
      { role: 'user', content: '最初の質問' },
      { role: 'assistant', content: '最初の回答' },
      { role: 'user', content: '続き' },
    ],
    max_completion_tokens: 420,
    temperature: 0.16,
  });

  assert.match(body.systemInstruction.parts[0].text, /TalkSys/);
  assert.match(body.systemInstruction.parts[0].text, /フォーンズ/);
  assert.match(body.systemInstruction.parts[0].text, /日本語で短く答える/);
  assert.deepEqual(body.contents.map((x) => x.role), ['user', 'model', 'user']);
  assert.equal(body.contents[2].parts[0].text, '続き');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(body.generationConfig.maxOutputTokens, 420);
  assert.equal(body.generationConfig.temperature, 0.16);
  assert.equal('tools' in body, false);
});

test('provider self-identification is removed without deleting the useful answer', () => {
  const cleaned = sanitizeProviderSelfIdentification('私はGoogleが開発したAIモデルのGeminiです。大分駅から別府駅の案内を続けます。');
  assert.doesNotMatch(cleaned, /Gemini|Googleが開発/);
  assert.match(cleaned, /大分駅から別府駅/);
});

test('direct current Yahoo Transit evidence authorizes exact route wording', () => {
  assert.equal(structuredTransitAuthorized({
    directTransitPrimary: true,
    sources: [{ engine: 'yahoo-transit-direct-current' }],
  }), true);
  assert.equal(structuredTransitAuthorized({
    directTransitPrimary: false,
    sources: [{ engine: 'bing-rss' }],
  }), false);
  assert.equal(isDirectTransitCandidate({ text: '大分駅から別府駅へ次の電車は何時？', history: [] }), true);
});

test('legacy GLM primary is intercepted by server-side Gemini while non-GLM Workers AI remains delegated', async () => {
  const originalFetch = globalThis.fetch;
  const workersCalls = [];
  const fetchCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const env = {
      GEMINI_API_KEY: 'server-only-test-key',
      AI: {
        async run(model, args) {
          workersCalls.push({ model, args });
          return { response: 'Workers AI response' };
        },
      },
    };
    const wrapped = withGeminiGenerationProvider(env);

    const gemini = await wrapped.AI.run(LEGACY_GLM_PRIMARY, {
      messages: [{ role: 'user', content: 'こんにちは' }],
      max_completion_tokens: 500,
    });
    assert.equal(gemini.response, 'Gemini response');
    assert.equal(gemini.model, GEMINI_MODEL);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(fetchCalls[0].init.headers['x-goog-api-key'], 'server-only-test-key');
    assert.equal(workersCalls.length, 0);

    const delegated = await wrapped.AI.run('@cf/qwen/qwen3-30b-a3b-fp8', {
      messages: [{ role: 'user', content: 'plan' }],
    });
    assert.equal(delegated.response, 'Workers AI response');
    assert.equal(workersCalls.length, 1);
    assert.equal(workersCalls[0].model, '@cf/qwen/qwen3-30b-a3b-fp8');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GLM fallback execution is disabled and Gemini does not silently fall back to local GLM', async () => {
  const wrapped = withGeminiGenerationProvider({
    GEMINI_API_KEY: 'server-only-test-key',
    AI: { async run() { throw new Error('must_not_run'); } },
  });

  await assert.rejects(
    wrapped.AI.run(LEGACY_GLM_FALLBACK, { messages: [] }),
    /legacy_glm_fallback_disabled/,
  );
});

test('missing GEMINI_API_KEY fails the intercepted generation path closed', async () => {
  const wrapped = withGeminiGenerationProvider({
    AI: { async run() { throw new Error('must_not_run'); } },
  });

  await assert.rejects(
    wrapped.AI.run(LEGACY_GLM_PRIMARY, { messages: [{ role: 'user', content: 'test' }] }),
    /gemini_api_key_missing/,
  );
});

test('user-facing generation metadata reports Gemini while retaining compatibility timing', () => {
  const normalized = normalizeGenerationMetadata({
    ok: true,
    answer: 'ok',
    model: LEGACY_GLM_PRIMARY,
    timings: { totalMs: 200, glmMs: 123 },
  }, { GEMINI_API_KEY: 'abc' });

  assert.equal(normalized.model, GEMINI_MODEL);
  assert.equal(normalized.generationProvider, 'gemini');
  assert.equal(normalized.generationModel, GEMINI_MODEL);
  assert.equal(normalized.geminiConfigured, true);
  assert.equal(normalized.legacyGlmExecution, false);
  assert.equal(normalized.responseQualityRevision, RESPONSE_QUALITY_REVISION);
  assert.equal(normalized.timings.glmMs, 123);
  assert.equal(normalized.timings.geminiMs, 123);
});
