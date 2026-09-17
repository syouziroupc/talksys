import worker from './worker-v44.js';

export const TRUTH_GATE_REVISION = 'talksys-v46-hard-facts-r1';
export const GEMINI_ADAPTER_REVISION = 'talksys-v47-gemini-cutover-r1';
export const GEMINI_MODEL = 'gemini-3.8-flash';

const LEGACY_GLM_PRIMARY = '@cf/zai-org/glm-5.3-flash';
const LEGACY_GLM_FALLBACK = '@cf/zai-org/glm-4.7-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|時刻表|駅|新幹線|特急|(?:から|→).{1,40}(?:まで|へ|→).{0,20}(?:行く|行き方|経路|ルート))/i;
const DYNAMIC_FACT_RE = /(最新|現在|今日|明日|価格|値段|相場|在庫|発売|販売中|BIOS|UEFI|ファームウェア|ドライバ|法律|法令|制度|社長|CEO|首相|大統領|ニュース|運行|遅延|運休|時刻表|天気|天候|為替|地震|祝日|営業時間|バージョン)/i;
const EXACT_TRANSIT_RE = /(乗り換|乗換|乗車|下車|経由|直通|→|番線|何時|時刻|\d{1,2}:\d{2}|\d{1,2}時(?:\d{1,2}分)?|(?:ソニック|にちりん|かもめ|ゆふ|みずほ|さくら|のぞみ|ひかり|こだま).{0,20}(?:で|に乗|号)|(?:本線|新幹線|線|駅).{0,18}(?:を使|を利用|に乗|で行)|\d+\s*分(?:ほど|程度|くらい)?(?:です|かか))/i;
const SPECIFIC_TOKEN_RE = /(?:[¥￥]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:円|万円|%|％)|\d{1,2}:\d{2}|\d{1,2}時(?:\d{1,2}分)?|\bv?\d+\.\d+(?:\.\d+)*\b|\b[A-Z]{1,8}[-_ ]?\d{2,}[A-Z0-9_-]*\b)/giu;

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
  const maxOutputTokens = Math.min(8192, Math.max(1024, Number.isFinite(requestedMax) ? requestedMax : 1024));
  const generationConfig = {
    maxOutputTokens,
    thinkingConfig: { thinkingLevel: 'low' },
  };
  const temperature = Number(modelArgs?.temperature);
  if (Number.isFinite(temperature)) generationConfig.temperature = Math.max(0, Math.min(2, temperature));
  return {
    ...(mapped.systemInstruction ? { systemInstruction: mapped.systemInstruction } : {}),
    contents: mapped.contents,
    generationConfig,
  };
}

function readGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return clean(parts.filter((part) => !part?.thought && typeof part?.text === 'string').map((part) => part.text).join(''), 12000);
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
    geminiConfigured: hasGeminiKey(env),
    legacyGlmExecution: false,
  };
}

function structuredTransitAuthorized(payload = {}) {
  return Array.isArray(payload?.apiSources) && payload.apiSources.some((source) =>
    String(source?.category || '').toLowerCase() === 'transit_route'
    || /navitime|route[_-]?planner/i.test(String(source?.tool || ''))
  );
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

  // Exact route sequences are a graph/record claim, not a prose-search claim.
  // Generic web snippets may support context, but never authorize a concrete
  // transfer/train/time sequence. That requires a structured route result.
  if (transit && !routeAuthorized) {
    const guarded = removeUnauthorizedTransitRouteClaims(answer);
    if (guarded !== answer) reasons.push('transit_exact_route_requires_structured_evidence');
    answer = guarded;
    if (!answer) {
      answer = '具体的な乗換駅・列車名・時刻は、構造化された経路根拠が確認できた場合だけ案内します。';
    }
  }

  // On a factual turn whose retrieval failed closed, model memory may still be
  // useful for general guidance, but it may not mint new prices, times, rates,
  // versions or model-like identifiers that were absent from the user input.
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

function json(data, status = 200, headers = {}) {
  const out = new Headers(headers);
  out.set('content-type', 'application/json; charset=utf-8');
  out.set('cache-control', 'no-store');
  out.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  out.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  return new Response(JSON.stringify(data), { status, headers: out });
}

async function guardedFetch(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/truth-gate-health') {
    return json({
      ok: true,
      revision: TRUTH_GATE_REVISION,
      mode: 'claim-level-fail-close',
      transitExactRouteRequiresStructuredEvidence: true,
      genericWebDoesNotAuthorizeTransitSequence: true,
      dynamicSpecificsFailClosedWithoutEvidence: true,
    });
  }

  if (request.method === 'GET' && url.pathname === '/gemini-health') {
    const configured = hasGeminiKey(env);
    return json({
      ok: configured,
      configured,
      provider: 'gemini',
      model: GEMINI_MODEL,
      revision: GEMINI_ADAPTER_REVISION,
      requiredSecret: 'GEMINI_API_KEY',
      legacyGlmExecution: false,
    });
  }

  let question = '';
  if (request.method === 'POST' && url.pathname === '/api/turn') {
    try {
      const body = await request.clone().json();
      question = clean(body?.text, 1800);
    } catch {}
  }

  const runtimeEnv = withGeminiGenerationProvider(env);
  const response = await worker.fetch(request, runtimeEnv, ctx);
  const headers = new Headers(response.headers);
  headers.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  headers.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);

  if (request.method === 'GET' && url.pathname === '/voice-health' && /application\/json/i.test(headers.get('content-type') || '')) {
    try {
      const body = await response.clone().json();
      const normalized = normalizeGenerationMetadata({
        ...body,
        truthGateRevision: TRUTH_GATE_REVISION,
        truthGatePolicy: 'claim-level-fail-close',
        modelTimeoutFallback: false,
        modelHedgeFallback: 'disabled-by-gemini-adapter',
      }, env);
      return json(normalized, response.status, headers);
    } catch {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }

  if (request.method !== 'POST' || url.pathname !== '/api/turn' || !question || !/application\/json/i.test(headers.get('content-type') || '')) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  try {
    const body = await response.clone().json();
    const gated = gateTurnPayload(body, question);
    return json(normalizeGenerationMetadata(gated, env), response.status, headers);
  } catch {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
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
  readGeminiText,
  runGemini,
  withGeminiGenerationProvider,
  normalizeGenerationMetadata,
  LEGACY_GLM_PRIMARY,
  LEGACY_GLM_FALLBACK,
};
