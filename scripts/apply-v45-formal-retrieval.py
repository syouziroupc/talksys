from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    return text.replace(old, new, 1)

# ---- search-v45.js -------------------------------------------------------
p = Path('src/search-v45.js')
s = p.read_text()
s = replace_once(s, """import {
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchBingRss,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';
import { fetchDirectPrimarySources } from './direct-primary-v45.js';
""", """import {
  dedupeSearchResults,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';
import { fetchDirectPrimarySources } from './direct-primary-v45.js';
import { searchFormalShoppingApis, SHOPPING_API_REVISION } from './free-shopping-api-v45.js';
""", 'search imports')
s = replace_once(s,
"export const SEARCH_V44_REVISION = 'deep-search-v45-single-provider-staged-evidence';",
"export const SEARCH_V44_REVISION = 'deep-search-v45-formal-api-primary-only';", 'search revision')
s = replace_once(s,
"export const SEARCH_V45_PROVIDER = 'bing-rss-keyless-single-index';",
"export const SEARCH_V45_PROVIDER = 'formal-structured-apis+direct-primary';\nexport const SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED = false;", 'search provider')

old = """export function needsSearchDirector(text) {
  const value = clean(text, 1800);
  if (!value) return false;
  const genericShopping = SHOPPING_RE.test(value) && /(おすすめ|選ん|選ぶ|どれ|何がいい|候補|比較)/.test(value) && !MODEL_RE.test(value);
  const multiConstraint = (value.match(/(?:以下|以上|以内|用途|予算|かつ|なおかつ|ただし|除外|比較|条件)/g) || []).length >= 2;
  const multiEntityComparison = /比較|どっち/.test(value) && (value.match(/[A-Za-z]{2,}[A-Za-z0-9-]*\\d+[A-Za-z0-9-]*/g) || []).length >= 2;
  return genericShopping || multiConstraint || multiEntityComparison;
}"""
new = """export function needsSearchDirector(text) {
  const value = clean(text, 1800);
  if (!value) return false;
  const genericShopping = SHOPPING_RE.test(value) && /(おすすめ|選ん|選ぶ|どれ|何がいい|候補|比較)/.test(value) && !MODEL_RE.test(value);
  // Routine shopping is already typed deterministically and should not spend
  // 2.2 s on a planner before hitting a structured commerce API.
  if (genericShopping) return false;
  const multiConstraint = (value.match(/(?:以下|以上|以内|用途|予算|かつ|なおかつ|ただし|除外|比較|条件)/g) || []).length >= 2;
  const multiEntityComparison = /比較|どっち/.test(value) && (value.match(/[A-Za-z]{2,}[A-Za-z0-9-]*\\d+[A-Za-z0-9-]*/g) || []).length >= 2;
  return multiConstraint || multiEntityComparison;
}"""
s = replace_once(s, old, new, 'director routing')

old = """      queries.push(`${budget ? `${budget} ` : ''}中古 ノートパソコン 型番`);
      queries.push(`${budget ? `${budget} ` : ''}中古 ノートパソコン 販売`);"""
new = """      queries.push(`${budget ? `${budget} ` : ''}中古 ノートパソコン`);"""
s = replace_once(s, old, new, 'shopping query compaction')

start = s.index('async function searchOne(facet, deadline) {')
end = s.index('\nfunction extractCandidates(', start)
replacement = """async function searchOne(facet, deadline) {
  // General web search is deliberately disabled: the previously used Bing RSS
  // endpoint returned unrelated results even with site: restrictions. Current
  // facts now come from formal APIs or deterministic primary-source resolvers.
  return {
    results: [],
    diag: {
      engine: 'general-web-search-disabled',
      query: facet.primaryQuery,
      stage: facet.stage,
      sourceRole: facet.sourceRole,
      ok: false,
      rawCount: 0,
      count: 0,
      error: 'general_web_search_disabled_quality_terms',
      elapsedMs: 0,
    },
  };
}
"""
s = s[:start] + replacement + s[end:]

old = """  const [first, directPrimary] = await Promise.all([
    Promise.all(firstFacets.map(f => searchOne(f, deadline))),
    fetchDirectPrimarySources(plan.resolvedQuestion, deadline),
  ]);
  diagnostics.push(...first.map(x => x.diag));
  let merged = [...(directPrimary.results || []), ...first.flatMap(x => x.results)];
  let candidates = plan.candidateType === 'product_model' ? extractCandidates(merged,4) : [];
"""
new = """  const firstPromise = SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED
    ? Promise.all(firstFacets.map(f => searchOne(f, deadline)))
    : Promise.resolve([]);
  const shoppingPromise = plan.intent === 'shopping'
    ? searchFormalShoppingApis(plan.resolvedQuestion, options.env || {}, deadline)
    : Promise.resolve({ revision: SHOPPING_API_REVISION, results: [], diagnostics: [], configuredCount: 0, successfulCount: 0 });
  const [first, directPrimary, shopping] = await Promise.all([
    firstPromise,
    fetchDirectPrimarySources(plan.resolvedQuestion, deadline),
    shoppingPromise,
  ]);
  diagnostics.push(...first.map(x => x.diag), ...(shopping.diagnostics || []));
  let merged = [...(directPrimary.results || []), ...(shopping.results || []), ...first.flatMap(x => x.results)];
  let candidates = plan.candidateType === 'product_model' ? extractCandidates(merged,4) : [];
"""
s = replace_once(s, old, new, 'first round')
s = replace_once(s,
"if (plan.researchMode === 'discover_then_verify' && candidates.length && deadline - Date.now() > 1000) {",
"if (SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED && plan.researchMode === 'discover_then_verify' && candidates.length && deadline - Date.now() > 1000) {", 'second round guard')

s = replace_once(s,
"""    singleSearchProvider: true,
    searchProvider: SEARCH_V45_PROVIDER,
    searchEngineRotation: false,""",
"""    singleSearchProvider: false,
    searchProvider: SEARCH_V45_PROVIDER,
    generalWebSearchEnabled: SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED,
    generalWebScraping: false,
    bingRssEnabled: false,
    shoppingApiRevision: shopping.revision || SHOPPING_API_REVISION,
    shoppingApiConfiguredCount: shopping.configuredCount || 0,
    shoppingApiSuccessfulCount: shopping.successfulCount || 0,
    shoppingApiDiagnostics: shopping.diagnostics || [],
    searchEngineRotation: false,""", 'search diagnostics metadata')
p.write_text(s)

# ---- direct-primary-v45.js ----------------------------------------------
p = Path('src/direct-primary-v45.js')
s = p.read_text()
s = replace_once(s,
"const UA = 'TalkSys/45 (+https://talksys.syouziroupc.workers.dev)';",
"const UA = 'Mozilla/5.0 TalkSys/45 (+https://talksys.syouziroupc.workers.dev)';", 'primary source user-agent')
p.write_text(s)

# ---- worker-v44.js -------------------------------------------------------
p = Path('src/worker-v44.js')
s = p.read_text()
s = replace_once(s,
"  SEARCH_V45_PROVIDER,\n} from './search-v45.js';",
"  SEARCH_V45_PROVIDER,\n  SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED,\n} from './search-v45.js';", 'worker search imports')
s = replace_once(s,
"} from './free-api-knowledge-v45.js';\n\nconst REVISION = 'talksys-v45-api-first-single-search-provider';",
"} from './free-api-knowledge-v45.js';\nimport { publicShoppingApiRegistry, SHOPPING_API_REVISION } from './free-shopping-api-v45.js';\n\nconst REVISION = 'talksys-v45-formal-api-primary-safe-fallback';", 'worker shopping import')
s = replace_once(s,
"search = await runDeepSearchV44(env.AI, text, history, requestSignal);",
"search = await runDeepSearchV44(env.AI, text, history, requestSignal, { env });", 'pass env to search')

anchor = "function researchFailureTurn(body, error) {"
idx = s.index(anchor)
fallback = r'''export function deterministicStableFallback(question, search = {}) {
  const q = canonicalizeInput(question, 1800);
  const partial = Array.isArray(search?.results) && search.results.length > 0;
  if (/(?:中古|新品).*(?:ノート|パソコン|PC)|(?:ノート|パソコン|PC).*(?:中古|新品)/i.test(q)) {
    const video = /動画|YouTube|視聴|配信/.test(q);
    const criteria = video
      ? '動画視聴用なら、メモリ8GB以上、SSD、フルHD級の画面を優先し、バッテリー状態、ACアダプター、映像出力端子、保証の有無も確認してください。'
      : '中古PCなら、用途に必要なCPU性能、メモリ8GB以上、SSD、バッテリー状態、ACアダプター、保証の有無を確認してください。';
    return `${partial ? '取得できた外部根拠だけでは現行候補を確定できませんでした。' : '今回の取得では現行の価格・在庫を確認できませんでした。'}${criteria}現在の販売候補は十分な根拠がないため断定しません。`;
  }
  if (/(BIOS|UEFI|ファームウェア)/i.test(q)) {
    return `${partial ? 'メーカー一次情報の一部は取得できましたが、' : '今回の取得では'}最新BIOS/UEFIのバージョンを確認できませんでした。型番一致のメーカー公式サポートを優先し、現在のBIOSバージョンと更新対象を照合してから適用してください。未確認の最新版番号は推測しません。`;
  }
  return `${partial ? '取得できた外部根拠だけでは質問全体の現在情報を確定できませんでした。' : '今回の外部取得では現在情報を確認できませんでした。'}確認できない現在値は推測しません。`;
}

'''
s = s[:idx] + fallback + s[idx:]

s = replace_once(s,
"""  return '外部情報を取得できなかったため、現在情報は断定しません。';
}""",
"""  return deterministicStableFallback(question, search);
}""", 'mechanical final fallback')

old = """function researchFailureTurn(body, error) {
  const text = canonicalizeInput(body?.text, 1800);
  return {
    ok: true,
    answer: '外部情報を取得できなかったため、現在情報は断定しません。',"""
new = """function researchFailureTurn(body, error) {
  const text = canonicalizeInput(body?.text, 1800);
  return {
    ok: true,
    answer: deterministicStableFallback(text),"""
s = replace_once(s, old, new, 'research failure fallback')

s = replace_once(s,
"answer = { text: '外部の現在情報は確認できませんでした。一般論として回答できる部分も生成できなかったため、推測はしません。', ms: 0 };",
"answer = { text: deterministicStableFallback(text, search), ms: 0 };", 'stable model-timeout fallback')

old = """        webSearch: true,
        webSearchPolicy: 'intent-routed-api-first-v45',
        searchRevision: SEARCH_V44_REVISION,"""
new = """        webSearch: false,
        webRetrieval: true,
        webSearchPolicy: 'formal-api-and-direct-primary-v45',
        webSearchEngine: 'none-general; formal-api+direct-primary',
        generalWebSearchProvider: 'none',
        generalWebSearchDisabledReason: 'previous RSS provider failed relevance and site-restriction diagnostics',
        generalWebScraping: false,
        bingRssEnabled: false,
        searchRevision: SEARCH_V44_REVISION,"""
s = replace_once(s, old, new, 'health web metadata')

s = replace_once(s,
"""        freeApiRegistry: { ...publicApiRegistry(), ...publicKnowledgeApiRegistry() },
        searchDirectorModel: SEARCH_DIRECTOR_MODEL,""",
"""        freeApiRegistry: { ...publicApiRegistry(), ...publicKnowledgeApiRegistry(), ...publicShoppingApiRegistry() },
        shoppingApiRevision: SHOPPING_API_REVISION,
        shoppingApiRegistry: publicShoppingApiRegistry(),
        shoppingApiFirst: true,
        searchDirectorModel: SEARCH_DIRECTOR_MODEL,
        searchQueryPlanner: SEARCH_DIRECTOR_MODEL,
        searchFillerModel: 'none',""", 'health api registry')

s = replace_once(s,
"""        searchProvider: SEARCH_V45_PROVIDER,
        searchSingleProvider: true,""",
"""        searchProvider: SEARCH_V45_PROVIDER,
        searchSingleProvider: false,
        searchGeneralWebEnabled: SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED,""", 'health provider flags')
p.write_text(s)

# ---- tests ---------------------------------------------------------------
Path('tests/v45-formal-retrieval.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { needsSearchDirector, SEARCH_V45_PROVIDER, SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED } from '../src/search-v45.js';
import { parseShoppingBudget, shoppingKeyword, publicShoppingApiRegistry, searchFormalShoppingApis } from '../src/free-shopping-api-v45.js';
import { __test as primaryTest } from '../src/direct-primary-v45.js';
import { deterministicStableFallback } from '../src/worker-v44.js';

test('general RSS/web scraping provider is disabled', () => {
  assert.equal(SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, false);
  assert.equal(SEARCH_V45_PROVIDER, 'formal-structured-apis+direct-primary');
  const source = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /searchBingRss\(/);
});

test('routine generic shopping skips Qwen director', () => {
  assert.equal(needsSearchDirector('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで'), false);
});

test('shopping parser separates budget and short keyword', () => {
  assert.equal(parseShoppingBudget('3万円以下で動画視聴用の中古ノートPC'), 30000);
  assert.equal(parseShoppingBudget('29,800円以内の中古PC'), 29800);
  const q = shoppingKeyword('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで');
  assert.ok(q.includes('中古'));
  assert.ok(q.includes('ノートパソコン'));
  assert.ok(!q.includes('3万円'));
});

test('formal shopping adapters require explicit operator opt-in', async () => {
  const out = await searchFormalShoppingApis('3万円以下 中古ノートPC', {}, Date.now() + 2000);
  assert.equal(out.results.length, 0);
  assert.ok(out.diagnostics.every(x => x.error === 'operator_opt_in_required'));
});

test('shopping registry documents credentials and terms gates', () => {
  const reg = publicShoppingApiRegistry();
  assert.equal(reg.yahoo_jp_shopping.requiresKey, true);
  assert.equal(reg.rakuten_ichiba.requiresKey, true);
  assert.match(reg.yahoo_jp_shopping.activation, /attribution/i);
  assert.match(reg.rakuten_ichiba.endpoint, /20260701/);
});

test('direct primary user agent remains identifiable but browser compatible', () => {
  const source = fs.readFileSync(new URL('../src/direct-primary-v45.js', import.meta.url), 'utf8');
  assert.match(source, /Mozilla\/5\.0 TalkSys\/45/);
  assert.equal(primaryTest.evidenceKind('BIOS Version 2.8 2014-01-01').hasVersionLike, true);
});

test('model timeout fallback is useful without inventing live listings', () => {
  const text = deterministicStableFallback('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで');
  assert.match(text, /メモリ8GB/);
  assert.match(text, /SSD/);
  assert.match(text, /価格・在庫/);
  assert.doesNotMatch(text, /ThinkPad|Let.?s note|Latitude/);
});

test('firmware fallback never invents current version', () => {
  const text = deterministicStableFallback('MSI X79A-GD45の最新BIOSを公式で確認して');
  assert.match(text, /最新BIOS\/UEFI/);
  assert.match(text, /推測しません/);
});

test('worker health overrides inherited stale search metadata', () => {
  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(source, /webSearchEngine: 'none-general; formal-api\+direct-primary'/);
  assert.match(source, /searchFillerModel: 'none'/);
  assert.match(source, /bingRssEnabled: false/);
  assert.match(source, /shoppingApiRegistry/);
});
''')
