import worker from './worker-v44.js';

export const TRUTH_GATE_REVISION = 'talksys-v46-hard-facts-r1';
export const GEMINI_ADAPTER_REVISION = 'talksys-v47-gemini-cutover-r1';
export const RESPONSE_QUALITY_REVISION = 'talksys-v48-interrupt-transit-speed-r1';
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

const LEGACY_GLM_PRIMARY = '@cf/zai-org/glm-5.3-flash';
const LEGACY_GLM_FALLBACK = '@cf/zai-org/glm-4.7-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const TALKSYS_IDENTITY_INSTRUCTION =
  'あなたはTalkSysの日本語音声アシスタント「フォーンズ」です。' +
  '自然で簡潔な日本語で回答してください。必要な最新情報は利用可能なGoogle検索を自分で使って確認してください。' +
  '検索や情報取得を利用者側へ押し戻さず、取得できた根拠に基づいて具体的に答えてください。' +
  '自分をGemini、GoogleのAI、GLM、ChatGPT、OpenAIなど上流のモデル名・提供元として名乗らないでください。' +
  '自分について聞かれた場合は「フォーンズです」と簡潔に答えてください。';

const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|時刻表|駅|新幹線|特急|(?:から|→).{1,40}(?:まで|へ|→).{0,20}(?:行く|行き方|経路|ルート))/i;
const DYNAMIC_FACT_RE = /(最新|現在|今日|明日|価格|値段|相場|在庫|発売|販売中|BIOS|UEFI|ファームウェア|ドライバ|法律|法令|制度|社長|CEO|首相|大統領|ニュース|運行|遅延|運休|時刻表|天気|天候|為替|地震|祝日|営業時間|バージョン)/i;
const EXACT_TRANSIT_RE = /(乗り換|乗換|乗車|下車|経由|直通|→|番線|何時|時刻|\d{1,2}:\d{2}|\d{1,2}時(?:\d{1,2}分)?|(?:ソニック|にちりん|かもめ|ゆふ|みずほ|さくら|のぞみ|ひかり|こだま).{0,20}(?:で|に乗|号)|(?:本線|新幹線|線|駅).{0,18}(?:を使|を利用|に乗|で行)|\d+\s*分(?:ほど|程度|くらい)?(?:です|かか))/i;
const SPECIFIC_TOKEN_RE = /(?:[¥￥]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:円|万円|%|％)|\d{1,2}:\d{2}|\d{1,2}時(?:\d{1,2}分)?|\bv?\d+\.\d+(?:\.\d+)*\b|\b[A-Z]{1,8}[-_ ]?\d{2,}[A-Z0-9_-]*\b)/giu;
const PROVIDER_SELF_ID_RE = /^(?:私は|わたしは|当モデルは|私自身は).{0,100}(?:Gemini|Google(?:が|の).{0,30}(?:AI|モデル)|GLM|ChatGPT|OpenAI)/i;
const DIRECT_TRANSIT_ENGINES = new Set(['yahoo-transit-direct-current', 'jrkyushu-official-timetable-current']);

function clean(value, max = 12000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalize(value) {
  return clean(String(value ?? '').normalize('NFKC'), 20000).toLowerCase().replace(/\s+/g, '');
}

function sentences(value) {
  return clean(value, 12000).match(/[^。！？!?]+[。！？!?]?/g) || [];
}

function hasGeminiKey(env = {}) {
  return typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
}

function isLegacyGlmModel(model) {
  return /^@cf\/zai-org\/glm-/i.test(String(model || ''));
}

function messageText(content) {
  if (typeof content === 'string') return clean(content, 30000);
  if (!Array.isArray(content)) return clean(content, 30000);
  return clean(content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.content || '';
  }).join('\n'), 30000);
}

function mapGeminiMessages(messages = []) {
  const system = [];
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageText(message?.content);
    if (!text) continue;
    if (message?.role === 'system') {
      system.push(text);
      continue;
    }
    const role = message?.role === 'assistant' || message?.role === 'model' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous?.role === role) {
      previous.parts[0].text = clean(`${previous.parts[0].text}\n${text}`, 60000);
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  return {
    systemInstruction: system.length ? { parts: [{ text: clean(system.join('\n\n'), 60000) }] } : undefined,
    contents,
  };
}

function buildGeminiRequest(modelArgs = {}) {
  const mapped = mapGeminiMessages(modelArgs?.messages || []);
  const requestedMax = Number(modelArgs?.max_completion_tokens || modelArgs?.max_output_tokens || 0);
  const maxOutputTokens = Math.min(4096, Math.max(256, Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : 512));
  const generationConfig = {
    maxOutputTokens,
    thinkingConfig: { thinkingBudget: 0 },
  };
  const temperature = Number(modelArgs?.temperature);
  if (Number.isFinite(temperature)) generationConfig.temperature = Math.max(0, Math.min(2, temperature));
  const inheritedSystem = mapped.systemInstruction?.parts?.[0]?.text || '';
  const systemInstruction = {
    parts: [{ text: clean(`${TALKSYS_IDENTITY_INSTRUCTION}${inheritedSystem ? `\n\n${inheritedSystem}` : ''}`, 60000) }],
  };
  return {
    systemInstruction,
    contents: mapped.contents,
    generationConfig,
  };
}

function sanitizeProviderSelfIdentification(value) {
  const original = clean(value, 12000);
  if (!original) return '';
  const kept = sentences(original).filter((sentence) => !PROVIDER_SELF_ID_RE.test(clean(sentence, 300)));
  return clean(kept.join(''), 12000) || 'フォーンズです。';
}

function readGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  const text = clean(parts.filter((part) => !part?.thought && typeof part?.text === 'string').map((part) => part.text).join(''), 12000);
  return sanitizeProviderSelfIdentification(text);
}

async function runGemini(env, modelArgs = {}, options = {}) {
  if (!hasGeminiKey(env)) throw new Error('gemini_api_key_missing');
  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY.trim(),
    },
    body: JSON.stringify(buildGeminiRequest(modelArgs)),
    signal: options?.signal,
  });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const detail = clean(payload?.error?.message || raw || response.statusText, 500);
    throw new Error(`gemini_http_${response.status}${detail ? `:${detail}` : ''}`);
  }
  const text = readGeminiText(payload);
  if (!text) throw new Error('empty_gemini_answer');
  return {
    response: text,
    result: text,
    text,
    provider: 'gemini',
    model: GEMINI_MODEL,
  };
}

function withGeminiGenerationProvider(env = {}) {
  const originalAi = env?.AI;
  const ai = {
    async run(model, modelArgs, options) {
      const modelId = String(model || '');
      if (modelId === LEGACY_GLM_FALLBACK) {
        throw new Error('legacy_glm_fallback_disabled');
      }
      if (isLegacyGlmModel(modelId)) {
        return runGemini(env, modelArgs, options);
      }
      if (!originalAi || typeof originalAi.run !== 'function') throw new Error('workers_ai_binding_missing');
      return originalAi.run.call(originalAi, model, modelArgs, options);
    },
  };
  return { ...env, AI: ai };
}

function normalizeGenerationMetadata(payload = {}, env = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const legacyModel = isLegacyGlmModel(payload?.model);
  const timings = payload?.timings && typeof payload.timings === 'object'
    ? {
        ...payload.timings,
        ...(Number.isFinite(Number(payload.timings.glmMs)) ? { geminiMs: Number(payload.timings.glmMs) } : {}),
      }
    : payload?.timings;
  return {
    ...payload,
    ...(legacyModel ? { model: GEMINI_MODEL } : {}),
    ...(timings ? { timings } : {}),
    generationProvider: 'gemini',
    generationModel: GEMINI_MODEL,
    generationRevision: GEMINI_ADAPTER_REVISION,
    responseQualityRevision: RESPONSE_QUALITY_REVISION,
    geminiConfigured: hasGeminiKey(env),
    legacyGlmExecution: false,
  };
}

function structuredTransitAuthorized(payload = {}) {
  const structuredApi = Array.isArray(payload?.apiSources) && payload.apiSources.some((source) =>
    String(source?.category || '').toLowerCase() === 'transit_route'
    || /navitime|route[_-]?planner/i.test(String(source?.tool || ''))
  );
  const directPlanner = payload?.directTransitPrimary === true
    && Array.isArray(payload?.sources)
    && payload.sources.some((source) => DIRECT_TRANSIT_ENGINES.has(String(source?.engine || '')));
  return structuredApi || directPlanner;
}

function hasUsableExternalEvidence(payload = {}) {
  if (payload?.searchUseful === true) return true;
  if (Array.isArray(payload?.apiSources) && payload.apiSources.length > 0) return true;
  return false;
}

function tokenSupportedByQuestion(token, question) {
  const wanted = normalize(token);
  return Boolean(wanted) && normalize(question).includes(wanted);
}

function removeUnsupportedDynamicSpecifics(answer, question) {
  const kept = sentences(answer).filter((sentence) => {
    const tokens = sentence.match(SPECIFIC_TOKEN_RE) || [];
    return tokens.every((token) => tokenSupportedByQuestion(token, question));
  });
  return clean(kept.join(''), 12000);
}

function removeUnauthorizedTransitRouteClaims(answer) {
  const kept = sentences(answer).filter((sentence) => !EXACT_TRANSIT_RE.test(sentence));
  return clean(kept.join(''), 12000);
}

export function gateTurnPayload(payload = {}, question = '') {
  if (!payload || typeof payload !== 'object') return payload;
  const original = clean(payload.answer, 12000);
  if (!original) return payload;

  const transit = TRANSIT_QUERY_RE.test(question);
  const routeAuthorized = structuredTransitAuthorized(payload);
  const hasEvidence = hasUsableExternalEvidence(payload);
  let answer = original;
  const reasons = [];

  if (transit && !routeAuthorized) {
    const guarded = removeUnauthorizedTransitRouteClaims(answer);
    if (guarded !== answer) reasons.push('transit_exact_route_requires_structured_evidence');
    answer = guarded;
    if (!answer) {
      answer = '今回取得できた根拠だけでは、具体的な発車時刻や乗換を確定できませんでした。';
    }
  }

  if (DYNAMIC_FACT_RE.test(question) && !hasEvidence) {
    const guarded = removeUnsupportedDynamicSpecifics(answer, question);
    if (guarded !== answer) reasons.push('dynamic_specifics_require_external_evidence');
    answer = guarded || '現在値や具体的な番号は、根拠を確認できた項目だけ案内します。';
  }

  return {
    ...payload,
    answer,
    truthGate: {
      revision: TRUTH_GATE_REVISION,
      applied: reasons.length > 0,
      reasons,
      structuredTransitAuthorized: routeAuthorized,
      externalEvidenceUsable: hasEvidence,
      policy: 'claim-level-fail-close',
    },
  };
}

function requestHistory(body = {}) {
  return Array.isArray(body?.history)
    ? body.history.slice(-14).map((item) => ({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: clean(item?.content, 1800),
      })).filter((item) => item.content)
    : [];
}

function isDirectTransitCandidate(body = {}) {
  const text = clean(body?.text, 1800);
  const context = requestHistory(body).filter((item) => item.role === 'user').map((item) => item.content).join(' ');
  const combined = clean(`${context} ${text}`, 7000);
  return TRANSIT_QUERY_RE.test(combined)
    && /(?:駅)?\s*(?:から|より|→|⇒|〜|～|-)\s*[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,28}(?:駅)?\s*(?:まで|へ|に)/i.test(combined);
}

function interactionOutputText(payload = {}) {
  const text = (Array.isArray(payload?.steps) ? payload.steps : [])
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => Array.isArray(step?.content) ? step.content : [])
    .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');
  return sanitizeProviderSelfIdentification(text);
}

function interactionQueries(payload = {}) {
  const queries = [];
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type !== 'google_search_call') continue;
    const values = Array.isArray(step?.arguments?.queries) ? step.arguments.queries : [];
    for (const value of values) {
      const q = clean(value, 300);
      if (q && !queries.includes(q)) queries.push(q);
    }
  }
  return queries.slice(0, 12);
}

function interactionSources(payload = {}) {
  const out = [];
  const seen = new Set();
  const push = (url, title = '') => {
    const href = clean(url, 900);
    if (!/^https?:\/\//i.test(href) || seen.has(href)) return;
    seen.add(href);
    out.push({
      title: clean(title || href, 240),
      url: href,
      engine: 'gemini-google-search',
    });
  };

  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type === 'model_output') {
      for (const part of Array.isArray(step?.content) ? step.content : []) {
        for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
          if (annotation?.type === 'url_citation') {
            push(annotation?.url, annotation?.title);
          }
        }
      }
    }
    if (step?.type === 'google_search_result') {
      const results = Array.isArray(step?.result) ? step.result : [];
      for (const item of results) {
        push(item?.url || item?.uri, item?.title || item?.name);
      }
    }
  }
  return out.slice(0, 12);
}

async function createGeminiInteraction(env, body = {}, signal, allowPrevious = true) {
  if (!hasGeminiKey(env)) throw new Error('gemini_api_key_missing');
  const text = clean(body?.text, 4000);
  if (!text) throw new Error('empty_user_input');
  const previousInteractionId = allowPrevious ? clean(body?.previousInteractionId, 400) : '';
  const requestBody = {
    model: GEMINI_MODEL,
    input: text,
    system_instruction: TALKSYS_IDENTITY_INSTRUCTION,
    tools: [{ type: 'google_search' }],
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
  };

  const response = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY.trim(),
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}

  if (!response.ok) {
    const detail = clean(payload?.error?.message || raw || response.statusText, 600);
    const invalidPrevious = Boolean(previousInteractionId)
      && (response.status === 400 || response.status === 404)
      && /previous|interaction|not found|invalid/i.test(detail);
    if (invalidPrevious && allowPrevious) {
      return createGeminiInteraction(env, body, signal, false);
    }
    throw new Error(`gemini_interactions_http_${response.status}${detail ? `:${detail}` : ''}`);
  }

  const answer = interactionOutputText(payload);
  if (!answer) throw new Error('empty_gemini_interaction_answer');
  return { payload, answer };
}

async function runNativeGeminiTurn(body, env, signal) {
  const started = Date.now();
  const { payload, answer } = await createGeminiInteraction(env, body, signal, true);
  const queries = interactionQueries(payload);
  const sources = interactionSources(payload);
  const searched = queries.length > 0 || sources.length > 0
    || (Array.isArray(payload?.steps) && payload.steps.some((step) => /^google_search_/.test(String(step?.type || ''))));

  return normalizeGenerationMetadata({
    ok: true,
    answer,
    route: 'gemini-native-interactions',
    planner: 'gemini-native',
    search: searched,
    searchUseful: searched,
    queries,
    sources,
    apiSources: [],
    interactionId: clean(payload?.id, 400),
    interactionStatus: clean(payload?.status, 80),
    model: GEMINI_MODEL,
    languageMode: 'ja-only',
    nativeGoogleSearch: true,
    customTransitRetrieval: false,
    customTruthGateApplied: false,
    timings: {
      totalMs: Date.now() - started,
      geminiMs: Date.now() - started,
      searchMs: 0,
    },
  }, env);
}

async function tryDirectTransitTurn(body, env, signal) {
  if (!isDirectTransitCandidate(body)) return null;
  return runNativeGeminiTurn(body, env, signal);
}

function json(data, status = 200, headers = {}) {
  const out = new Headers(headers);
  out.set('content-type', 'application/json; charset=utf-8');
  out.set('cache-control', 'no-store');
  out.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  out.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  out.set('x-talksys-response-quality-revision', RESPONSE_QUALITY_REVISION);
  out.set('x-talksys-answer-route', 'gemini-native-interactions');
  return new Response(JSON.stringify(data), { status, headers: out });
}

async function guardedFetch(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/truth-gate-health') {
    return json({
      ok: true,
      revision: TRUTH_GATE_REVISION,
      responseQualityRevision: RESPONSE_QUALITY_REVISION,
      mode: 'compatibility-only',
      nativeGeminiAnswerPath: true,
      nativeGoogleSearch: true,
      customTruthGateOnNativeAnswers: false,
    });
  }

  if (request.method === 'GET' && url.pathname === '/gemini-health') {
    const configured = hasGeminiKey(env);
    return json({
      ok: configured,
      configured,
      provider: 'gemini',
      model: GEMINI_MODEL,
      api: 'interactions',
      nativeGoogleSearch: true,
      revision: GEMINI_ADAPTER_REVISION,
      responseQualityRevision: RESPONSE_QUALITY_REVISION,
      requiredSecret: 'GEMINI_API_KEY',
      upstreamIdentitySuppressed: true,
      legacyGlmExecution: false,
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/turn') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }
    try {
      const result = await runNativeGeminiTurn(body, env, request.signal);
      return json(result, 200);
    } catch (error) {
      return json({
        ok: false,
        error: 'gemini_native_interaction_failed',
        detail: clean(error?.message || error, 900),
        route: 'gemini-native-interactions',
        nativeGoogleSearch: true,
      }, 502);
    }
  }

  const runtimeEnv = withGeminiGenerationProvider(env);
  const response = await worker.fetch(request, runtimeEnv, ctx);
  const headers = new Headers(response.headers);
  headers.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  headers.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  headers.set('x-talksys-response-quality-revision', RESPONSE_QUALITY_REVISION);

  if (request.method === 'GET' && url.pathname === '/voice-health' && /application\/json/i.test(headers.get('content-type') || '')) {
    try {
      const body = await response.clone().json();
      const normalized = normalizeGenerationMetadata({
        ...body,
        truthGateRevision: TRUTH_GATE_REVISION,
        truthGatePolicy: 'compatibility-only',
        nativeGeminiAnswerPath: true,
        nativeGoogleSearch: true,
        upstreamIdentitySuppressed: true,
        modelTimeoutFallback: false,
        modelHedgeFallback: 'disabled-by-gemini-adapter',
      }, env);
      return json(normalized, response.status, headers);
    } catch {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default { fetch: guardedFetch };

export const __test = {
  structuredTransitAuthorized,
  hasUsableExternalEvidence,
  removeUnsupportedDynamicSpecifics,
  removeUnauthorizedTransitRouteClaims,
  gateTurnPayload,
  hasGeminiKey,
  isLegacyGlmModel,
  mapGeminiMessages,
  buildGeminiRequest,
  sanitizeProviderSelfIdentification,
  readGeminiText,
  runGemini,
  withGeminiGenerationProvider,
  normalizeGenerationMetadata,
  isDirectTransitCandidate,
  tryDirectTransitTurn,
  interactionOutputText,
  interactionQueries,
  interactionSources,
  createGeminiInteraction,
  runNativeGeminiTurn,
  LEGACY_GLM_PRIMARY,
  LEGACY_GLM_FALLBACK,
};
