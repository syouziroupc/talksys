import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as worker } from '../src/worker-v44.js';
import { engineForIndex, fallbackEngine, SEARCH_PROBE_ENGINES } from '../src/search-probes-v44.js';
import {
  SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
  SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
  SEARCH_V44_MAX_ENGINE_RETRIES,
  SEARCH_V44_MAX_PER_HOST,
  SEARCH_V44_MAX_QUERIES,
  SEARCH_V44_MAX_RECOVERY_QUERIES,
  SEARCH_V44_MAX_ROUNDS,
  SEARCH_V44_MAX_TOTAL_QUERIES,
  SEARCH_V44_PROBE_CONCURRENCY,
  SEARCH_V44_SOURCE_LIMIT,
  __test as search,
} from '../src/search-v44.js';

test('v44 searches substantive turns by default', () => {
  assert.equal(worker.shouldSearchByDefault('中古のジャイロキャノピーで強力な添加剤は何がいい？'), true);
  assert.equal(worker.shouldSearchByDefault('バナナはおやつに入る？'), true);
  assert.equal(worker.shouldSearchByDefault('この修理、買い替えたほうがいいかな'), true);
});

test('v44 keeps zero-value social and memory turns local', () => {
  assert.equal(worker.shouldSearchByDefault('こんにちは'), false);
  assert.equal(worker.shouldSearchByDefault('ありがとう'), false);
  assert.equal(worker.shouldSearchByDefault('今日は疲れた'), false);
  assert.equal(worker.shouldSearchByDefault('さっき何て言った？'), false);
  assert.equal(worker.shouldSearchByDefault('検索できるの？'), false);
});

test('v44 preserves only stronger specialized routes', () => {
  assert.equal(worker.shouldPreserveSpecializedTurn('明日の別府の天気は？', []), true);
  assert.equal(worker.shouldPreserveSpecializedTurn('大分から別府まで次の電車は？', []), true);
  assert.equal(worker.shouldPreserveSpecializedTurn('どこで買えばいい？', [{ role: 'user', content: '安いスマホがほしい' }]), true);
  assert.equal(worker.shouldPreserveSpecializedTurn('どこで買えばいい？', [{ role: 'user', content: '安いノートPCがほしい' }]), false);
  assert.equal(worker.shouldPreserveSpecializedTurn('FCR-062とPEA系添加剤を比較して', []), false);
});

test('v44 exhaustive search keeps broad planning plus recovery', () => {
  assert.equal(SEARCH_V44_MAX_QUERIES, 14);
  assert.equal(SEARCH_V44_MAX_RECOVERY_QUERIES, 5);
  assert.equal(SEARCH_V44_MAX_TOTAL_QUERIES, 19);
  assert.equal(SEARCH_V44_MAX_ROUNDS, 3);
  assert.equal(SEARCH_V44_SOURCE_LIMIT, 18);
  assert.equal(search.shouldForceThirdRound({ intent: 'shopping', resolvedQuestion: 'PCを買う' }), true);
});

test('v44 leaves external-subrequest and connection headroom', () => {
  assert.ok(SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET < 50);
  assert.ok(SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET < 50);
  assert.ok(SEARCH_V44_PROBE_CONCURRENCY <= 4);
  assert.ok(SEARCH_V44_MAX_ENGINE_RETRIES <= 5);
});

test('v44 rotates independent search engines and retries on another engine', () => {
  const firstFive = Array.from({ length: 5 }, (_, i) => engineForIndex(i));
  assert.deepEqual(firstFive, SEARCH_PROBE_ENGINES);
  for (const engine of SEARCH_PROBE_ENGINES) assert.notEqual(fallbackEngine(engine), engine);
});

test('v44 source selection limits host concentration when alternatives exist', () => {
  const input = [
    { url: 'https://a.example/1', title: 'a1' },
    { url: 'https://a.example/2', title: 'a2' },
    { url: 'https://a.example/3', title: 'a3' },
    { url: 'https://b.example/1', title: 'b1' },
    { url: 'https://c.example/1', title: 'c1' },
  ];
  const out = search.diversifyHosts(input, 4, SEARCH_V44_MAX_PER_HOST);
  assert.equal(out.length, 4);
  assert.equal(out.filter((x) => new URL(x.url).hostname === 'a.example').length, 2);
  assert.ok(out.some((x) => new URL(x.url).hostname === 'b.example'));
  assert.ok(out.some((x) => new URL(x.url).hostname === 'c.example'));
});

test('v44 contextual fallback retains prior user constraints', () => {
  const q = worker.fallbackResolvedQuestion('どこがいい？', [
    { role: 'user', content: '別府市内で' },
    { role: 'assistant', content: '候補を探せます' },
    { role: 'user', content: '3万円以下のノートPC' },
  ]);
  assert.match(q, /別府市内/);
  assert.match(q, /3万円以下/);
  assert.match(q, /どこがいい/);
});
