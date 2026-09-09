import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as worker } from '../src/worker-v44.js';
import {
  SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
  SEARCH_V44_MAX_QUERIES,
  SEARCH_V44_MAX_RECOVERY_QUERIES,
  SEARCH_V44_MAX_ROUNDS,
  SEARCH_V44_MAX_TOTAL_QUERIES,
  SEARCH_V44_RSS_CONCURRENCY,
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
  assert.ok(SEARCH_V44_RSS_CONCURRENCY <= 4);
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
