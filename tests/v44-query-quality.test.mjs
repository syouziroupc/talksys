import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileFollowupQueries,
  compileInitialQueries,
  facetPlanQueries,
  normalizeResearchFacets,
  researchFocus,
} from '../src/research-plan-v44.js';

test('research planning is evidence-facet first, not a flat query-count target', () => {
  const facets = normalizeResearchFacets([
    {
      id: 'price',
      question: '候補は現在いくらで買えるか',
      evidence_needed: '実売価格と販売元',
      preferred_sources: ['販売店'],
      primary_query: 'CF-SV8 中古 実売価格',
      backup_queries: ['CF-SV8 在庫 価格'],
      priority: 5,
    },
    {
      id: 'fit',
      question: '用途に必要な性能を満たすか',
      evidence_needed: 'CPU・メモリ・動画再生用途の適合',
      preferred_sources: ['メーカー仕様'],
      primary_query: 'CF-SV8 仕様 i5-8365U 8GB',
      backup_queries: ['CF-SV8 公式 仕様'],
      priority: 5,
    },
    {
      id: 'risk',
      question: '中古購入上の弱点は何か',
      evidence_needed: 'バッテリー・故障・サポート上の注意点',
      preferred_sources: ['メーカーサポート', '独立レビュー'],
      primary_query: 'CF-SV8 中古 注意点 バッテリー',
      backup_queries: ['CF-SV8 不具合 中古'],
      priority: 3,
    },
  ], '3万円以下の中古ノートPCを動画視聴用に選ぶ', 'shopping');

  const plan = { resolvedQuestion: '3万円以下の中古ノートPCを動画視聴用に選ぶ', facets };
  assert.equal(facets.length, 3);
  assert.deepEqual(compileInitialQueries(plan, 6), [
    'CF-SV8 中古 実売価格',
    'CF-SV8 仕様 i5-8365U 8GB',
    'CF-SV8 中古 注意点 バッテリー',
  ]);
  assert.ok(facetPlanQueries(plan, 14).length < 10, 'planner must not invent a 10-query minimum');
});

test('second-wave queries target only evidence gaps instead of blindly running backups', () => {
  const facets = normalizeResearchFacets([
    { id: 'price', question: '価格', evidence_needed: '実売価格', primary_query: 'A 実売価格', backup_queries: ['A 在庫 価格'], priority: 5 },
    { id: 'spec', question: '仕様', evidence_needed: '公式仕様', primary_query: 'A 仕様', backup_queries: ['A 公式 スペック'], priority: 5 },
    { id: 'risk', question: '弱点', evidence_needed: '制約', primary_query: 'A 注意点', backup_queries: ['A 不具合'], priority: 3 },
  ], 'Aを買うべきか', 'shopping');
  const plan = { resolvedQuestion: 'Aを買うべきか', facets };
  const used = compileInitialQueries(plan, 6);
  const followup = compileFollowupQueries(plan, {
    sufficient: false,
    missingFacets: ['spec'],
    queries: ['A メーカー 型番 仕様書'],
  }, used, 6);
  assert.deepEqual(followup, ['A メーカー 型番 仕様書', 'A 公式 スペック']);
  assert.ok(!followup.includes('A 在庫 価格'));
  assert.ok(!followup.includes('A 不具合'));
});

test('research focus explicitly carries what evidence must be found', () => {
  const plan = {
    resolvedQuestion: 'FCR-062は8万kmのTA02に有効か',
    facets: normalizeResearchFacets([
      {
        id: 'compat',
        question: '2スト車に使用可能か',
        evidence_needed: 'メーカーの適合・用量情報',
        primary_query: 'FCR-062 2スト 適合 用量',
        priority: 5,
      },
      {
        id: 'effect',
        question: 'カーボン除去効果の根拠はあるか',
        evidence_needed: '成分と清浄作用の一次情報または技術情報',
        primary_query: 'FCR-062 PEA 清浄作用 技術',
        priority: 4,
      },
    ], 'FCR-062は8万kmのTA02に有効か', 'comparison'),
  };
  const focus = researchFocus(plan);
  assert.match(focus, /2スト車に使用可能/);
  assert.match(focus, /メーカーの適合・用量情報/);
  assert.match(focus, /カーボン除去効果/);
});
