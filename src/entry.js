import worker from './worker-v44.js';

export const TRUTH_GATE_REVISION = 'talksys-v46-hard-facts-r1';

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

  let question = '';
  if (request.method === 'POST' && url.pathname === '/api/turn') {
    try {
      const body = await request.clone().json();
      question = clean(body?.text, 1800);
    } catch {}
  }

  const response = await worker.fetch(request, env, ctx);
  const headers = new Headers(response.headers);
  headers.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);

  if (request.method === 'GET' && url.pathname === '/voice-health' && /application\/json/i.test(headers.get('content-type') || '')) {
    try {
      const body = await response.clone().json();
      return json({ ...body, truthGateRevision: TRUTH_GATE_REVISION, truthGatePolicy: 'claim-level-fail-close' }, response.status, headers);
    } catch {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }

  if (request.method !== 'POST' || url.pathname !== '/api/turn' || !question || !/application\/json/i.test(headers.get('content-type') || '')) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  try {
    const body = await response.clone().json();
    return json(gateTurnPayload(body, question), response.status, headers);
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
};
