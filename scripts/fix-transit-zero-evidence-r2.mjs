import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact match, got ${count}`);
  return source.replace(before, after);
}

const workerPath = 'src/worker-v44.js';
let worker = fs.readFileSync(workerPath, 'utf8');

worker = replaceOnce(
  worker,
  "const REVISION = 'talksys-v45-parallel-grounding-r1';",
  "const REVISION = 'talksys-v45-parallel-grounding-r2';",
  'worker revision',
);

const oldGuardStart = `export function guardUnsupportedTransitEntities(value, question = '', search = {}) {
  const answer = clean(value, 9000);
  const q = canonicalizeInput(question, 1800);
  if (!answer || !TRANSIT_QUERY_RE.test(q)) return answer;

  const evidenceText = (search?.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((item) =>
    clean(item?.title, 300) + ' ' + clean(item?.excerpt || item?.snippet, 2200)
).join(' ');`;

const newGuardStart = `export function transitEvidenceFallback() {
  return 'この経路は、具体的な乗換駅・路線名・列車名・所要時間を裏付けられる情報が揃うまで推測で断定しません。時刻を指定した場合も、確認できた経路情報だけを案内します。';
}

export function guardUnsupportedTransitEntities(value, question = '', search = {}) {
  const answer = clean(value, 9000);
  const q = canonicalizeInput(question, 1800);
  if (!answer || !TRANSIT_QUERY_RE.test(q)) return answer;

  const evidenceItems = (search?.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).filter((item) =>
    clean(item?.title, 300) || clean(item?.excerpt || item?.snippet, 2200)
  );
  if (search?.evidenceUseful !== true || evidenceItems.length === 0) return transitEvidenceFallback();

  const evidenceText = evidenceItems.map((item) =>
    clean(item?.title, 300) + ' ' + clean(item?.excerpt || item?.snippet, 2200)
  ).join(' ');`;
worker = replaceOnce(worker, oldGuardStart, newGuardStart, 'transit guard fail-closed');

worker = replaceOnce(
  worker,
  "  return '具体的な乗換駅・路線名・列車名は、今回取得できた根拠で確認できたものだけ案内します。';",
  "  return transitEvidenceFallback();",
  'transit guard fallback',
);

const oldNoEvidence = `  if (!apiOk.length && !search.evidenceUseful) {
    answerSynthesisFallback = true;
    const partialEvidence = (search.results || []).slice(0, 5).map((item, index) =>`;
const newNoEvidence = `  if (!apiOk.length && !search.evidenceUseful) {
    answerSynthesisFallback = true;
    if (TRANSIT_QUERY_RE.test(text)) {
      // A route question without usable route evidence must not fall through to
      // parametric-memory prose. This path is both safer and faster than a GLM retry.
      answerSynthesisError = 'transit_external_evidence_unavailable';
      answer = { text: transitEvidenceFallback(), ms: 0 };
    } else {
    const partialEvidence = (search.results || []).slice(0, 5).map((item, index) =>`;
worker = replaceOnce(worker, oldNoEvidence, newNoEvidence, 'transit no-evidence bypass');

const oldBranchClose = `    } catch (error) {
      answerSynthesisError = clean(error?.message || error, 240);
      answer = { text: deterministicStableFallback(text, search), ms: 0 };
    }
  } else {
    try {
      answer = await synthesizeGroundedAnswer(env, normalizedBody, search);`;
const newBranchClose = `    } catch (error) {
      answerSynthesisError = clean(error?.message || error, 240);
      answer = { text: deterministicStableFallback(text, search), ms: 0 };
    }
    }
  } else {
    try {
      answer = await synthesizeGroundedAnswer(env, normalizedBody, search);`;
worker = replaceOnce(worker, oldBranchClose, newBranchClose, 'close transit no-evidence bypass');

worker = replaceOnce(
  worker,
  '        transitEvidenceGuard: true,',
  '        transitEvidenceGuard: true,\n        transitZeroEvidenceFailClosed: true,',
  'health transit zero-evidence flag',
);

worker = replaceOnce(
  worker,
  '  guardUnsupportedTransitEntities,\n  deepPlan,',
  '  guardUnsupportedTransitEntities,\n  transitEvidenceFallback,\n  deepPlan,',
  'test export transit fallback',
);

fs.writeFileSync(workerPath, worker);

const searchPath = 'src/search-v45.js';
let search = fs.readFileSync(searchPath, 'utf8');

search = replaceOnce(
  search,
  "      intent: { type: 'string', enum: ['shopping','local','current','comparison','general','news','other'] },",
  "      intent: { type: 'string', enum: ['shopping','local','current','comparison','general','news','transit','other'] },",
  'director transit intent',
);

search = replaceOnce(
  search,
  "const CURRENT_RE = /(最新|現在|今日|明日|今|価格|値段|在庫|営業時間|法律|制度|規制|ニュース|発売|販売|予定|日程|時刻|天気|株価|為替|BIOS|UEFI|ファームウェア|ドライバ|バージョン)/i;",
  "const CURRENT_RE = /(最新|現在|今日|明日|今|価格|値段|在庫|営業時間|法律|制度|規制|ニュース|発売|販売|予定|日程|時刻|天気|株価|為替|BIOS|UEFI|ファームウェア|ドライバ|バージョン)/i;\nconst TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|列車|時刻表|何時発|何に乗|所要時間|経路)/i;",
  'search transit regex',
);

search = replaceOnce(
  search,
  "function inferIntent(value) {\n  if (LOCAL_RE.test(value)) return 'local';",
  "function inferIntent(value) {\n  if (TRANSIT_RE.test(value)) return 'transit';\n  if (LOCAL_RE.test(value)) return 'local';",
  'search transit intent order',
);

const insertAfterBudget = `function budgetToken(value) {
  const man = value.match(/(\\d+(?:\\.\\d+)?)\\s*万円\\s*(?:以下|以内)?/);
  if (man) return \`${'${man[1]}'}万円以下\`;
  const yen = value.match(/([\\d,]{4,})\\s*円\\s*(?:以下|以内)?/);
  return yen ? \`${'${yen[1]}'}円以下\` : '';
}
`;

const transitHelpers = `function budgetToken(value) {
  const man = value.match(/(\\d+(?:\\.\\d+)?)\\s*万円\\s*(?:以下|以内)?/);
  if (man) return \`${'${man[1]}'}万円以下\`;
  const yen = value.match(/([\\d,]{4,})\\s*円\\s*(?:以下|以内)?/);
  return yen ? \`${'${yen[1]}'}円以下\` : '';
}

export function transitEndpointsV46(value) {
  const text = clean(value, 700).normalize('NFKC');
  const token = '[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]';
  const pair = text.match(new RegExp('(' + token + '{1,24}?)(?:駅)?\\\\s*から\\\\s*(' + token + '{1,24}?)(?:駅)?\\\\s*(?:まで|へ)', 'i'));
  if (!pair?.[1] || !pair?.[2]) return [];
  return [clean(pair[1], 40), clean(pair[2], 40)].filter(Boolean);
}

export function transitQueriesV46(value) {
  const endpoints = transitEndpointsV46(value);
  if (endpoints.length < 2) return [compactSubject(value)];
  const [from, to] = endpoints;
  return unique([
    \`${'${from} ${to}'} 乗換案内\`,
    \`${'${from} ${to}'} 電車 経路 所要時間\`,
    \`${'${from} ${to}'} 直通 乗り換え\`,
  ], 3);
}
`;
search = replaceOnce(search, insertAfterBudget, transitHelpers, 'transit helper insertion');

search = replaceOnce(
  search,
  "  if (intent === 'shopping') {",
  "  if (intent === 'transit') {\n    researchMode = 'direct_fact'; candidateType = 'place';\n    queries.push(...transitQueriesV46(resolved));\n  } else if (intent === 'shopping') {",
  'simple plan transit branch',
);

search = replaceOnce(
  search,
  "      sourceRole: intent === 'shopping' ? 'seller' : intent === 'news' ? 'news' : intent === 'local' ? 'map' : (domain ? 'official_support' : 'primary'),",
  "      sourceRole: intent === 'shopping' ? 'seller' : intent === 'news' ? 'news' : intent === 'local' ? 'map' : intent === 'transit' ? 'reference' : (domain ? 'official_support' : 'primary'),",
  'transit source role',
);

fs.writeFileSync(searchPath, search);

const testPath = 'tests/v46-transit-zero-evidence.test.mjs';
fs.writeFileSync(testPath, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { guardUnsupportedTransitEntities, transitEvidenceFallback } from '../src/worker-v44.js';\nimport { transitEndpointsV46, transitQueriesV46 } from '../src/search-v45.js';\n\ntest('transit endpoints and seed queries are deterministic and model-free', () => {\n  assert.deepEqual(transitEndpointsV46('大分から行橋まで電車でどうやって行けばいい？'), ['大分', '行橋']);\n  const q = transitQueriesV46('大分から行橋まで電車でどうやって行けばいい？');\n  assert.equal(q.length, 3);\n  assert.ok(q.every(x => x.includes('大分') && x.includes('行橋')));\n});\n\ntest('zero-evidence transit never leaks parametric route specifics', () => {\n  const out = guardUnsupportedTransitEntities(\n    '大分から小倉までは特急ソニックで約1時間半です。行橋は小倉より手前です。',\n    '大分から行橋まで電車でどうやって行けばいい？',\n    { evidenceUseful: false, results: [] },\n  );\n  assert.equal(out, transitEvidenceFallback());\n  assert.doesNotMatch(out, /小倉|ソニック|1時間半|鹿児島本線/);\n});\n\ntest('deep turn bypasses the answer model for transit when retrieval is insufficient', () => {\n  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');\n  assert.match(source, /transit_external_evidence_unavailable/);\n  assert.match(source, /transitZeroEvidenceFailClosed: true/);\n  assert.match(source, /answer = \\{ text: transitEvidenceFallback\\(\\), ms: 0 \\}/);\n});\n`);

console.log('Applied transit zero-evidence fail-close and deterministic transit seed queries.');
