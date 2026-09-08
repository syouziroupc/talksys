import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_FILLER_MODEL,
  SEARCH_FILLER_MIN_DELAY_MS,
  SEARCH_MAX_QUERIES,
  SEARCH_MAX_ROUNDS,
  heuristicContextQuery,
  planSearchQueries,
  generateSearchFiller,
  parsePlannerJson,
  sanitizeFiller,
  shouldDeepSearch,
} from '../src/search-orchestrator.js';
import {
  GROUNDING_VOICE_MODEL,
  GROUNDING_FALLBACK_MODEL,
} from '../src/streaming-workers-ai.js';

test('planner JSON parser keeps structured intent and up to eight unique queries', () => {
  const parsed = parsePlannerJson(JSON.stringify({
    resolved_question: '予算3万円のノートPCの購入先',
    intent: 'shopping',
    location: '別府市',
    must_include: ['3万円', '動画視聴'],
    queries: [
      '3万円 ノートPC 中古 専門店',
      '3万円 ノートPC 通販 比較',
      '3万円 ノートPC 公式',
      '別府市 ノートPC 販売店',
      '別府市 ノートPC 家電量販店',
      '3万円 ノートPC 保証 比較',
      '3万円 ノートPC 在庫',
      '3万円 ノートPC 中古 専門店',
      '3万円 ノートPC 評判',
    ],
  }));
  assert.equal(parsed.resolvedQuestion, '予算3万円のノートPCの購入先');
  assert.equal(parsed.intent, 'shopping');
  assert.equal(parsed.location, '別府市');
  assert.equal(parsed.queries.length, SEARCH_MAX_QUERIES);
  assert.deepEqual(parsed.mustInclude, ['3万円', '動画視聴']);
});

test('heuristic context query carries recent user constraints into a short follow-up', () => {
  const history = [
    { role: 'user', content: 'ネット閲覧と動画視聴が中心のノートパソコンが欲しい' },
    { role: 'assistant', content: '予算はどのくらい？' },
    { role: 'user', content: '3万円ぐらい' },
  ];
  const query = heuristicContextQuery('それを今買うならどこがいい？', history);
  assert.match(query, /3万円/);
  assert.match(query, /ノートパソコン/);
  assert.match(query, /それを今買うならどこがいい/);
});

test('terse contextual purchase follow-up is routed to deep search instead of casual answer', () => {
  const history = [
    { role: 'user', content: '3万円くらいのノートパソコンを探している' },
    { role: 'assistant', content: 'ネット閲覧と動画なら候補はあります。' },
  ];
  assert.equal(shouldDeepSearch('どこで買えばいいかわからなくて', history), true);
  assert.equal(shouldDeepSearch('別府市内ならどこがいい？', history), true);
  assert.equal(shouldDeepSearch('それならどっち？', history), true);
});

test('casual personal chat does not force a web search', () => {
  assert.equal(shouldDeepSearch('今日は疲れた', [{ role: 'user', content: '仕事が忙しい' }]), false);
  assert.equal(shouldDeepSearch('ありがとう', []), false);
});

test('high model resolves omitted context and can return six to eight diverse queries', async () => {
  const called = [];
  const ai = {
    async run(model, input) {
      called.push(model);
      assert.equal(model, GROUNDING_VOICE_MODEL);
      const prompt = input.messages.map((m) => m.content).join('\n');
      assert.match(prompt, /6〜8本/);
      assert.match(prompt, /予算、用途、地域、型番、日時、数量、条件/);
      assert.match(prompt, /3万円ぐらい/);
      return {
        response: JSON.stringify({
          resolved_question: '予算3万円、ネット閲覧と動画視聴向けノートPCの現在の購入先',
          intent: 'shopping',
          location: '',
          must_include: ['3万円', 'ネット閲覧', '動画視聴'],
          queries: [
            '3万円 ノートPC 販売店 2026',
            '3万円 ノートPC 通販 在庫 2026',
            '3万円 ノートPC 中古 比較 保証',
            '3万円 ノートPC メーカー 公式',
            '3万円 ノートPC 家電量販店',
            '3万円 ノートPC 評判 比較',
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
  assert.ok(plan.queries.length >= 6);
  assert.ok(plan.queries.length <= SEARCH_MAX_QUERIES);
});

test('planner falls back from primary grounded model to gpt-oss', async () => {
  const called = [];
  const ai = {
    async run(model) {
      called.push(model);
      if (model === GROUNDING_VOICE_MODEL) throw new Error('paid model unavailable');
      assert.equal(model, GROUNDING_FALLBACK_MODEL);
      return { response: '{"resolved_question":"大分 大阪 航空便 現在","intent":"current_fact","queries":["大分空港 大阪 伊丹 時刻表 公式","大分 大阪 航空便 2026","大分空港 大阪 航空会社 公式","大分 伊丹 運航状況"]}' };
    },
  };
  const plan = await planSearchQueries(ai, '大阪は？今調べて', [
    { role: 'user', content: '大分空港から東京便はある？' },
  ]);
  assert.deepEqual(called, [GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL]);
  assert.equal(plan.planned, true);
  assert.match(plan.resolvedQuestion, /大阪/);
});

test('search uses two-pass research budget and deterministic filler, not a free-writing model', async () => {
  assert.equal(SEARCH_MAX_ROUNDS, 2);
  assert.equal(SEARCH_FILLER_MODEL, 'deterministic-safe-filler');
  const ai = { async run() { throw new Error('filler must not invoke AI'); } };
  const started = Date.now();
  const filler = await generateSearchFiller(ai, '今いくら？', []);
  assert.equal(filler, '詳しく確認します。少し待ってください。');
  assert.ok(Date.now() - started >= SEARCH_FILLER_MIN_DELAY_MS - 50);
});

test('filler sanitizer only accepts safe non-answer phrases', () => {
  assert.equal(sanitizeFiller('価格は3万円です。'), '');
  assert.equal(sanitizeFiller('えーと、ヤマダ電機ならあります。'), '');
  assert.equal(sanitizeFiller('詳しく確認します。少し待ってください。'), '詳しく確認します。少し待ってください。');
});
