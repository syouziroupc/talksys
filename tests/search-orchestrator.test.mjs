import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_FILLER_MODEL,
  heuristicContextQuery,
  planSearchQueries,
  generateSearchFiller,
  parsePlannerJson,
  sanitizeFiller,
} from '../src/search-orchestrator.js';
import {
  GROUNDING_VOICE_MODEL,
  GROUNDING_FALLBACK_MODEL,
} from '../src/streaming-workers-ai.js';

test('planner JSON parser keeps a resolved question and up to three unique queries', () => {
  const parsed = parsePlannerJson('{"resolved_question":"予算3万円のノートPCの購入先","queries":["3万円 ノートPC 中古 専門店","3万円 ノートPC 通販 比較","3万円 ノートPC 中古 専門店","3万円 ノートPC 公式"]}');
  assert.equal(parsed.resolvedQuestion, '予算3万円のノートPCの購入先');
  assert.equal(parsed.queries.length, 3);
  assert.deepEqual(parsed.queries.slice(0, 2), ['3万円 ノートPC 中古 専門店', '3万円 ノートPC 通販 比較']);
});

test('heuristic context query carries recent user constraints into a short follow-up', () => {
  const history = [
    { role: 'user', content: 'ネット閲覧と動画視聴が中心のノートパソコンが欲しい' },
    { role: 'assistant', content: '予算はどのくらい？' },
    { role: 'user', content: '3万円ぐらい' },
  ];
  const query = heuristicContextQuery('それを今買うならどこがいい？', history);
  assert.match(query, /3万円/);
  assert.match(query, /それを今買うならどこがいい/);
});

test('high model resolves omitted context and preserves budget and use case', async () => {
  const called = [];
  const ai = {
    async run(model, input) {
      called.push(model);
      assert.equal(model, GROUNDING_VOICE_MODEL);
      const prompt = input.messages.map((m) => m.content).join('\n');
      assert.match(prompt, /予算、用途、地域、型番、日時/);
      assert.match(prompt, /3万円ぐらい/);
      return {
        response: JSON.stringify({
          resolved_question: '予算3万円、ネット閲覧と動画視聴向けノートPCの現在の購入先',
          queries: [
            '3万円 ノートPC 中古 PC専門店 2026',
            '3万円 ノートPC 通販 在庫 2026',
            '3万円 ノートPC 中古 比較 保証',
          ],
        }),
      };
    },
  };
  const plan = await planSearchQueries(ai, 'どこで買うのがいいか今調べて', [
    { role: 'user', content: 'ネット閲覧と動画視聴が中心' },
    { role: 'assistant', content: '予算は？' },
    { role: 'user', content: '3万円ぐらい' },
  ]);
  assert.deepEqual(called, [GROUNDING_VOICE_MODEL]);
  assert.equal(plan.planned, true);
  assert.match(plan.resolvedQuestion, /3万円/);
  assert.equal(plan.queries.length, 3);
});

test('planner falls back from primary grounded model to gpt-oss', async () => {
  const called = [];
  const ai = {
    async run(model) {
      called.push(model);
      if (model === GROUNDING_VOICE_MODEL) throw new Error('paid model unavailable');
      assert.equal(model, GROUNDING_FALLBACK_MODEL);
      return { response: '{"resolved_question":"大分 大阪 航空便 現在","queries":["大分空港 大阪 伊丹 時刻表 公式","大分 大阪 航空便 2026"]}' };
    },
  };
  const plan = await planSearchQueries(ai, '大阪は？今調べて', [
    { role: 'user', content: '大分空港から東京便はある？' },
  ]);
  assert.deepEqual(called, [GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL]);
  assert.equal(plan.planned, true);
  assert.match(plan.resolvedQuestion, /大阪/);
});

test('filler model creates a short non-answer utterance', async () => {
  const ai = {
    async run(model, input) {
      assert.equal(model, SEARCH_FILLER_MODEL);
      assert.equal(input.max_tokens, 28);
      return { response: 'うーん、ちょっと確認してみますね。' };
    },
  };
  const filler = await generateSearchFiller(ai, '今いくら？', []);
  assert.equal(filler, 'うーん、ちょっと確認してみますね。');
});

test('filler sanitizer rejects answer-like statements and keeps natural wait speech', () => {
  assert.equal(sanitizeFiller('価格は3万円です。'), '');
  assert.equal(sanitizeFiller('えーと、少し探してみますね。'), 'えーと、少し探してみますね。');
});
