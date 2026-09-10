from pathlib import Path

p = Path('tests/search-v45-architecture.test.mjs')
s = p.read_text()
s = s.replace(
"  SEARCH_V45_PROVIDER,\n  SEARCH_V45_TOTAL_BUDGET_MS,",
"  SEARCH_V45_PROVIDER,\n  SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED,\n  SEARCH_V45_TOTAL_BUDGET_MS,",
1)
s = s.replace(
"""test('v45 uses one bounded keyless search index instead of HTML engine rotation', () => {
  assert.equal(SEARCH_V45_PROVIDER, 'bing-rss-keyless-single-index');
  assert.equal(SEARCH_V44_MAX_ENGINE_RETRIES, 0);
  assert.ok(SEARCH_V44_MAX_QUERIES <= 6);
  assert.ok(SEARCH_V44_MAX_ROUNDS <= 2);
  assert.ok(SEARCH_V45_TOTAL_BUDGET_MS <= 6500);
  assert.ok(SEARCH_V45_DIRECTOR_TIMEOUT_MS <= 2200);
  assert.match(SEARCH_V44_REVISION, /single-provider/);
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(worker, /from '\\.\\/search-v45\\.js'/);
  assert.match(worker, /searchEngineRotation: false/);
  assert.match(worker, /searchSingleProvider: true/);
});

""",
"""test('v45 uses formal APIs and direct primary sources instead of a general RSS search index', () => {
  assert.equal(SEARCH_V45_PROVIDER, 'formal-structured-apis+direct-primary');
  assert.equal(SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, false);
  assert.equal(SEARCH_V44_MAX_ENGINE_RETRIES, 0);
  assert.ok(SEARCH_V44_MAX_QUERIES <= 6);
  assert.ok(SEARCH_V44_MAX_ROUNDS <= 2);
  assert.ok(SEARCH_V45_TOTAL_BUDGET_MS <= 6500);
  assert.ok(SEARCH_V45_DIRECTOR_TIMEOUT_MS <= 2200);
  assert.match(SEARCH_V44_REVISION, /formal-api-primary-only/);
  const search = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.doesNotMatch(search, /searchBingRss\\(/);
  assert.match(worker, /searchEngineRotation: false/);
  assert.match(worker, /searchSingleProvider: false/);
  assert.match(worker, /bingRssEnabled: false/);
});

""",1)
s = s.replace(
"""test('Qwen director is reserved for complex research, not simple official lookup', () => {
  assert.equal(needsSearchDirector('MSI X79A-GD45の最新BIOSを公式で確認して'), false);
  assert.equal(needsSearchDirector('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで'), true);
});""",
"""test('Qwen director is reserved for genuinely complex research, not routine lookup or shopping', () => {
  assert.equal(needsSearchDirector('MSI X79A-GD45の最新BIOSを公式で確認して'), false);
  assert.equal(needsSearchDirector('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで'), false);
  assert.equal(needsSearchDirector('ABC123とXYZ456を性能条件と保証条件で比較'), true);
});""",1)
p.write_text(s)

p = Path('tests/search-v45-production-findings.test.mjs')
s = p.read_text()
s = s.replace(
"  assert.ok(p.queries.some(q => /3万円以下.*中古.*ノートパソコン.*型番/.test(q)));",
"  assert.deepEqual(p.queries, ['3万円以下 中古 ノートパソコン']);",
1)
p.write_text(s)
