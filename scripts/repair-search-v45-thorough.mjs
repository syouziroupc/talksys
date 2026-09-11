import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content); }
function replaceLiteral(content, from, to, label) {
  if (!content.includes(from)) throw new Error(`missing patch target: ${label}`);
  return content.replace(from, to);
}
function replaceRegex(content, pattern, to, label) {
  if (!pattern.test(content)) throw new Error(`missing regex patch target: ${label}`);
  return content.replace(pattern, to);
}

// ---- search-v45.js ----
{
  const path = 'src/search-v45.js';
  let s = read(path);

  s = replaceLiteral(
    s,
    "import { searchFormalShoppingApis, SHOPPING_API_REVISION } from './free-shopping-api-v45.js';\n",
    "import { searchFormalShoppingApis, SHOPPING_API_REVISION } from './free-shopping-api-v45.js';\nimport { searchProbe } from './search-probes-v44.js';\n",
    'search probe import',
  );

  s = replaceRegex(
    s,
    /export const SEARCH_V44_REVISION = 'deep-search-v45-formal-api-primary-only';[\s\S]*?export const SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED = false;/,
    [
      "export const SEARCH_V44_REVISION = 'deep-search-v45-api-primary-multi-engine-web';",
      'export const SEARCH_V44_MAX_QUERIES = 8;',
      'export const SEARCH_V44_MAX_RECOVERY_QUERIES = 3;',
      'export const SEARCH_V44_MAX_TOTAL_QUERIES = 11;',
      'export const SEARCH_V44_MAX_ROUNDS = 3;',
      'export const SEARCH_V44_SOURCE_LIMIT = 12;',
      'export const SEARCH_V44_PROBE_CONCURRENCY = 3;',
      'export const SEARCH_V44_MAX_ENGINE_RETRIES = 2;',
      'export const SEARCH_V44_MAX_PER_HOST = 2;',
      'export const SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET = 16;',
      'export const SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET = 24;',
      'export const SEARCH_V45_TOTAL_BUDGET_MS = 12000;',
      'export const SEARCH_V45_QUERY_TIMEOUT_MS = 3200;',
      'export const SEARCH_V45_DIRECTOR_TIMEOUT_MS = 2200;',
      "export const SEARCH_V45_PROVIDER = 'formal-structured-apis+direct-primary+rotating-web';",
      'export const SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED = true;',
    ].join('\n'),
    'search constants',
  );

  s = replaceRegex(
    s,
    /  if \(intent === 'shopping' && !known\) \{[\s\S]*?  \} else if \(intent === 'local'\) \{/,
    [
      "  if (intent === 'shopping') {",
      '    if (known) {',
      "      researchMode = 'direct_fact'; candidateType = 'none';",
      '      queries.push(`${known} 中古 価格 在庫`);',
      '    } else {',
      "      researchMode = 'discover_then_verify'; candidateType = 'product_model';",
      '      if (/ノート|パソコン|PC/i.test(resolved)) {',
      "        queries.push(`${budget ? `${budget} ` : ''}中古 ノートパソコン`);",
      '      } else {',
      '        queries.push(compactSubject(resolved));',
      '      }',
      '    }',
      "  } else if (intent === 'local') {",
    ].join('\n'),
    'shopping planning',
  );

  s = replaceRegex(
    s,
    /    facets: queries\.slice\(0, 2\)\.map\(\(q, i\) => \(\{ id: `f\$\{i\+1\}`, stage: researchMode === 'discover_then_verify' \? 'discovery' : 'verification', sourceRole: domain \? 'official_support' : \(intent === 'shopping' \? 'seller' : 'primary'\), primaryQuery: q \}\)\),/,
    [
      '    facets: queries.slice(0, 2).map((q, i) => ({',
      '      id: `f${i+1}`,',
      "      stage: researchMode === 'discover_then_verify' ? 'discovery' : 'verification',",
      "      sourceRole: intent === 'shopping' ? 'seller' : intent === 'news' ? 'news' : intent === 'local' ? 'map' : (domain ? 'official_support' : 'primary'),",
      '      primaryQuery: q,',
      '    })),',
    ].join('\n'),
    'facet source roles',
  );

  s = replaceLiteral(
    s,
    "    for (const p of piece.match(/[a-z]+[-]?[a-z0-9-]*\\d+[a-z0-9-]*|[\\p{Script=Han}]{2,}|[\\p{Script=Katakana}ー]{3,}/giu) || []) {",
    "    for (const p of piece.match(/[a-z][a-z0-9._+-]{1,}|[\\p{Script=Han}]{2,}|[\\p{Script=Katakana}ー]{3,}/giu) || []) {",
    'latin query tokenization',
  );

  s = replaceRegex(
    s,
    /  if \(stage === 'discovery'\) \{[\s\S]*?  if \(\['official_spec','official_support'\]\.includes\(sourceRole\) && expectedHost\) relevant = relevant && Boolean\(siteMatch\);/,
    [
      "  if (stage === 'discovery') {",
      '    // Discovery optimizes recall: one concrete model or one meaningful category hit is enough.',
      '    relevant = Boolean(model) || matched.length >= 1 || siteMatch;',
      "  } else if (sourceRole === 'news') {",
      '    // News snippets are short; one strong entity/topic hit is enough before freshness is checked by synthesis.',
      '    relevant = matched.length >= 1 || Boolean(model) || siteMatch;',
      "  } else if (['seller','marketplace','map'].includes(sourceRole)) {",
      '    relevant = Boolean(model) || matched.length >= 1 || siteMatch;',
      '  } else {',
      '    // Verification optimizes precision: exact model/site, or two independent query concepts.',
      '    relevant = Boolean(siteMatch) || Boolean(model && terms.some(t => normalize(model).includes(t) || hay.includes(t))) || matched.length >= 2;',
      '  }',
      "  if (['official_spec','official_support'].includes(sourceRole) && expectedHost) relevant = relevant && Boolean(siteMatch);",
    ].join('\n'),
    'stage evidence roles',
  );

  s = replaceLiteral(
    s,
    '    .map(x => ({ ...x.item, probeEngine: SEARCH_V45_PROVIDER, probeQuery: query, queryGateScore: x.gate.score, queryGateMatched: x.gate.matched }));',
    '    .map(x => ({ ...x.item, probeEngine: x.item?.probeEngine || x.item?.engine || SEARCH_V45_PROVIDER, probeQuery: query, queryGateScore: x.gate.score, queryGateMatched: x.gate.matched }));',
    'preserve probe engine',
  );

  s = replaceRegex(
    s,
    /async function searchOne\(facet, deadline\) \{[\s\S]*?\n\}\n\nfunction extractCandidates/,
    [
      'function enginesForFacet(facet) {',
      '  const q = clean(facet?.primaryQuery, 300);',
      '  const role = clean(facet?.sourceRole, 60);',
      "  if (role === 'news' || /ニュース|速報|発表|今日|最新/.test(q)) return ['google-news', 'duckduckgo', 'bing-html'];",
      "  if (['official_spec','official_support','primary'].includes(role) || /site:/.test(q)) return ['duckduckgo', 'bing-html', 'bing-rss'];",
      "  if (['seller','marketplace'].includes(role)) return ['bing-html', 'duckduckgo', 'bing-rss'];",
      "  if (role === 'map') return ['duckduckgo', 'bing-html', 'bing-rss'];",
      "  return ['duckduckgo', 'bing-html', 'bing-rss'];",
      '}',
      '',
      'async function searchOne(facet, deadline) {',
      '  const startedAt = Date.now();',
      '  const query = clean(facet?.primaryQuery, 300);',
      '  const attempts = [];',
      '  let collected = [];',
      '  const engines = enginesForFacet(facet).slice(0, 1 + SEARCH_V44_MAX_ENGINE_RETRIES);',
      '',
      '  for (const engine of engines) {',
      '    const remaining = deadline - Date.now();',
      '    if (remaining < 650) break;',
      '    const timeoutMs = Math.max(550, Math.min(SEARCH_V45_QUERY_TIMEOUT_MS, remaining - 120));',
      '    const probe = await searchProbe(engine, query, { timeoutMs, limit: 10 });',
      '    const gated = filterStage(query, probe.results || [], facet.stage, facet.sourceRole, 10);',
      '    attempts.push({',
      '      engine,',
      '      ok: gated.length > 0,',
      '      rawCount: Number(probe.rawCount) || (probe.results || []).length,',
      '      count: gated.length,',
      "      error: gated.length ? '' : (probe.error || 'no_relevant_results'),",
      '      status: Number(probe.status) || 0,',
      '      elapsedMs: Number(probe.elapsedMs) || 0,',
      '    });',
      '    collected.push(...gated);',
      '    collected = dedupeSearchResults(collected, 16);',
      "    const enough = ['official_spec','official_support'].includes(facet.sourceRole)",
      '      ? collected.length >= 1',
      "      : facet.sourceRole === 'news'",
      '        ? collected.length >= 2',
      '        : collected.length >= 3;',
      '    if (enough) break;',
      '  }',
      '',
      '  return {',
      '    results: collected.slice(0, 10),',
      '    diag: {',
      "      engine: attempts.map(x => x.engine).join('+') || 'none',",
      '      query,',
      '      stage: facet.stage,',
      '      sourceRole: facet.sourceRole,',
      '      ok: collected.length > 0,',
      '      rawCount: attempts.reduce((n, x) => n + x.rawCount, 0),',
      '      count: collected.length,',
      "      error: collected.length ? '' : attempts.map(x => `${x.engine}:${x.error}`).join(';'),",
      '      elapsedMs: Date.now() - startedAt,',
      '      attempts,',
      '    },',
      '  };',
      '}',
      '',
      'function extractCandidates',
    ].join('\n'),
    'general web search implementation',
  );

  s = replaceLiteral(
    s,
    '  const maxBudgetMs = Math.max(3500, Math.min(8000, Number(options.totalBudgetMs) || SEARCH_V45_TOTAL_BUDGET_MS));',
    '  const maxBudgetMs = Math.max(4500, Math.min(14000, Number(options.totalBudgetMs) || SEARCH_V45_TOTAL_BUDGET_MS));',
    'search budget clamp',
  );
  s = replaceLiteral(s, '    gapDrivenFollowups: false,', '    gapDrivenFollowups: true,', 'gap followups flag');
  s = replaceLiteral(s, '    generalWebScraping: false,\n    bingRssEnabled: false,', '    generalWebScraping: true,\n    bingRssEnabled: true,', 'web capability flags');
  s = replaceLiteral(s, '    searchEngineRotation: false,', '    searchEngineRotation: true,', 'rotation flag');
  s = replaceLiteral(
    s,
    '    retryCount: 0,\n    crossEngineCount: 0,',
    '    retryCount: diagnostics.reduce((n, d) => n + Math.max(0, (Array.isArray(d.attempts) ? d.attempts.length : 1) - 1), 0),\n    crossEngineCount: new Set(diagnostics.flatMap(d => Array.isArray(d.attempts) ? d.attempts.map(a => a.engine) : [d.engine]).filter(Boolean)).size,',
    'diagnostic retry counts',
  );

  write(path, s);
}

// ---- direct-primary-v45.js ----
{
  const path = 'src/direct-primary-v45.js';
  let s = read(path);
  s = replaceLiteral(s, "  if (!match || !/\\bMSI\\b/i.test(question)) return [];", "  if (!match) return [];", 'implicit MSI model resolver');
  write(path, s);
}

// ---- worker-v44.js ----
{
  const path = 'src/worker-v44.js';
  let s = read(path);
  s = replaceLiteral(s, "const REVISION = 'talksys-v45-formal-api-primary-safe-fallback';", "const REVISION = 'talksys-v45-api-primary-multi-engine-search';", 'worker revision');
  s = replaceLiteral(
    s,
    'const EXPLICIT_LOOKUP_RE = /(検索|調べ|探して|探せ|見つけ|確認して|在庫|実売|価格|値段|相場|いくら|どこで買|販売店|店舗|通販|おすすめ|何がいい|どれがいい|買い替え)/i;',
    'const EXPLICIT_LOOKUP_RE = /(検索|調べ|探して|探せ|見つけ|確認して|在庫|実売|価格|値段|相場|いくら|どこで買|販売店|店舗|通販|おすすめ|何がいい|どれがいい|買い替え|もっと安|安いの|最安|他にある|ほかにある)/i;',
    'followup lookup patterns',
  );

  s = replaceRegex(
    s,
    /  const apiIntents = \[\.\.\.new Set\(\[\.\.\.detectApiIntents\(value, hist\), \.\.\.detectKnowledgeApiIntents\(value, hist\)\]\)\];[\s\S]*?  if \(EXPLICIT_LOOKUP_RE\.test\(value\) \|\| DYNAMIC_FACT_RE\.test\(value\)\) \{\n    return \{ mode: 'external', webSearch: true, noExternal: false, apiIntents: \[\], reason: 'current_or_explicit_lookup' \};\n  \}/,
    [
      '  const apiIntents = [...new Set([...detectApiIntents(value, hist), ...detectKnowledgeApiIntents(value, hist)])];',
      "  if (apiIntents.length) return { mode: 'external', webSearch: false, noExternal: false, apiIntents, reason: 'structured_api_intent' };",
      '  const resolvedContext = fallbackResolvedQuestion(value, hist);',
      '  const contextualLookup = value.length <= 48',
      '    && /(その|それ|これ|この中|その中|候補|もっと|他|ほか|どこ|いくら|安い|高い|在庫|買うなら|どれ)/i.test(value)',
      '    && (EXPLICIT_LOOKUP_RE.test(resolvedContext) || DYNAMIC_FACT_RE.test(resolvedContext));',
      '  if (contextualLookup) {',
      "    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'contextual_external_followup' };",
      '  }',
      '  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value)) {',
      "    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'current_or_explicit_lookup' };",
      '  }',
    ].join('\n'),
    'context-aware routing',
  );

  s = replaceRegex(
    s,
    /        webSearch: false,\n        webRetrieval: true,\n        webSearchPolicy: 'formal-api-and-direct-primary-v45',\n        webSearchEngine: 'none-general; formal-api\+direct-primary',\n        generalWebSearchProvider: 'none',\n        generalWebSearchDisabledReason: 'previous RSS provider failed relevance and site-restriction diagnostics',\n        generalWebScraping: false,\n        bingRssEnabled: false,/,
    [
      '        webSearch: true,',
      '        webRetrieval: true,',
      "        webSearchPolicy: 'api-first-multi-engine-web-v45',",
      "        webSearchEngine: 'duckduckgo+bing-html+bing-rss+google-news; formal-api+direct-primary',",
      "        generalWebSearchProvider: 'rotating-multi-engine-v45',",
      "        generalWebSearchDisabledReason: '',",
      '        generalWebScraping: true,',
      '        bingRssEnabled: true,',
    ].join('\n'),
    'health web fields',
  );
  s = replaceLiteral(s, '        searchGapDrivenFollowups: false,', '        searchGapDrivenFollowups: true,', 'health gap flag');
  s = replaceLiteral(s, '        searchEngineRotation: false,\n        searchEngineRetry: false,', '        searchEngineRotation: true,\n        searchEngineRetry: true,', 'health engine flags');
  s = replaceLiteral(s, '        specializedSearchRoutesPreserved: false,', '        specializedSearchRoutesPreserved: true,', 'health specialized flag');
  write(path, s);
}

// ---- behavioral regression tests ----
write('tests/v45-search-restoration.test.mjs', [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, SEARCH_V44_MAX_ENGINE_RETRIES, SEARCH_V45_PROVIDER, __test as searchTest } from '../src/search-v45.js';",
  "import { resolveDirectPrimaryTargets } from '../src/direct-primary-v45.js';",
  "import { classifyTurn } from '../src/worker-v44.js';",
  '',
  "test('v45 general web search is enabled with rotation and retries', () => {",
  '  assert.equal(SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, true);',
  '  assert.ok(SEARCH_V44_MAX_ENGINE_RETRIES >= 2);',
  '  assert.match(SEARCH_V45_PROVIDER, /rotating-web/);',
  '});',
  '',
  "test('known used-PC price query is routed to seller evidence, not manufacturer support', () => {",
  "  const plan = searchTest.simplePlan('CF-SV8の現在の中古価格を調べて、安い候補を教えて', []);",
  "  assert.equal(plan.intent, 'shopping');",
  "  assert.equal(plan.facets[0].sourceRole, 'seller');",
  '  assert.match(plan.facets[0].primaryQuery, /CF-SV8.*中古.*価格/);',
  '});',
  '',
  "test('news query receives news evidence role and latin entity tokenization', () => {",
  "  const plan = searchTest.simplePlan('OpenAIの今日の最新ニュースを検索して', []);",
  "  assert.equal(plan.intent, 'news');",
  "  assert.equal(plan.facets[0].sourceRole, 'news');",
  "  assert.ok(searchTest.queryTerms('OpenAI 今日 最新ニュース').includes('openai'));",
  '});',
  '',
  "test('X79A model implies MSI primary resolver without requiring user to say MSI', () => {",
  "  const targets = resolveDirectPrimaryTargets('X79A-GD45の最新BIOSを公式情報から確認して');",
  '  assert.ok(targets.some(x => /msi\\.com/i.test(x.url)));',
  '});',
  '',
  "test('short comparative shopping follow-up inherits external lookup need', () => {",
  '  const history = [',
  "    { role: 'user', content: '2万円以下で中古ノートPCを探して' },",
  "    { role: 'assistant', content: '候補を確認します。' },",
  '  ];',
  "  const decision = classifyTurn('その中でもっと安いのある？', history);",
  "  assert.equal(decision.mode, 'external');",
  '  assert.equal(decision.webSearch, true);',
  '});',
  '',
  "test('explicit no-external request still wins', () => {",
  "  const decision = classifyTurn('検索は使わないで、一般論だけ教えて', []);",
  '  assert.equal(decision.webSearch, false);',
  '  assert.equal(decision.noExternal, true);',
  '});',
  '',
].join('\n'));

console.log('Applied thorough TalkSys v45 search repair.');
