import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWLEDGE_API_REGISTRY,
  detectKnowledgeApiIntents,
  extractWorldBankRequest,
  mergeApiBundles,
  publicKnowledgeApiRegistry,
} from '../src/free-api-knowledge-v45.js';

test('knowledge API registry contains only free commercial-use sources', () => {
  const registry = publicKnowledgeApiRegistry();
  assert.ok(registry.crossref);
  assert.ok(registry.world_bank_wdi);
  assert.ok(Object.values(registry).every((x) => x.free === true));
  assert.ok(Object.values(registry).every((x) => x.commercialUse === true));
});

test('scholarly questions use Crossref metadata API', () => {
  assert.deepEqual(detectKnowledgeApiIntents('このDOI 10.1038/example の論文を確認して'), ['scholarly_metadata']);
});

test('country macro questions use World Bank WDI', () => {
  assert.ok(detectKnowledgeApiIntents('日本の一人当たりGDPは？').includes('macro_indicator'));
  assert.deepEqual(extractWorldBankRequest('日本の一人当たりGDPは？'), {
    country: 'JPN', indicator: 'NY.GDP.PCAP.CD', label: 'GDP per capita (current US$)',
  });
  assert.deepEqual(extractWorldBankRequest('韓国の人口は？'), {
    country: 'KOR', indicator: 'SP.POP.TOTL', label: 'Population, total',
  });
});

test('macro intent is not guessed without a country', () => {
  assert.equal(detectKnowledgeApiIntents('人口ってどうやって数えるの？').includes('macro_indicator'), false);
});

test('API bundle merger keeps recognized sources and requires every recognized bundle to be sufficient', () => {
  const merged = mergeApiBundles(
    { revision: 'core', recognized: true, intents: ['weather'], results: [{ ok: true, category: 'weather' }], sufficient: true, webSupplementRecommended: false, elapsedMs: 12 },
    { revision: 'knowledge', recognized: true, intents: ['macro_indicator'], results: [{ ok: true, category: 'macro_indicator' }], sufficient: true, webSupplementRecommended: false, elapsedMs: 20 },
  );
  assert.equal(merged.recognized, true);
  assert.equal(merged.sufficient, true);
  assert.equal(merged.parallelApiExecution, true);
  assert.deepEqual(merged.intents, ['weather', 'macro_indicator']);
  assert.equal(merged.results.length, 2);
});
