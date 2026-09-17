import worker from './worker-v44.js';
import { collectGroundedEvidenceV26 } from './search-v26.js';

export const TRUTH_GATE_REVISION = 'talksys-v46-hard-facts-r1';
export const GEMINI_ADAPTER_REVISION = 'talksys-v47-gemini-cutover-r1';
export const RESPONSE_QUALITY_REVISION = 'talksys-v48-interrupt-transit-speed-r1';
export const GEMINI_MODEL = 'gemini-3.8-flash';

const LEGACY_GLM_PRIMARY = '@cf/zai-org/glm-5.3-flash';
const LEGACY_GLM_FALLBACK = '@cf/zai-org/glm-4.7-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const TALKSYS_IDENTITY_INSTRUCTION = 'あなたはTalkSysの日本語音声アシスタント「フォーンズ」です。自分をGemini、GoogleのAI、GLM、ChatGPT、OpenAIなど上流のモデル名・提供元として名乗らないでください。自分について聞かれた場合は「フォーンズです」と簡潔に答えてください。';
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
    thinkingConfig: { thinkingLevel: 'low' },
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

async function tryDirectTransitTurn(body, env, signal) {
  if (!isDirectTransitCandidate(body)) return null;
  const started = Date.now();
  const text = clean(body?.text, 1800);
  const history = requestHistory(body);
  let research;
  try {
    research = await collectGroundedEvidenceV26(text, history, { signal });
  } catch {
    return null;
  }
  const source = Array.isArray(research?.sources)
    ? research.sources.find((item) => DIRECT_TRANSIT_ENGINES.has(String(item?.engine || '')))
    : null;
  if (research?.directTransitPrimary !== true || !source) return null;

  const searchMs = Date.now() - started;
  const evidence = clean(source?.excerpt || source?.snippet, 7000);
  if (!evidence) return null;
  const userContext = history.filter((item) => item.role === 'user').slice(-4).map((item) => item.content).join(' / ');
  const synthesisStarted = Date.now();
  let generated;
  try {
    generated = await runGemini(env, {
      messages: [
        {
          role: 'system',
          content: '交通経路専用回答です。取得した公式時刻表または乗換案内の本文だけを根拠に、次に利用できる便を先に簡潔に答えてください。発車時刻、到着時刻、列車名・種別、行先、乗換、運賃は根拠に書かれたものだけ使います。根拠にない内容を一般知識で補わず、利用者に駅や別サイトでの確認を押し戻さないでください。通常2〜4文で答えてください。',
        },
        {
          role: 'user',
          content: `今回の質問: ${text}\n直近の利用者文脈: ${userContext || '(なし)'}\n検索基準: ${clean(research?.transitRequestedAtJst, 80)}\n取得した交通根拠: ${clean(source?.title, 220)}\n${evidence}`,
        },
      ],
      max_completion_tokens: 480,
      temperature: 0.03,
    }, { signal });
  } catch {
    return null;
  }
  const answer = sanitizeProviderSelfIdentification(generated?.text || generated?.response || '');
  if (!answer) return null;
  const normalizedSource = {
    title: clean(source?.title, 220),
    url: clean(source?.url, 700),
    engine: clean(source?.engine, 80),
  };
  return {
    ok: true,
    answer,
    search: true,
    searchUseful: true,
    route: 'direct-transit-v48',
    directTransitPrimary: true,
    directTransitEngine: normalizedSource.engine,
    transitRequestedAtJst: clean(research?.transitRequestedAtJst, 80),
    resolvedQuestion: clean(research?.resolvedQuestion || text, 2200),
    queries: Array.isArray(research?.queries) ? research.queries.slice(0, 6) : [],
    sources: [normalizedSource],
    apiSources: [],
    searchPasses: 1,
    searchCoverage: { sufficient: true, reason: 'direct current official transit evidence' },
    sourceQuality: normalizedSource.engine === 'jrkyushu-official-timetable-current' ? 'official-railway-timetable-current' : 'direct-route-planner-current',
    searchMode: 'direct-transit-primary',
    timings: {
      totalMs: Date.now() - started,
      searchMs,
      glmMs: Date.now() - synthesisStarted,
    },
    model: GEMINI_MODEL,
    planner: 'direct-transit-v26-reuse',
    languageMode: 'ja-only',
  };
}

function json(data, status = 200, headers = {}) {
  const out = new Headers(headers);
  out.set('content-type', 'application/json; charset=utf-8');
  out.set('cache-control', 'no-store');
  out.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  out.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  out.set('x-talksys-response-quality-revision', RESPONSE_QUALITY_REVISION);
  return new Response(JSON.stringify(data), { status, headers: out });
}

async function guardedFetch(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/truth-gate-health') {
    return json({
      ok: true,
      revision: TRUTH_GATE_REVISION,
      responseQualityRevision: RESPONSE_QUALITY_REVISION,
      mode: 'claim-level-fail-close',
      transitExactRouteRequiresStructuredEvidence: true,
      directYahooTransitEvidenceAuthorized: true,
      directJrKyushuTimetableEvidenceAuthorized: true,
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
      responseQualityRevision: RESPONSE_QUALITY_REVISION,
      requiredSecret: 'GEMINI_API_KEY',
      upstreamIdentitySuppressed: true,
      legacyGlmExecution: false,
    });
  }

  let question = '';
  let turnBody = null;
  if (request.method === 'POST' && url.pathname === '/api/turn') {
    try {
      turnBody = await request.clone().json();
      question = clean(turnBody?.text, 1800);
    } catch {}
  }

  const runtimeEnv = withGeminiGenerationProvider(env);

  if (turnBody && question && isDirectTransitCandidate(turnBody)) {
    const directTransit = await tryDirectTransitTurn(turnBody, env, request.signal);
    if (directTransit) {
      const gated = gateTurnPayload(directTransit, question);
      return json(normalizeGenerationMetadata(gated, env));
    }
  }

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
        truthGatePolicy: 'claim-level-fail-close',
        directYahooTransitEvidenceAuthorized: true,
        directJrKyushuTimetableEvidenceAuthorized: true,
        upstreamIdentitySuppressed: true,
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
  sanitizeProviderSelfIdentification,
  readGeminiText,
  runGemini,
  withGeminiGenerationProvider,
  normalizeGenerationMetadata,
  isDirectTransitCandidate,
  tryDirectTransitTurn,
  LEGACY_GLM_PRIMARY,
  LEGACY_GLM_FALLBACK,
};
