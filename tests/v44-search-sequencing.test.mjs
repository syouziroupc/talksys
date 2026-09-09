import test from 'node:test';
import assert from 'node:assert/strict';
import { filterQueryRelevantResults, queryResultEvidence } from '../src/query-result-gate-v44.js';
import {
  buildCandidateVerificationQueries,
  discoveryQueries,
  needsCandidateDiscovery,
  normalizeCandidates,
} from '../src/research-sequence-v44.js';

test('authority-only pages cannot pass a product query relevance gate', () => {
  const query = '3万円以下 中古ノートPC おすすめ 機種';
  const bad = [
    { title: 'Pierce County August Primary Election Results', snippet: 'Official election results for Pierce County.', url: 'https://results.vote.wa.gov/example' },
    { title: 'YouTube - Google Accounts', snippet: 'Sign in to continue to YouTube.', url: 'https://accounts.google.com/InteractiveLogin' },
  ];
  assert.deepEqual(filterQueryRelevantResults(query, bad), []);
  assert.equal(queryResultEvidence(query, bad[0]).relevant, false);
});

test('Japanese compound product terms keep genuinely relevant search results', () => {
  const query = '中古ノートPC 販売店 比較 保証';
  const good = {
    title: '中古パソコン・ノートPCを販売｜PC専門店',
    snippet: '中古ノートパソコンを多数販売。商品状態とサポートを確認できます。',
    url: 'https://example.jp/used-pc',
  };
  const evidence = queryResultEvidence(query, good);
  assert.equal(evidence.relevant, true);
  assert.ok(evidence.matched.includes('中古') || evidence.matched.includes('ノート'));
});

test('generic shopping research discovers candidates before verifying them', () => {
  const plan = {
    resolvedQuestion: '3万円以下の中古ノートPCを動画視聴用に選ぶ',
    intent: 'shopping',
    facets: [
      { id: 'model', question: '条件に合う具体的な機種候補は何か', evidenceNeeded: '実在する型番', primaryQuery: '3万円以下 中古ノートPC おすすめ 機種', priority: 5 },
      { id: 'spec', question: '候補は動画視聴に必要な仕様を満たすか', evidenceNeeded: 'CPU メモリ 解像度', primaryQuery: '中古ノートPC 動画視聴 スペック', priority: 5 },
      { id: 'price', question: '候補はいくらか', evidenceNeeded: '現在価格', primaryQuery: '中古ノートPC 相場', priority: 5 },
    ],
  };
  assert.equal(needsCandidateDiscovery(plan), true);
  assert.deepEqual(discoveryQueries(plan, 2), ['3万円以下 中古ノートPC おすすめ 機種']);
});

test('candidate verification searches are candidate-specific rather than generic repeats', () => {
  const plan = {
    resolvedQuestion: '3万円以下の中古ノートPCを動画視聴用に選ぶ',
    intent: 'shopping',
    facets: [
      { id: 'model', question: '具体的な機種候補', evidenceNeeded: '実在型番', primaryQuery: '3万円以下 中古ノートPC おすすめ 機種', priority: 5 },
      { id: 'spec', question: '動画視聴に必要な仕様', evidenceNeeded: 'CPU メモリ 解像度', primaryQuery: '中古ノートPC 動画視聴 スペック', priority: 5 },
      { id: 'price', question: '現在価格', evidenceNeeded: '実売価格', primaryQuery: '中古ノートPC 実売価格', priority: 5 },
    ],
  };
  const queries = buildCandidateVerificationQueries(plan, [{ name: 'ThinkPad X280' }, { name: 'CF-SV8' }], 6);
  assert.ok(queries.some((q) => q.startsWith('ThinkPad X280 ')));
  assert.ok(queries.some((q) => q.startsWith('CF-SV8 ')));
  assert.ok(queries.every((q) => /ThinkPad X280|CF-SV8/.test(q)));
});

test('candidate extraction can only keep names literally present in evidence', () => {
  const evidence = '[1] Lenovo ThinkPad X280 中古\nThinkPad X280 の販売情報です。';
  const candidates = normalizeCandidates([
    { name: 'ThinkPad X280', evidence: 'title' },
    { name: 'CF-SV8', evidence: 'model memory only' },
  ], evidence, 4);
  assert.deepEqual(candidates.map((x) => x.name), ['ThinkPad X280']);
});
