
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as search } from '../src/search-v44.js';
import { queryResultEvidence } from '../src/query-result-gate-v44.js';

test('Search Director accepts native Workers AI top-level tool calls', async () => {
  const ai = {
    run: async (_model, input) => {
      assert.equal(input.tools?.[0]?.name, 'submit_research_plan');
      return {
        tool_calls: [{
          name: 'submit_research_plan',
          arguments: {
            resolved_question: '3万円以下の中古ノートPCを動画視聴用に選ぶ',
            intent: 'shopping', research_mode: 'discover_then_verify', candidate_type: 'product_model',
            location: '', must_include: ['3万円以下', '中古', '動画視聴'],
            facets: [{
              id: 'candidate', stage: 'discovery', question: '条件内の実在機種は何か',
              evidence_needed: '販売ページ上の具体的な型番', source_role: 'seller',
              preferred_sources: ['中古PC販売店'], primary_query: '中古 ノートパソコン 3万円以下 型番',
              backup_queries: ['中古 ノートパソコン 3万円以下 機種'], priority: 5,
            }],
          },
        }],
      };
    },
  };
  const plan = await search.planDeepSearch(ai, '3万円以下の中古ノートPCを動画視聴用に選ぶなら？', []);
  assert.equal(plan.planned, true);
  assert.equal(plan.plannerTransport, 'tool_call');
  assert.equal(plan.plannerError, '');
  assert.equal(plan.candidateType, 'product_model');
  assert.equal(plan.queries[0], '中古 ノートパソコン 3万円以下 型番');
});

test('tool-call parser accepts OpenAI-style nested calls with string arguments', () => {
  const data = search.readToolArguments({ choices: [{ message: { tool_calls: [{ function: {
    name: 'submit_research_plan', arguments: '{"resolved_question":"x","intent":"general"}'
  }}] }}] });
  assert.equal(data.resolved_question, 'x');
  assert.equal(data.intent, 'general');
});

test('planner failure falls back to compact shopping discovery queries', async () => {
  const ai = { run: async () => { throw new Error('planner offline'); } };
  const question = '3万円以下の中古ノートPCを動画視聴用に選ぶなら何を確認して探すべき？';
  const plan = await search.planDeepSearch(ai, question, []);
  assert.equal(plan.planned, false);
  assert.equal(plan.plannerTransport, 'heuristic');
  assert.match(plan.plannerError, /planner offline/);
  assert.match(plan.queries[0], /中古/);
  assert.match(plan.queries[0], /ノートパソコン/);
  assert.match(plan.queries[0], /3万円以下/);
  assert.match(plan.queries[0], /型番|機種/);
  assert.doesNotMatch(plan.queries[0], /何を確認して探すべき/);
  assert.ok(plan.queries[0].length < question.length);
});

test('query relevance gate normalizes ノートPC and ノートパソコン aliases', () => {
  const evidence = queryResultEvidence('中古 ノートPC 3万円以下 型番', {
    title: '中古ノートパソコン ThinkPad X280 を販売',
    snippet: '中古ノートパソコンを多数掲載しています。', url: 'https://example.jp/x280',
  });
  assert.equal(evidence.relevant, true);
  assert.ok(evidence.matched.includes('ノートパソコン'));
});
