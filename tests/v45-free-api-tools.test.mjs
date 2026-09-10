import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_API_REGISTRY,
  detectApiIntents,
  extractFxRequest,
  extractHolidayRequest,
  extractRoutePlaces,
  publicApiRegistry,
  runFreeApiTools,
  selectJmaOfficeFromArea,
} from '../src/free-api-tools-v45.js';

test('registry contains only explicitly free sources and excludes Open-Meteo free API', () => {
  const registry = publicApiRegistry();
  assert.ok(Object.keys(registry).length >= 8);
  assert.ok(Object.values(registry).every((x) => x.free === true));
  assert.equal('open_meteo' in registry, false);
  assert.equal('open-meteo' in registry, false);
});

test('provider-specific transit APIs stay opt-in until their individual licences are reviewed', () => {
  assert.equal(FREE_API_REGISTRY.odpt.adapterEnabled, false);
  assert.equal(FREE_API_REGISTRY.navitime_market.adapterEnabled, false);
});

test('multiple structured intents are detected for parallel execution', () => {
  const intents = detectApiIntents('別府の今日の天気と、最近の地震も教えて');
  assert.ok(intents.includes('weather'));
  assert.ok(intents.includes('earthquake'));
});

test('FX parser resolves amount and currency pair', () => {
  assert.deepEqual(extractFxRequest('100米ドルは日本円でいくら？'), {
    base: 'USD', quote: 'JPY', amount: 100,
  });
});

test('holiday parser resolves country and year', () => {
  assert.deepEqual(extractHolidayRequest('2026年の日本の祝日は？'), {
    country: 'JP', year: 2026,
  });
});

test('route parser resolves endpoints and travel mode', () => {
  const route = extractRoutePlaces('別府駅から大分駅まで車でのルート');
  assert.equal(route?.from, '別府駅');
  assert.equal(route?.to, '大分駅');
  assert.equal(route?.mode, 'drive');
});

test('JMA area hierarchy resolves city to forecast office', () => {
  const area = {
    offices: { '440000': { name: '大分県', parent: '010000' } },
    class10s: { '440010': { name: '中部', parent: '440000' } },
    class15s: { '442020': { name: '別府市', parent: '440010' } },
    class20s: { '4420200': { name: '別府市', parent: '442020' } },
  };
  const result = selectJmaOfficeFromArea(area, '別府市の今日の天気');
  assert.equal(result?.officeCode, '440000');
  assert.equal(result?.officeName, '大分県');
});

test('unstructured questions transparently fall back to web research', async () => {
  const result = await runFreeApiTools('中古ノートPCのおすすめは？', [], {});
  assert.equal(result.recognized, false);
  assert.equal(result.webSupplementRecommended, true);
  assert.equal(result.sufficient, false);
});

test('keyed route API failure does not block web fallback', async () => {
  const result = await runFreeApiTools('別府駅から大分駅まで車でのルート', [], {});
  assert.equal(result.recognized, true);
  assert.ok(result.intents.includes('route'));
  assert.equal(result.sufficient, false);
  assert.equal(result.webSupplementRecommended, true);
  assert.equal(result.results[0]?.reason, 'GEOAPIFY_API_KEY_missing');
});
