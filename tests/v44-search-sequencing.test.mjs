import test from 'node:test';
import assert from 'node:assert/strict';
import { filterQueryRelevantResults, queryResultEvidence } from '../src/query-result-gate-v44.js';
import {
  buildCandidateVerificationQueries,
  candidateTypeForPlan,
  discoveryQueries,
  needsCandidateDiscovery,
  normalizeCandidates,
  researchModeForPlan,
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

test('generic product shopping uses discover-then-verify and product-model candidates', () => {
  const plan = {
    resolvedQuestion: '3万円以下の中古ノートPCを動画視聴用に選ぶ',
    intent: 'shopping',
    facets: [
      { id: 'model', stage: 'discovery', question: '条件に合う具体的な機種候補は何か', evidenceNeeded: '実在する型番', primaryQuery: '3万円以下 中古ノートPC おすすめ 機種', priority: 5 },
      { id: 'spec', stage: 'verification', question: '候補は動画視聴に必要な仕様を満たすか', evidenceNeeded: 'CPU メモリ 解像度', sourceRole: 'official_spec', primaryQuery: '中古ノートPC 動画視聴 スペック', priority: 5 },
      { id: 'price', stage: 'verification', question: '候補はいくらか', evidenceNeeded: '現在価格', sourceRole: 'seller', primaryQuery: '中古ノートPC 相場', priority: 5 },
    ],
  };
  assert.equal(researchModeForPlan(plan), 'discover_then_verify');
  assert.equal(candidateTypeForPlan(plan), 'product_model');
  assert.equal(needsCandidateDiscovery(plan), true);
  assert.deepEqual(discoveryQueries(plan, 2), ['3万円以下 中古ノートPC おすすめ 機種']);
});

test('where-to-buy shopping switches candidate type to store', () => {
  const plan = { resolvedQuestion: '別府で中古ノートPCをどこで買えばいい？', intent: 'shopping', facets: [] };
  assert.equal(researchModeForPlan(plan), 'local_discovery');
  assert.equal(candidateTypeForPlan(plan), 'store');
});

test('candidate verification searches are entity-specific and source-role aware', () => {
  const plan = {
    resolvedQuestion: '3万円以下の中古ノートPCを動画視聴用に選ぶ',
    intent: 'shopping',
    facets: [
      { id: 'model', stage: 'discovery', question: '具体的な機種候補', evidenceNeeded: '実在型番', primaryQuery: '3万円以下 中古ノートPC おすすめ 機種', priority: 5 },
      { id: 'spec', stage: 'verification', question: '動画視聴に必要な仕様', evidenceNeeded: 'CPU メモリ 解像度', sourceRole: 'official_spec', primaryQuery: '中古ノートPC 動画視聴 スペック', priority: 5 },
      { id: 'price', stage: 'verification', question: '現在価格', evidenceNeeded: '実売価格', sourceRole: 'seller', primaryQuery: '中古ノートPC 実売価格', priority: 5 },
    ],
  };
  const queries = buildCandidateVerificationQueries(plan, [{ name: 'ThinkPad X280' }, { name: 'CF-SV8' }], 6);
  assert.ok(queries.some((q) => /^ThinkPad X280 .*メーカー 公式 仕様/.test(q)));
  assert.ok(queries.some((q) => /^ThinkPad X280 .*販売 価格 在庫/.test(q)));
  assert.ok(queries.every((q) => /ThinkPad X280|CF-SV8/.test(q)));
});

test('typed candidate extraction rejects a retailer when product model is required', () => {
  const evidence = '[1] Core i5搭載 Let\'s note SV9 が33,000円、Qualitで販売\nQualitの中古PCセール。Let\'s note SV9を掲載。';
  const candidates = normalizeCandidates([
    { name: 'Qualit', type: 'store', evidence: 'seller' },
    { name: "Let's note SV9", type: 'product_model', evidence: 'title' },
    { name: 'CF-SV8', type: 'product_model', evidence: 'model memory only' },
  ], evidence, 4, 'product_model');
  assert.deepEqual(candidates.map((x) => x.name), ["Let's note SV9"]);
});
