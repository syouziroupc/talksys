import worker from './worker-v44.js';

export const TRUTH_GATE_REVISION = 'talksys-v46-hard-facts-r1';
export const GEMINI_ADAPTER_REVISION = 'talksys-v47-gemini-cutover-r1';
export const RESPONSE_QUALITY_REVISION = 'talksys-v54-evidence-first-r1';
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

const LEGACY_GLM_PRIMARY = '@cf/zai-org/glm-5.3-flash';
const LEGACY_GLM_FALLBACK = '@cf/zai-org/glm-4.7-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const TALKSYS_IDENTITY_INSTRUCTION =
  'あなたはTalkSysの日本語音声アシスタント「フォーンズ」です。' +
  '自然で簡潔な日本語で回答してください。利用地域が明示されない通常会話は日本国内を既定とし、時刻は日本標準時JST（UTC+09:00）、日付は日本の暦日、通貨は円、気温は摂氏、距離はメートル法を既定にしてください。' +
  '国外・別タイムゾーン・別通貨などが明示された場合は、その指定を優先してください。' +
  '現在時刻、今日・明日、交通、価格、在庫、天気、営業時間など変動する具体値は、信頼できるサーバー時刻または取得済み外部根拠だけを使い、モデル内部の知識や過去の回答から推測してはいけません。' +
  '交通では、現在時刻より前の便を「次」と扱わず、具体的な発車時刻・乗換・番線は取得済み根拠で確認できた場合だけ述べてください。' +
  '検索や情報取得を利用者側へ押し戻さず、取得できた根拠に基づいて具体的に答えてください。' +
  '自分をGemini、GoogleのAI、GLM、ChatGPT、OpenAIなど上流のモデル名・提供元として名乗らないでください。' +
  '自分について聞かれた場合は「フォーンズです」と簡潔に答えてください。';

const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|時刻表|駅|新幹線|特急|(?:から|→).{1,40}(?:まで|へ|→).{0,20}(?:行く|行き方|経路|ルート))/i;
const DYNAMIC_FACT_RE = /(最新|現在|今日|明日|価格|値段|相場|在庫|発売|販売中|BIOS|UEFI|ファームウェア|ドライバ|法律|法令|制度|社長|CEO|首相|大統領|ニュース|運行|遅延|運休|時刻表|天気|天候|為替|地震|祝日|営業時間|バージョン)/i;
const EVIDENCE_REQUIRED_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|商品|製品|型番|モデル|仕様|互換|対応|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在|価格|値段|相場|在庫|発売|最新|現在|今日|明日|ニュース|運行|時刻表|天気|為替|法律|制度|バージョン)/i;
const ENTITY_RECOMMENDATION_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在)/i;
const NAMED_ENTITY_RE = /(?:「([^」]{2,60})」|『([^』]{2,60})』|([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{2,40}(?:商店|工房|電器|電機|病院|医院|クリニック|ホテル|旅館|カフェ|喫茶店|レストラン|株式会社|合同会社|有限会社)))/g;
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

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const JST_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const JST_LOCAL_TIME_RE = /(?:今(?:は|って)?何時|いま(?:は|って)?何時|現在(?:は)?何時|現在時刻|現在の時刻|今の時刻|いまの時刻|今の時間|いまの時間|日本時間(?:で)?(?:今)?何時|JST(?:で)?(?:今)?何時)/i;
const JST_DATE_RE = /(?:今日(?:は)?(?:何日|何月何日|の日付)|本日(?:は)?(?:何日|の日付)|明日(?:は)?(?:何日|何月何日)|今日(?:は)?何曜日)/i;
const NON_JST_TIME_CUE_RE = /(?:UTC|GMT|時差|現地時間|海外|ニューヨーク|ロンドン|パリ|ベルリン|北京|上海|ソウル|台北|シドニー|ロサンゼルス|サンフランシスコ)/i;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function jstParts(now = new Date()) {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: JST_WEEKDAYS[shifted.getUTCDay()],
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function jstIso(now = new Date()) {
  const p = jstParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+09:00`;
}

function jstTemporalInstruction(now = new Date()) {
  const p = jstParts(now);
  return `信頼できるサーバー時刻は ${jstIso(now)}（日本標準時 JST / Asia/Tokyo、${p.weekday}曜日）です。` +
    '「今」「現在」「今日」「明日」などの相対時刻は必ずこの時刻を基準に解釈し、UTCやモデル内部時計を現在時刻として使わないでください。' +
    '過去の会話に別の現在時刻が書かれていても、それは過去発言として扱い、このサーバー時刻で上書きしてください。';
}

function namedForeignTimeRequest(value) {
  const valueText = clean(String(value ?? '').normalize('NFKC'), 300);
  if (NON_JST_TIME_CUE_RE.test(valueText) && !/(?:日本|JST|日本時間|東京|大阪|別府|大分)/i.test(valueText)) return true;
  const m = valueText.match(/^(.{2,24}?)(?:は|の)(?:今|現在)(?:は|って)?何時/);
  if (!m) return false;
  return !/(?:日本|東京|大阪|別府|大分|ここ|こちら|現在地)/.test(m[1]);
}

function localJstTemporalAnswer(value, now = new Date()) {
  const valueText = clean(String(value ?? '').normalize('NFKC'), 600);
  if (!valueText || namedForeignTimeRequest(valueText)) return null;

  let match = valueText.match(/今から\s*(\d{1,4})\s*分後/);
  if (match) {
    const minutes = Number(match[1]);
    const target = new Date(now.getTime() + minutes * 60_000);
    const p = jstParts(target);
    return {
      kind: 'jst-relative-time',
      answer: `日本時間では、今から${minutes}分後は${p.hour}時${pad2(p.minute)}分です。`,
      route: 'jst-clock-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now), targetJstIso: jstIso(target), relativeMinutes: minutes,
    };
  }

  match = valueText.match(/今から\s*(\d{1,3})\s*時間後/);
  if (match) {
    const hours = Number(match[1]);
    const target = new Date(now.getTime() + hours * 3_600_000);
    const p = jstParts(target);
    return {
      kind: 'jst-relative-time',
      answer: `日本時間では、今から${hours}時間後は${p.hour}時${pad2(p.minute)}分です。`,
      route: 'jst-clock-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now), targetJstIso: jstIso(target), relativeMinutes: hours * 60,
    };
  }

  if (JST_LOCAL_TIME_RE.test(valueText)) {
    const p = jstParts(now);
    return {
      kind: 'jst-current-time', answer: `現在の日本時間（JST）は${p.hour}時${pad2(p.minute)}分です。`,
      route: 'jst-clock-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now),
    };
  }

  if (JST_DATE_RE.test(valueText)) {
    const tomorrow = /明日/.test(valueText);
    const target = tomorrow ? new Date(now.getTime() + 86_400_000) : now;
    const p = jstParts(target);
    const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    const asksWeekday = /何曜日/.test(valueText);
    return {
      kind: 'jst-current-date',
      answer: asksWeekday
        ? `日本時間では、今日は${p.year}年${p.month}月${p.day}日、${p.weekday}曜日です。`
        : `日本時間では、${tomorrow ? '明日' : '今日'}は${p.year}年${p.month}月${p.day}日です。`,
      route: 'jst-calendar-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now), jstDate: date,
    };
  }
  return null;
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

function buildGeminiRequest(modelArgs = {}, now = new Date()) {
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
    parts: [{ text: clean(`${TALKSYS_IDENTITY_INSTRUCTION}\n\n${jstTemporalInstruction(now)}${inheritedSystem ? `\n\n${inheritedSystem}` : ''}`, 60000) }],
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

function evidenceCorpus(payload = {}, question = '') {
  const sourceText = (Array.isArray(payload?.sources) ? payload.sources : []).map((source) => `${source?.title || ''} ${source?.url || ''}`).join(' ');
  const apiText = (Array.isArray(payload?.apiSources) ? payload.apiSources : []).map((source) => `${source?.tool || ''} ${source?.category || ''} ${source?.attribution || ''} ${source?.sourceUrl || ''}`).join(' ');
  const candidateText = (Array.isArray(payload?.searchDiagnostics?.candidateNames) ? payload.searchDiagnostics.candidateNames : []).join(' ');
  return normalize(`${question} ${sourceText} ${apiText} ${candidateText}`);
}

function namedEntitySupported(token, corpus) {
  const normalized = normalize(token);
  if (!normalized || normalized.length < 2) return true;
  return corpus.includes(normalized);
}

function removeUnsupportedNamedEntities(answer, payload = {}, question = '') {
  const corpus = evidenceCorpus(payload, question);
  const kept = sentences(answer).filter((sentence) => {
    const matches = [...String(sentence || '').matchAll(NAMED_ENTITY_RE)];
    if (!matches.length) return true;
    return matches.every((match) => {
      const token = clean(match[1] || match[2] || match[3], 120);
      return namedEntitySupported(token, corpus);
    });
  });
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

  if (EVIDENCE_REQUIRED_RE.test(question)) {
    if (!hasEvidence && ENTITY_RECOMMENDATION_RE.test(question)) {
      if (answer) reasons.push('entity_evidence_required_but_missing');
      answer = '今回取得できた根拠では、実在や条件適合を確認できる具体候補を挙げられませんでした。';
    } else if (hasEvidence) {
      const guarded = removeUnsupportedNamedEntities(answer, payload, question);
      if (guarded !== answer) reasons.push('named_entities_require_matching_evidence');
      answer = guarded || '取得できた根拠の範囲では、具体名を安全に確認できませんでした。';
    }
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
    system_instruction: `${TALKSYS_IDENTITY_INSTRUCTION}\n\n${jstTemporalInstruction()}`,
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
  out.set('x-talksys-answer-route', clean(data?.route || 'router-first-v53', 80));
  return new Response(JSON.stringify(data), { status, headers: out });
}

async function guardedFetch(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/truth-gate-health') {
    return json({
      ok: true,
      revision: TRUTH_GATE_REVISION,
      responseQualityRevision: RESPONSE_QUALITY_REVISION,
      mode: 'router-first-jst-evidence',
      nativeGeminiAnswerPath: false,
      nativeGoogleSearch: false,
      customTruthGateOnNativeAnswers: false,
      routerFirst: true,
      defaultTimezone: 'Asia/Tokyo',
      authoritativeJstClock: true,
      dynamicFactsRequireEvidence: true,
    });
  }

  if (request.method === 'GET' && url.pathname === '/gemini-health') {
    const configured = hasGeminiKey(env);
    return json({
      ok: configured,
      configured,
      provider: 'gemini',
      model: GEMINI_MODEL,
      api: 'generateContent-adapter',
      nativeGoogleSearch: false,
      routerFirst: true,
      defaultTimezone: 'Asia/Tokyo',
      authoritativeJstClock: true,
      revision: GEMINI_ADAPTER_REVISION,
      responseQualityRevision: RESPONSE_QUALITY_REVISION,
      requiredSecret: 'GEMINI_API_KEY',
      upstreamIdentitySuppressed: true,
      legacyGlmExecution: false,
    });
  }

  let turnBody = null;
  if (request.method === 'POST' && url.pathname === '/api/turn') {
    try {
      turnBody = await request.clone().json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }
    const temporal = localJstTemporalAnswer(turnBody?.text);
    if (temporal) {
      return json({
        ok: true,
        ...temporal,
        planner: 'trusted-jst-clock-v53',
        sources: [],
        apiSources: [],
        generationProvider: 'deterministic',
        generationModel: 'server-jst-clock',
        generationRevision: GEMINI_ADAPTER_REVISION,
        responseQualityRevision: RESPONSE_QUALITY_REVISION,
        geminiConfigured: hasGeminiKey(env),
        legacyGlmExecution: false,
        routerFirst: true,
      }, 200);
    }
  }

  const runtimeEnv = withGeminiGenerationProvider(env);
  const response = await worker.fetch(request, runtimeEnv, ctx);
  const headers = new Headers(response.headers);
  headers.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  headers.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  headers.set('x-talksys-response-quality-revision', RESPONSE_QUALITY_REVISION);

  if (request.method === 'POST' && url.pathname === '/api/turn' && /application\/json/i.test(headers.get('content-type') || '')) {
    try {
      const payload = await response.clone().json();
      const question = clean(turnBody?.text, 1800);
      const gated = gateTurnPayload(payload, question);
      const normalized = normalizeGenerationMetadata({
        ...gated,
        routerFirst: true,
        defaultTimezone: 'Asia/Tokyo',
        authoritativeJstClock: true,
        dynamicFactsRequireEvidence: true,
        nativeGeminiAnswerPath: false,
        nativeGoogleSearch: false,
      }, env);
      return json(normalized, response.status, headers);
    } catch {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }

  if (request.method === 'GET' && url.pathname === '/voice-health' && /application\/json/i.test(headers.get('content-type') || '')) {
    try {
      const body = await response.clone().json();
      const normalized = normalizeGenerationMetadata({
        ...body,
        truthGateRevision: TRUTH_GATE_REVISION,
        truthGatePolicy: 'claim-level-fail-close',
        nativeGeminiAnswerPath: false,
        nativeGoogleSearch: false,
        routerFirst: true,
        defaultTimezone: 'Asia/Tokyo',
        authoritativeJstClock: true,
        dynamicFactsRequireEvidence: true,
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
  removeUnsupportedNamedEntities,
  gateTurnPayload,
  hasGeminiKey,
  isLegacyGlmModel,
  mapGeminiMessages,
  buildGeminiRequest,
  jstParts,
  jstIso,
  jstTemporalInstruction,
  localJstTemporalAnswer,
  namedForeignTimeRequest,
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
