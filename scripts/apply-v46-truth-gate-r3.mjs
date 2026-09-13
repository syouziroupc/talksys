import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact match, got ${count}`);
  return source.replace(before, after);
}

function replaceRegexOnce(source, re, after, label) {
  const matches = source.match(re);
  if (!matches) throw new Error(`${label}: no match`);
  const next = source.replace(re, after);
  if (next === source) throw new Error(`${label}: replacement unchanged`);
  return next;
}

// ---------------- worker: fail closed on unsupported external facts ----------------
const workerPath = 'src/worker-v44.js';
let worker = fs.readFileSync(workerPath, 'utf8');

worker = replaceOnce(worker,
  "const REVISION = 'talksys-v45-parallel-grounding-r2';",
  "const REVISION = 'talksys-v45-truth-gate-r3';",
  'worker revision');

worker = replaceOnce(worker,
  "const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗)/i;",
  "const TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗|(?:駅.{0,36}駅)|(?:駅.{0,24}(?:経路|行き方|所要時間)))/i;\nconst STABLE_FACT_LOOKUP_RE = /(?:とは(?:何|どういう)|って何|誰(?:です|なの|が)|どこ(?:です|なの|にある)|いつ(?:です|なの)|何年|何月|何日|所在地|本社|創業|設立|スペック|仕様|対応OS|対応CPU|何線|何駅|駅順)/i;",
  'worker factual routing regex');

worker = replaceOnce(worker,
  "  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value)) {\n    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'current_or_explicit_lookup' };\n  }\n  return { mode: 'casual', webSearch: false, noExternal: false, reason: 'stable_or_conversational' };",
  "  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value)) {\n    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'current_or_explicit_lookup' };\n  }\n  if (STABLE_FACT_LOOKUP_RE.test(value)) {\n    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'stable_factual_lookup' };\n  }\n  return { mode: 'casual', webSearch: false, noExternal: false, reason: 'stable_or_conversational' };",
  'stable factual lookup routing');

worker = replaceOnce(worker,
  "- 現在の価格、在庫、日時、時刻、法律、制度、人物、ニュース、現行仕様など変化し得る事実は取得根拠にある範囲だけ使う。\n- assistantの過去発言は外部事実の証拠にしない。",
  "- 外部事実として断定する文は、取得根拠がその文の具体的内容を直接支持する場合だけ出す。固有名詞、数値、版番号、日時、場所、交通上の関係を一般知識で穴埋めしない。\n- 現在の価格、在庫、日時、時刻、法律、制度、人物、ニュース、現行仕様など変化し得る事実は取得根拠にある範囲だけ使う。\n- 根拠不足をモデルの記憶や常識で補完しない。確認できた範囲と未確認部分を明確に分離する。\n- assistantの過去発言は外部事実の証拠にしない。",
  'grounded prompt hard factuality');

const noExternalInsert = `function noExternalDynamicFactTurn(body) {
  const text = canonicalizeInput(body?.text, 1800);
  const answer = TRANSIT_QUERY_RE.test(text)
    ? '外部確認を使わない指定なので、現在の具体的な経路・列車・時刻は推測で断定しません。一般的な移動方法の考え方なら説明できます。'
    : '外部確認を使わない指定なので、現在変わり得る事実は推測で断定しません。時間で変化しない一般的な仕組みや判断基準なら説明できます。';
  return {
    ok: true,
    answer,
    search: false,
    searchUseful: false,
    searchFallback: false,
    route: 'no-external-hard-fact-v45',
    factualAnswerStatus: 'unverified_by_user_request',
    resolvedQuestion: text,
    queries: [],
    sources: [],
    timings: { totalMs: 0, glmMs: 0 },
    model: 'mechanical-guard',
    planner: 'unified-router-v45',
    languageMode: 'ja-only',
  };
}

`;
worker = replaceOnce(worker,
  "function deterministicTurn(body, decision) {",
  noExternalInsert + "function deterministicTurn(body, decision) {",
  'no external hard fact turn');

worker = replaceOnce(worker,
  "export function transitEvidenceFallback() {\n  return 'この経路は、具体的な乗換駅・路線名・列車名・所要時間を裏付けられる情報が揃うまで推測で断定しません。時刻を指定した場合も、確認できた経路情報だけを案内します。';\n}\n",
  "export function transitEvidenceFallback() {\n  return 'この経路は、具体的な乗換駅・路線名・列車名・所要時間を裏付けられる情報が揃うまで推測で断定しません。時刻を指定した場合も、確認できた経路情報だけを案内します。';\n}\n\nexport function externalEvidenceFallback(question = '', search = {}) {\n  return TRANSIT_QUERY_RE.test(canonicalizeInput(question, 1800))\n    ? transitEvidenceFallback()\n    : deterministicStableFallback(question, search);\n}\n",
  'external evidence fallback');

const helperInsert = `function normalizedEvidenceAnchor(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\\s,，]/g, '');
}

function factualSupportAnchors(value = '') {
  const text = clean(value, 12000).normalize('NFKC');
  const patterns = [
    /(?:[¥￥]\\s*\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?\\s*円|\\d+(?:\\.\\d+)?\\s*万円)/g,
    /\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b/g,
    /\\b\\d{1,2}:\\d{2}\\b/g,
    /\\d+(?:\\.\\d+)?\\s*(?:年|月|日|時|分|秒|%|％|km|キロ|GB|MB|TB|GHz|MHz|W|V|人|台|件|回)/gi,
    /\\b[A-Za-z][A-Za-z0-9._+\\-]{1,30}\\d[A-Za-z0-9._+\\-]{0,20}\\b/g,
    /[一-龠々〆ヵヶァ-ヴーA-Za-z0-9・]{2,30}(?:株式会社|大学|病院|銀行|省|庁|県|市|区|町|村|駅|本線|新幹線|線)/g,
  ];
  const out = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const v = clean(m[0], 80);
      if (v && !out.includes(v)) out.push(v);
      if (out.length >= 32) return out;
    }
  }
  return out;
}

function evidenceTextForGuard(search = {}) {
  return (search?.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((item) =>
    `${clean(item?.title, 300)} ${clean(item?.excerpt || item?.snippet, 2600)}`
  ).join(' ');
}

export function guardUnsupportedEvidenceAnchors(value, question = '', search = {}) {
  const answer = clean(value, 9000);
  if (!answer || search?.hasAnyEvidence !== true) return answer;
  const evidenceText = evidenceTextForGuard(search);
  if (!evidenceText) return answer;
  const allowed = normalizedEvidenceAnchor(`${canonicalizeInput(question, 2200)} ${evidenceText}`);
  const sentences = answer.match(/[^。！？!?]+[。！？!?]?/g) || [answer];
  const kept = sentences.filter((sentence) => {
    const anchors = factualSupportAnchors(sentence);
    return anchors.every((anchor) => allowed.includes(normalizedEvidenceAnchor(anchor)));
  });
  return clean(kept.join(''), 9000);
}

function evidenceHasNearbyRelation(evidenceText, term, relationRe, radius = 110) {
  const hay = canonicalizeInput(evidenceText, 50000);
  const needle = canonicalizeInput(term, 80);
  if (!needle) return relationRe.test(hay);
  let from = 0;
  while (from < hay.length) {
    const index = hay.indexOf(needle, from);
    if (index < 0) break;
    const window = hay.slice(Math.max(0, index - radius), Math.min(hay.length, index + needle.length + radius));
    if (relationRe.test(window)) return true;
    from = index + needle.length;
  }
  return false;
}

`;
worker = replaceOnce(worker,
  "export function guardUnsupportedTransitEntities(value, question = '', search = {}) {",
  helperInsert + "export function guardUnsupportedTransitEntities(value, question = '', search = {}) {",
  'evidence guard helpers');

worker = replaceOnce(worker,
  "  const kept = sentences.filter((sentence) => {\n    const entities = [...new Set(sentence.match(entityRe) || [])].filter((x) => !generic.has(x));\n    return entities.every((entity) => {\n      if (allowed.includes(entity)) return true;\n      if (entity.endsWith('駅') && allowed.includes(entity.slice(0, -1))) return true;\n      return false;\n    });\n  });",
  "  const kept = sentences.filter((sentence) => {\n    const entities = [...new Set(sentence.match(entityRe) || [])].filter((x) => !generic.has(x));\n    const entitySupported = entities.every((entity) => {\n      if (allowed.includes(entity)) return true;\n      if (entity.endsWith('駅') && allowed.includes(entity.slice(0, -1))) return true;\n      return false;\n    });\n    if (!entitySupported) return false;\n\n    const transferRe = /(?:乗換|乗り換え|乗換え)/i;\n    if (transferRe.test(sentence)) {\n      const point = sentence.match(/([一-龠々〆ヵヶァ-ヴーA-Za-z0-9・]{1,16})(?:駅)?で[^。！？!?]{0,48}(?:乗換|乗り換え|乗換え)/i)?.[1] || '';\n      if (point && !evidenceHasNearbyRelation(evidenceText, point, /(?:乗換|乗り換え|乗換え)/i)) return false;\n      if (!point && !/(?:乗換|乗り換え|乗換え)/i.test(evidenceText)) return false;\n    }\n    if (/(?:直通|乗換なし|乗り換えなし)/i.test(sentence) && !/(?:直通|乗換なし|乗り換えなし)/i.test(evidenceText)) return false;\n    return true;\n  });",
  'transit relational guard');

worker = replaceOnce(worker,
  "        evidenceUseful: apiOk.length > 0,\n        results: [],\n        rounds: 0,\n        coverage: {\n          sufficient: apiOk.length > 0,\n          reason: apiOk.length ? 'structured API evidence retained after web research failure' : 'web_retrieval_failed_no_evidence',\n        },",
  "        evidenceUseful: false,\n        results: [],\n        rounds: 0,\n        coverage: {\n          sufficient: false,\n          reason: apiOk.length ? 'partial_structured_api_evidence_after_web_failure' : 'web_retrieval_failed_no_evidence',\n        },",
  'web failure partial api does not upgrade coverage');

worker = replaceOnce(worker,
  "  search.results = [...apiResults, ...(search.results || [])].slice(0, SEARCH_V44_SOURCE_LIMIT);\n  if (apiResults.length) search.evidenceUseful = true;\n\n  let answer;",
  "  search.results = [...apiResults, ...(search.results || [])].slice(0, SEARCH_V44_SOURCE_LIMIT);\n  search.hasAnyEvidence = apiOk.length > 0 || search.evidenceUseful === true;\n\n  let answer;",
  'separate evidence presence from sufficiency');

worker = replaceRegexOnce(worker,
  /  if \(!apiOk\.length && !search\.evidenceUseful\) \{[\s\S]*?\n  \} else \{\n    try \{\n      answer = await synthesizeGroundedAnswer/,
  `  const hasUsableEvidence = search.hasAnyEvidence === true;\n  const coverageSufficient = structuredEnough || search.coverage?.sufficient === true;\n  if (!hasUsableEvidence) {\n    answerSynthesisFallback = true;\n    answerSynthesisError = TRANSIT_QUERY_RE.test(text)\n      ? 'transit_external_evidence_unavailable'\n      : 'external_evidence_unavailable_fail_closed';\n    answer = { text: externalEvidenceFallback(text, search), ms: 0 };\n  } else {\n    try {\n      answer = await synthesizeGroundedAnswer`,
  'global external zero-evidence fail close');

worker = replaceOnce(worker,
  "  answer.text = sanitizeUserFacingAnswer(answer?.text, text, { hasLivePriceEvidence: search?.hasPriceEvidence === true });\n  answer.text = guardUnsupportedTransitEntities(answer.text, text, search);",
  "  answer.text = sanitizeUserFacingAnswer(answer?.text, text, { hasLivePriceEvidence: search?.hasPriceEvidence === true });\n  answer.text = guardUnsupportedTransitEntities(answer.text, text, search);\n  answer.text = guardUnsupportedEvidenceAnchors(answer.text, text, search);\n  if (!answer.text) answer.text = externalEvidenceFallback(text, search);",
  'post synthesis evidence guards');

worker = replaceOnce(worker,
  "    searchUseful: Boolean(search.evidenceUseful),\n    resolvedQuestion:",
  "    searchUseful: hasUsableEvidence,\n    factualAnswerStatus: coverageSufficient ? 'verified' : hasUsableEvidence ? 'partial_evidence' : 'insufficient_evidence',\n    coverageSufficient,\n    evidenceItemCount: (search.results || []).length,\n    resolvedQuestion:",
  'factual answer status');

worker = replaceOnce(worker,
  "        transitZeroEvidenceFailClosed: true,",
  "        transitZeroEvidenceFailClosed: true,\n        externalZeroEvidenceFailClosed: true,\n        genericEvidenceAnchorGuard: true,\n        transitRelationGuard: true,\n        stableFactLookupSearch: true,\n        partialApiDoesNotUpgradeCoverage: true,",
  'health truth-gate flags');

worker = replaceOnce(worker,
  "      } else if (decision.mode === 'casual') {\n        data = await casualTurn(normalizedBody, env);",
  "      } else if (decision.mode === 'casual') {\n        data = decision.noExternal && DYNAMIC_FACT_RE.test(normalizedBody.text)\n          ? noExternalDynamicFactTurn(normalizedBody)\n          : await casualTurn(normalizedBody, env);",
  'no external dynamic routing');

worker = replaceOnce(worker,
  "  guardUnsupportedTransitEntities,\n  transitEvidenceFallback,",
  "  guardUnsupportedTransitEntities,\n  guardUnsupportedEvidenceAnchors,\n  transitEvidenceFallback,\n  externalEvidenceFallback,",
  'worker test exports');

fs.writeFileSync(workerPath, worker);

// ---------------- search: semantic transit evidence instead of document-count evidence ----------------
const searchPath = 'src/search-v45.js';
let search = fs.readFileSync(searchPath, 'utf8');

search = replaceOnce(search,
  "export const SEARCH_V44_REVISION = 'deep-search-v45-api-primary-multi-engine-web';",
  "export const SEARCH_V44_REVISION = 'deep-search-v45-truth-gate-r3';",
  'search revision');

search = replaceOnce(search,
  "const TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|列車|時刻表|何時発|何に乗|所要時間|経路)/i;",
  "const TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|列車|時刻表|何時発|何に乗|所要時間|経路|(?:駅.{0,36}駅)|(?:駅.{0,24}行き方))/i;\nconst TRUSTED_TRANSIT_HOST_RE = /(?:^|\\.)(?:jrkyushu\\.co\\.jp|jrkyushu-timetable\\.jp|jr-odekake\\.net|jreast\\.co\\.jp|jr-central\\.co\\.jp|jrhokkaido\\.co\\.jp|jr-shikoku\\.co\\.jp|transit\\.yahoo\\.co\\.jp|ekitan\\.com|jorudan\\.co\\.jp|navitime\\.co\\.jp)$/i;\nconst TRANSIT_SEMANTIC_RE = /(乗換|乗り換え|直通|所要|発|着|経路|本線|新幹線|特急|快速|普通|時刻)/i;",
  'search transit semantics');

search = replaceOnce(search,
  "export function transitEndpointsV46(value) {\n  const text = clean(value, 700).normalize('NFKC');\n  const token = '[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]';\n  const pair = text.match(new RegExp('(' + token + '{1,24}?)(?:駅)?\\\\s*から\\\\s*(' + token + '{1,24}?)(?:駅)?\\\\s*(?:まで|へ)', 'i'));\n  if (!pair?.[1] || !pair?.[2]) return [];\n  return [clean(pair[1], 40), clean(pair[2], 40)].filter(Boolean);\n}",
  "export function transitEndpointsV46(value) {\n  const text = clean(value, 700).normalize('NFKC');\n  const token = '[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]';\n  let pair = text.match(new RegExp('(' + token + '{1,24}?)(?:駅)?\\\\s*から\\\\s*(' + token + '{1,24}?)(?:駅)?\\\\s*(?:まで|へ)', 'i'));\n  if (!pair) pair = text.match(new RegExp('(' + token + '{1,24}?)(?:駅)?\\\\s*(?:→|⇒|->|〜|～)\\\\s*(' + token + '{1,24}?)(?:駅)?', 'i'));\n  if (!pair?.[1] || !pair?.[2]) return [];\n  return [clean(pair[1], 40), clean(pair[2], 40)].filter(Boolean);\n}",
  'transit endpoint parser');

search = replaceOnce(search,
  "    const data = readToolArguments(result);\n    if (!data || !Array.isArray(data.facets) || !data.facets.length) throw new Error('director_invalid_plan');",
  "    const data = readToolArguments(result);\n    if (!data || !Array.isArray(data.facets) || !data.facets.length) throw new Error('director_invalid_plan');\n    if (fallback.intent === 'transit') {\n      return {\n        ...fallback,\n        resolvedQuestion: clean(data.resolved_question || fallback.resolvedQuestion, 2200),\n        planned: true,\n        plannerModel: DIRECTOR_MODEL,\n        plannerTransport: 'tool_call-protected-transit',\n        plannerError: '',\n      };\n    }",
  'protect deterministic transit intent');

const transitCoverageFn = `export function transitEvidenceCoverage(question, results = []) {
  const endpoints = transitEndpointsV46(question);
  const required = TRANSIT_RE.test(clean(question, 1800));
  if (!required) return { required: false, sufficient: true, endpoints: [], trustedPairCount: 0, trustedHosts: [] };
  if (endpoints.length < 2) return { required: true, sufficient: false, endpoints, trustedPairCount: 0, trustedHosts: [] };
  const [from, to] = endpoints.map((x) => normalize(x.replace(/駅$/u, '')));
  const qualifying = [];
  for (const item of results || []) {
    const host = hostOf(item?.url || '');
    if (!TRUSTED_TRANSIT_HOST_RE.test(host)) continue;
    const body = normalize(`${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`);
    if (!body.includes(from) || !body.includes(to) || !TRANSIT_SEMANTIC_RE.test(body)) continue;
    qualifying.push({ host, title: clean(item?.title, 180) });
  }
  const trustedHosts = [...new Set(qualifying.map((x) => x.host))];
  return {
    required: true,
    sufficient: qualifying.length > 0,
    endpoints,
    trustedPairCount: qualifying.length,
    trustedHosts,
  };
}

`;
search = replaceOnce(search,
  "function priceRecoveryFacets(plan, ranked = []) {",
  transitCoverageFn + "function priceRecoveryFacets(plan, ranked = []) {",
  'transit evidence coverage function');

search = replaceOnce(search,
  "  const baseEvidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);\n  const requiresCurrentFirmwareVersion =",
  "  const baseEvidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);\n  const transitCoverage = transitEvidenceCoverage(plan.resolvedQuestion, ranked);\n  const requiresCurrentFirmwareVersion =",
  'compute transit coverage');

search = replaceOnce(search,
  "  const evidenceUseful = baseEvidenceUseful\n    && (!requiresCurrentFirmwareVersion || hasCurrentFirmwareVersionEvidence)\n    && (!requiresPriceEvidence || hasPriceEvidence);",
  "  const evidenceUseful = baseEvidenceUseful\n    && (!requiresCurrentFirmwareVersion || hasCurrentFirmwareVersionEvidence)\n    && (!requiresPriceEvidence || hasPriceEvidence)\n    && (!transitCoverage.required || transitCoverage.sufficient);",
  'transit evidence gate');

search = replaceOnce(search,
  "      reason: sufficient ? 'staged_evidence_sufficient' : (ranked.length ? 'partial_evidence' : 'no_results'),\n      missingFacets: sufficient ? [] : unique([...(requiresPriceEvidence && !hasPriceEvidence ? ['current-price'] : []), ...(plan.facets || []).map(f => f.id)], 8),",
  "      reason: sufficient ? 'staged_evidence_sufficient' : (transitCoverage.required && !transitCoverage.sufficient ? 'transit_route_evidence_missing' : (ranked.length ? 'partial_evidence' : 'no_results')),\n      missingFacets: sufficient ? [] : unique([...(requiresPriceEvidence && !hasPriceEvidence ? ['current-price'] : []), ...(transitCoverage.required && !transitCoverage.sufficient ? ['transit-route-pair'] : []), ...(plan.facets || []).map(f => f.id)], 8),",
  'coverage reason');

search = replaceOnce(search,
  "    requiresPriceEvidence,\n    hasPriceEvidence,\n    timings,",
  "    requiresPriceEvidence,\n    hasPriceEvidence,\n    transitEvidenceRequired: transitCoverage.required,\n    transitEvidenceSufficient: transitCoverage.sufficient,\n    transitEvidenceEndpoints: transitCoverage.endpoints,\n    transitTrustedPairCount: transitCoverage.trustedPairCount,\n    transitTrustedHosts: transitCoverage.trustedHosts,\n    timings,",
  'transit diagnostics');

search = replaceOnce(search,
  "export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates, isPriceQuestion, concreteMoneyMentions, hasConcretePriceEvidence, priceRecoveryFacets };",
  "export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates, isPriceQuestion, concreteMoneyMentions, hasConcretePriceEvidence, priceRecoveryFacets, transitEvidenceCoverage };",
  'search test exports');

fs.writeFileSync(searchPath, search);

// ---------------- API intent: station-pair wording must stay transit, not road routing ----------------
const apiPath = 'src/free-api-tools-v45.js';
let api = fs.readFileSync(apiPath, 'utf8');
api = replaceOnce(api,
  "const TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗)/i;",
  "const TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗|(?:駅.{0,36}駅)|(?:駅.{0,24}(?:経路|行き方|所要時間)))/i;",
  'API station-pair transit intent');
fs.writeFileSync(apiPath, api);

// ---------------- regression tests ----------------
const testPath = 'tests/v46-truth-gate-r3.test.mjs';
fs.writeFileSync(testPath, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { classifyTurn, guardUnsupportedTransitEntities, guardUnsupportedEvidenceAnchors } from '../src/worker-v44.js';\nimport { transitEndpointsV46, transitEvidenceCoverage } from '../src/search-v45.js';\nimport { detectApiIntents } from '../src/free-api-tools-v45.js';\n\ntest('stable named specification questions are grounded instead of casual parametric answers', () => {\n  const d = classifyTurn('MSI X79A-GD45の仕様は？', []);\n  assert.equal(d.mode, 'external');\n  assert.equal(d.webSearch, true);\n  assert.equal(d.reason, 'stable_factual_lookup');\n});\n\ntest('station-pair route wording remains transit intent, not road routing', () => {\n  const intents = detectApiIntents('大分駅から行橋駅までの行き方', []);\n  assert.ok(intents.includes('transit'));\n  assert.ok(!intents.includes('route'));\n});\n\ntest('transit parser accepts arrow notation', () => {\n  assert.deepEqual(transitEndpointsV46('大分駅 → 行橋駅 電車'), ['大分', '行橋']);\n});\n\ntest('transit evidence requires a trusted route source containing both endpoints', () => {\n  const q = '大分駅から行橋駅まで電車で行きたい';\n  const bad = transitEvidenceCoverage(q, [{ title: '大分と行橋の観光', url: 'https://example.com/a', excerpt: '大分 行橋 電車 経路' }]);\n  assert.equal(bad.sufficient, false);\n  const good = transitEvidenceCoverage(q, [{ title: 'JR九州 列車時刻', url: 'https://www.jrkyushu.co.jp/trains/sonic/', excerpt: '大分 発 特急 行橋 着 小倉' }]);\n  assert.equal(good.sufficient, true);\n});\n\ntest('transit transfer relation must itself be present near the claimed transfer point', () => {\n  const search = {\n    evidenceUseful: true, hasAnyEvidence: true,\n    results: [{ title: 'JR九州 日豊本線', excerpt: '大分 行橋 小倉 日豊本線 鹿児島本線。行橋は日豊本線の駅。' }],\n  };\n  const out = guardUnsupportedTransitEntities('小倉で日豊本線から鹿児島本線に乗り換えます。', '大分から行橋まで電車で行きたい', search);\n  assert.doesNotMatch(out, /小倉で.*乗り換/);\n});\n\ntest('unsupported numeric or model anchors are removed after grounded synthesis', () => {\n  const search = { hasAnyEvidence: true, results: [{ title: '公式BIOS', excerpt: '確認できる版はV2.8です。' }] };\n  const out = guardUnsupportedEvidenceAnchors('最新版はV2.9です。公式手順に従って更新してください。', '最新BIOSを確認して', search);\n  assert.doesNotMatch(out, /V2\\.9/);\n  assert.match(out, /公式手順/);\n});\n\ntest('external no-evidence path is fail-closed and partial API cannot upgrade coverage', () => {\n  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');\n  assert.match(source, /external_evidence_unavailable_fail_closed/);\n  assert.match(source, /search\\.hasAnyEvidence = apiOk\\.length > 0 \\|\\| search\\.evidenceUseful === true/);\n  assert.doesNotMatch(source, /if \\(apiResults\\.length\\) search\\.evidenceUseful = true/);\n  assert.match(source, /externalZeroEvidenceFailClosed: true/);\n  assert.match(source, /partialApiDoesNotUpgradeCoverage: true/);\n});\n`);

// ---------------- production regression smoke ----------------
const deployPath = '.github/workflows/deploy.yml';
let deploy = fs.readFileSync(deployPath, 'utf8');
const smokeAnchor = `          payload='{"text":"別府市の今日の天気は？","history":[]}'
          out="$(curl -fsS --max-time 75 -H 'content-type: application/json' --data "$payload" "$PRODUCTION_URL/api/turn")"
          OUT="$out" node -e "const d=JSON.parse(process.env.OUT||'{}');const tools=(d.apiSources||[]).map(x=>x.tool);if(!d.ok||d.route!=='api-first-v45'||!tools.includes('jma_weather'))throw new Error(process.env.OUT);"
`;
const smokeReplacement = smokeAnchor + `
          payload='{"text":"大分から行橋まで電車でどうやって行けばいい？","history":[]}'
          out="$(curl -fsS --max-time 75 -H 'content-type: application/json' --data "$payload" "$PRODUCTION_URL/api/turn")"
          OUT="$out" node - <<'NODE'
          const d=JSON.parse(process.env.OUT||'{}');
          if(!d.ok) throw new Error(process.env.OUT);
          const a=String(d.answer||'');
          if(/小倉[^。]{0,50}(?:鹿児島本線|乗り換|乗換)/.test(a) || /鹿児島本線[^。]{0,50}(?:乗り換|乗換)/.test(a)) throw new Error('transit regression: '+a);
          if(d.factualAnswerStatus==='insufficient_evidence' && /(ソニック|小倉|鹿児島本線|\\d+分|\\d+時間)/.test(a)) throw new Error('unsupported transit specifics leaked: '+a);
          NODE
`;
deploy = replaceOnce(deploy, smokeAnchor, smokeReplacement, 'production transit smoke');
fs.writeFileSync(deployPath, deploy);

console.log('Applied r3 truth gate, transit semantic evidence, and production regression coverage.');
