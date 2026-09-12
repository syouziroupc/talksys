import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact match, got ${count}`);
  return source.replace(before, after);
}

function replaceRegexOnce(source, regex, after, label) {
  const matches = source.match(regex);
  if (!matches) throw new Error(`${label}: no match`);
  const first = source.replace(regex, after);
  if (first === source) throw new Error(`${label}: replacement was a no-op`);
  return first;
}

const workerPath = 'src/worker-v44.js';
let worker = fs.readFileSync(workerPath, 'utf8');

worker = replaceOnce(
  worker,
  "const REVISION = 'talksys-v45-api-primary-multi-engine-search-r2';",
  "const REVISION = 'talksys-v45-parallel-grounding-r1';",
  'worker revision',
);

worker = replaceOnce(
  worker,
  "const NON_API_FACT_RE = /(BIOS|UEFI|ファームウェア|ドライバ|Windows|macOS|Linux|古物|法律|法令|社長|CEO|首相|大統領|ニュース|中古(?:PC|パソコン)|スマホ|型番|仕様|公式配布|配布元)/i;",
  "const NON_API_FACT_RE = /(BIOS|UEFI|ファームウェア|ドライバ|Windows|macOS|Linux|古物|法律|法令|社長|CEO|首相|大統領|ニュース|中古(?:PC|パソコン)|スマホ|型番|仕様|公式配布|配布元)/i;\nconst TRANSIT_QUERY_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗)/i;",
  'transit query regex',
);

worker = replaceOnce(
  worker,
  "- 根拠にない店名、価格、住所、型番、数値を作らない。\n- 電話で聞きやすい自然な日本語で通常3〜6文。URLや検索回数は読み上げない。`;",
  "- 根拠にない店名、価格、住所、型番、数値を作らない。\n- 交通経路では、取得根拠に明記されていない乗換駅・路線名・列車名・駅順を内部知識で補わない。\n- 電話で聞きやすい自然な日本語で通常3〜6文。URLや検索回数は読み上げない。`;",
  'grounded transit rule',
);

worker = replaceOnce(
  worker,
  "async function synthesizeGroundedAnswer(env, body, search) {\n  const hist = historyOf(body?.history).slice(-10);",
  "async function synthesizeGroundedAnswer(env, body, search) {\n  // Assistant prose is conversational context, not factual evidence. For grounded\n  // turns we keep only user-authored history and the freshly retrieved evidence.\n  const hist = userHistory(body?.history).slice(-8);",
  'grounded history quarantine',
);

worker = replaceOnce(
  worker,
  "        ...historyOf(normalizedBody?.history).slice(-8),",
  "        ...userHistory(normalizedBody?.history).slice(-6),",
  'partial evidence history quarantine',
);

const guardFunction = String.raw`
export function guardUnsupportedTransitEntities(value, question = '', search = {}) {
  const answer = clean(value, 9000);
  const q = canonicalizeInput(question, 1800);
  if (!answer || !TRANSIT_QUERY_RE.test(q)) return answer;

  const evidenceText = (search?.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((item) =>
    `${clean(item?.title, 300)} ${clean(item?.excerpt || item?.snippet, 2200)}`
  ).join(' ');
  const allowed = canonicalizeInput(`${q} ${evidenceText}`, 30000);
  const generic = new Set(['路線', '電車', '鉄道', '新幹線', '特急', '快速']);
  const entityRe = /[一-龠々〆ヵヶぁ-んァ-ヴーA-Za-z0-9・]{1,18}(?:本線|新幹線|駅|線|ソニック|にちりん|かもめ|ゆふ|みずほ|さくら|のぞみ|ひかり|こだま)/gu;
  const sentences = answer.match(/[^。！？!?]+[。！？!?]?/g) || [answer];
  const kept = sentences.filter((sentence) => {
    const entities = [...new Set(sentence.match(entityRe) || [])].filter((x) => !generic.has(x));
    return entities.every((entity) => {
      if (allowed.includes(entity)) return true;
      if (entity.endsWith('駅') && allowed.includes(entity.slice(0, -1))) return true;
      return false;
    });
  });
  const guarded = clean(kept.join(''), 9000);
  if (guarded) return guarded;
  return '具体的な乗換駅・路線名・列車名は、今回取得できた根拠で確認できたものだけ案内します。';
}
`;

worker = replaceOnce(
  worker,
  "function researchFailureTurn(body, error) {",
  `${guardFunction}\nfunction researchFailureTurn(body, error) {`,
  'transit evidence guard insertion',
);

worker = replaceOnce(
  worker,
  "  answer.text = sanitizeUserFacingAnswer(answer?.text, text, { hasLivePriceEvidence: search?.hasPriceEvidence === true });",
  "  answer.text = sanitizeUserFacingAnswer(answer?.text, text, { hasLivePriceEvidence: search?.hasPriceEvidence === true });\n  answer.text = guardUnsupportedTransitEntities(answer.text, text, search);",
  'apply transit evidence guard',
);

worker = replaceOnce(
  worker,
  "        apiParallel: true,",
  "        apiParallel: true,\n        searchDirectorParallelSeed: true,\n        groundedHistoryUserOnly: true,\n        transitEvidenceGuard: true,",
  'health flags',
);

worker = replaceOnce(
  worker,
  "  structuredCoverageIsWholeQuestion,\n  deepPlan,",
  "  structuredCoverageIsWholeQuestion,\n  guardUnsupportedTransitEntities,\n  deepPlan,",
  'test export',
);

fs.writeFileSync(workerPath, worker);

const searchPath = 'src/search-v45.js';
let search = fs.readFileSync(searchPath, 'utf8');

const oldRoundOne = /  const p0 = Date\.now\(\);\n  const plan = await directorPlan\(ai, text, history, signal\);\n  timings\.plannerMs = Date\.now\(\) - p0;\n\n  let firstFacets = \(plan\.facets \|\| \[\]\)\.filter\(f => f\.primaryQuery\);[\s\S]*?  diagnostics\.push\(\.\.\.first\.map\(x => x\.diag\), \.\.\.\(shopping\.diagnostics \|\| \[\]\)\);/;

const newRoundOne = `  const p0 = Date.now();
  // Start a deterministic seed retrieval immediately instead of making the
  // Search Director a mandatory serial pre-flight. The Director still refines
  // complex research, but its latency is hidden behind useful retrieval work.
  const seedPlan = simplePlan(text, history);
  let seedFacets = (seedPlan.facets || []).filter(f => f.primaryQuery);
  if (seedPlan.researchMode === 'discover_then_verify') seedFacets = seedFacets.filter(f => f.stage === 'discovery').slice(0, 2);
  if (!seedFacets.length) seedFacets = (seedPlan.queries || []).slice(0, 2).map((q, i) => ({ id: \`seed-q\${i + 1}\`, stage: 'verification', sourceRole: 'reference', primaryQuery: q }));
  seedFacets = seedFacets.slice(0, 2);

  const r1 = Date.now();
  const planPromise = directorPlan(ai, text, history, signal).then((plan) => {
    timings.plannerMs = Date.now() - p0;
    return plan;
  });
  const seedSearchPromise = SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED
    ? Promise.all(seedFacets.map(f => searchOne(f, deadline)))
    : Promise.resolve([]);
  const seedDirectPromise = fetchDirectPrimarySources(seedPlan.resolvedQuestion, deadline);
  const seedShoppingPromise = seedPlan.intent === 'shopping'
    ? searchFormalShoppingApis(seedPlan.resolvedQuestion, options.env || {}, deadline)
    : Promise.resolve({ revision: SHOPPING_API_REVISION, results: [], diagnostics: [], configuredCount: 0, successfulCount: 0 });

  const [plan, seedFirst, directPrimary, seedShopping] = await Promise.all([
    planPromise,
    seedSearchPromise,
    seedDirectPromise,
    seedShoppingPromise,
  ]);

  let firstFacets = (plan.facets || []).filter(f => f.primaryQuery);
  if (plan.researchMode === 'discover_then_verify') firstFacets = firstFacets.filter(f => f.stage === 'discovery').slice(0, 2);
  if (!firstFacets.length) firstFacets = (plan.queries || []).slice(0, 2).map((q, i) => ({ id: \`q\${i + 1}\`, stage: 'verification', sourceRole: 'reference', primaryQuery: q }));
  firstFacets = firstFacets.slice(0, 2);

  const facetKey = (f) => \`\${clean(f?.stage, 30)}|\${clean(f?.sourceRole, 40)}|\${normalize(f?.primaryQuery || '')}\`;
  const seedKeys = new Set(seedFacets.map(facetKey));
  const supplementalFacets = firstFacets.filter((f) => !seedKeys.has(facetKey(f))).slice(0, 2);
  const supplemental = SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED && supplementalFacets.length && deadline - Date.now() > 700
    ? await Promise.all(supplementalFacets.map(f => searchOne(f, deadline)))
    : [];
  const first = [...seedFirst, ...supplemental];
  const shopping = plan.intent === 'shopping'
    ? (seedPlan.intent === 'shopping'
      ? seedShopping
      : await searchFormalShoppingApis(plan.resolvedQuestion, options.env || {}, deadline))
    : { revision: SHOPPING_API_REVISION, results: [], diagnostics: [], configuredCount: 0, successfulCount: 0 };

  diagnostics.push(...first.map(x => x.diag), ...(shopping.diagnostics || []));`;

search = replaceRegexOnce(search, oldRoundOne, newRoundOne, 'parallel director seed retrieval');

search = replaceOnce(
  search,
  "  const allQueries = firstFacets.map(f => f.primaryQuery);",
  "  const allQueries = unique([...seedFacets, ...firstFacets].map(f => f.primaryQuery), SEARCH_V44_MAX_TOTAL_QUERIES);",
  'all query accounting',
);

search = replaceOnce(
  search,
  "    questionFirstPlanning: true,",
  "    questionFirstPlanning: true,\n    directorParallelSeedSearch: true,",
  'search diagnostics parallel flag',
);

fs.writeFileSync(searchPath, search);

const testPath = 'tests/v46-parallel-grounding.test.mjs';
fs.writeFileSync(testPath, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { guardUnsupportedTransitEntities } from '../src/worker-v44.js';\n\ntest('search director overlaps with deterministic seed retrieval', () => {\n  const source = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');\n  assert.match(source, /const planPromise = directorPlan/);\n  assert.match(source, /seedSearchPromise/);\n  assert.match(source, /Promise\\.all\\(\\[\\s*planPromise,\\s*seedSearchPromise,/);\n  assert.match(source, /directorParallelSeedSearch: true/);\n});\n\ntest('grounded synthesis excludes assistant prose from factual context', () => {\n  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');\n  assert.match(source, /const hist = userHistory\\(body\\?\\.history\\)\\.slice\\(-8\\)/);\n  assert.match(source, /groundedHistoryUserOnly: true/);\n});\n\ntest('transit guard removes sentences containing unsupported rail entities', () => {\n  const search = { results: [{ title: 'JR九州 日豊本線 大分 行橋', excerpt: '大分と行橋は日豊本線の駅です。' }] };\n  const bad = guardUnsupportedTransitEntities('小倉で鹿児島本線に乗り換えます。', '大分から行橋まで電車で行きたい', search);\n  assert.doesNotMatch(bad, /小倉|鹿児島本線/);\n  const good = guardUnsupportedTransitEntities('日豊本線を利用します。', '大分から行橋まで電車で行きたい', search);\n  assert.match(good, /日豊本線/);\n});\n`);

console.log('Applied parallel Search Director seed retrieval, grounded-history quarantine, and transit evidence guard.');
