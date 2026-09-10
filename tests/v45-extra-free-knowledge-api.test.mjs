import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRA_KNOWLEDGE_API_REGISTRY,
  detectExtraKnowledgeApiIntents,
  publicExtraKnowledgeApiRegistry,
  runExtraKnowledgeApiIntent,
  __test,
} from '../src/free-api-knowledge-extra-v45.js';

function responseJson(data, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json' } }));
}

test('extra registry is keyless, free, and commercial-use compatible', () => {
  const registry = publicExtraKnowledgeApiRegistry();
  assert.deepEqual(Object.keys(registry).sort(), ['e_stat_dashboard','eurostat','wikidata']);
  assert.ok(Object.values(registry).every((x) => x.free === true));
  assert.ok(Object.values(registry).every((x) => x.keyRequired === false));
  assert.ok(Object.values(registry).every((x) => x.commercialUse === true));
  assert.match(EXTRA_KNOWLEDGE_API_REGISTRY.e_stat_dashboard.attribution, /国によって保証/);
});

test('extra intents are narrow enough to avoid hijacking ordinary macro/current questions', () => {
  assert.deepEqual(detectExtraKnowledgeApiIntents('大分県の人口を統計で確認して'), ['japan_official_stats']);
  assert.deepEqual(detectExtraKnowledgeApiIntents('EUの失業率は？'), ['eu_official_stats']);
  assert.deepEqual(detectExtraKnowledgeApiIntents('富士山の標高は？'), ['stable_entity_fact']);
  assert.deepEqual(detectExtraKnowledgeApiIntents('現在の日本の総理大臣は？'), []);
  assert.deepEqual(detectExtraKnowledgeApiIntents('日本の人口は？'), []);
});

test('e-Stat adapter resolves region, indicator, and latest observation with bounded three-call flow', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('getRegionInfo')) return responseJson({ regions:[{ name:'別府市', regionCode:'44202' }] });
    if (String(url).includes('getIndicatorInfo')) return responseJson({ indicators:[{ name:'総人口', indicatorCode:'0201010000000010000' }] });
    if (String(url).includes('getData')) return responseJson({ GET_STATS:{ STATISTICAL_DATA:{ DATA_INF:{ DATA_OBJ:[
      { VALUE:{ '@indicator':'0201010000000010000', '@region':'44202', '@time':'2024CY00', '@unit':'人', '$':'113000' } },
      { VALUE:{ '@indicator':'0201010000000010000', '@region':'44202', '@time':'2025CY00', '@unit':'人', '$':'111500' } },
    ] } } } });
    return responseJson({}, 404);
  };
  const result = await runExtraKnowledgeApiIntent('japan_official_stats', '別府市の人口を教えて', undefined, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'e_stat_dashboard');
  assert.equal(result.data.regionCode, '44202');
  assert.equal(result.data.latest.time, '2025CY00');
  assert.equal(result.data.latest.value, 111500);
  assert.equal(seen.length, 3);
});

test('Eurostat adapter parses JSON-stat time series and EU aggregate', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /demo_pjan/);
    assert.match(String(url), /geo=EU27_2020/);
    return responseJson({ dimension:{ time:{ category:{ index:{ '2024':0, '2025':1 } } } }, value:{ '0':449000000, '1':450400000 } });
  };
  const result = await runExtraKnowledgeApiIntent('eu_official_stats', 'EUの人口は？', undefined, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'eurostat');
  assert.deepEqual(result.data.latest, { time:'2025', value:450400000 });
});

test('Wikidata adapter returns only the requested stable property and resolves linked labels', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('wbsearchentities')) return responseJson({ search:[{ id:'Q937', label:'アルベルト・アインシュタイン', description:'理論物理学者' }] });
    if (u.includes('wbgetentities') && u.includes('Q937')) return responseJson({ entities:{ Q937:{ labels:{ ja:{ value:'アルベルト・アインシュタイン' } }, descriptions:{ ja:{ value:'理論物理学者' } }, claims:{ P19:[{ mainsnak:{ datavalue:{ value:{ id:'Q64' } } } }] } } } });
    if (u.includes('wbgetentities') && u.includes('Q64')) return responseJson({ entities:{ Q64:{ labels:{ ja:{ value:'ウルム' } } } } });
    return responseJson({}, 404);
  };
  const result = await runExtraKnowledgeApiIntent('stable_entity_fact', 'アルベルト・アインシュタインの出生地は？', undefined, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'wikidata');
  assert.equal(result.data.propertyId, 'P19');
  assert.equal(result.data.values[0].label, 'ウルム');
});

test('helper parsing keeps concrete entity and source-specific request semantics', () => {
  assert.equal(__test.japanRegionName('大分県別府市の人口は？'), '別府市');
  assert.equal(__test.eurostatRequest('ユーロ圏の失業率は？').geo, 'EA20');
  assert.equal(__test.wikidataRequest('富士山の標高は？').subject, '富士山');
});
