import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPLIT_CONTEXT_REVISION,
  __test,
} from '../src/integrated-entry.js';
import { TALK_CLIENT_V45, __test as clientFlags } from '../src/talk-client-v45.js';

const {
  unansweredUserTail,
  resolvedUserQuestion,
  interactionInput,
  buildGenericVerificationInput,
  runGeminiTurn,
} = __test;

const FIXED = new Date('2026-09-18T06:00:00Z');

test('v62 keeps trailing unanswered user fragments as one logical question', () => {
  assert.equal(SPLIT_CONTEXT_REVISION, 'talksys-v62-split-utterance-context-r1');
  const body = {
    previousInteractionId: 'previous-completed-turn',
    history: [
      { role: 'user', content: '前の質問' },
      { role: 'assistant', content: '前の回答' },
      { role: 'user', content: '別府駅から大分駅まで' },
    ],
    text: '次の電車を調べて',
  };
  assert.deepEqual(unansweredUserTail(body), ['別府駅から大分駅まで']);
  assert.equal(resolvedUserQuestion(body), '別府駅から大分駅まで 次の電車を調べて');

  const input = interactionInput(body, { forceSearch: true, now: FIXED });
  assert.match(input, /直前の未回答断片: 別府駅から大分駅まで/);
  assert.match(input, /今回の利用者発言: 次の電車を調べて/);
  assert.match(input, /ひと続きの発話として解釈/);
  assert.match(input, /検索語も断片全体から作って/);
  assert.doesNotMatch(input, /前の質問/);
});

test('completed prior turn is not duplicated when previous interaction is healthy', () => {
  const body = {
    previousInteractionId: 'previous-completed-turn',
    history: [
      { role: 'user', content: '前の質問' },
      { role: 'assistant', content: '前の回答' },
    ],
    text: '次の質問です',
  };
  assert.deepEqual(unansweredUserTail(body), []);
  assert.equal(resolvedUserQuestion(body), '次の質問です');
  const input = interactionInput(body, { forceSearch: false, now: FIXED });
  assert.equal(input, '次の質問です');
});

test('verification question also contains every unanswered split fragment', () => {
  const input = buildGenericVerificationInput(
    {
      history: [
        { role: 'assistant', content: '前の回答' },
        { role: 'user', content: 'QCM1250のアダプターで' },
      ],
      text: 'この型番は使えますか',
    },
    {
      answer: '候補回答です。',
      payload: { steps: [] },
    },
    FIXED,
  );
  assert.match(input, /元の利用者の質問: QCM1250のアダプターで この型番は使えますか/);
});

test('split follow-up preserves the first fragment through primary search and continuation verification', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);

    if (calls === 1) {
      assert.equal(req.previous_interaction_id, 'older-turn');
      assert.match(req.input, /直前の未回答断片: QCM1250のアダプターで/);
      assert.match(req.input, /今回の利用者発言: この型番は使えますか/);
      assert.match(req.input, /ひと続きの発話/);
      return new Response(JSON.stringify({
        id: 'primary',
        status: 'completed',
        steps: [
          { type: 'google_search_call', arguments: { queries: ['QCM1250 アダプター この型番 互換'] } },
          { type: 'model_output', content: [{ type: 'text', text: '一次回答です。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    assert.equal(calls, 2);
    assert.equal(req.previous_interaction_id, 'primary');
    assert.match(req.input, /QCM1250のアダプターで この型番は使えますか/);
    assert.match(req.input, /最終回答前の自己検証/);
    return new Response(JSON.stringify({
      id: 'verified',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['QCM1250 互換 公式'] } },
        { type: 'model_output', content: [{ type: 'text', text: '確認後の回答です。' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runGeminiTurn({
      previousInteractionId: 'older-turn',
      history: [
        { role: 'user', content: '前の話' },
        { role: 'assistant', content: '前の回答' },
        { role: 'user', content: 'QCM1250のアダプターで' },
      ],
      text: 'この型番は使えますか',
    }, { GEMINI_API_KEY: 'test-key' }, undefined, { now: FIXED });

    assert.equal(calls, 2);
    assert.equal(result.genericVerificationSucceeded, true);
    assert.equal(result.search, true);
    assert.match(result.answer, /確認後の回答/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser waits longer before splitting Japanese speech at silence', () => {
  assert.equal(clientFlags.fasterTurnEnd, true);
  assert.match(TALK_CLIENT_V45, /SILENCE_MS=650/);
  assert.doesNotMatch(TALK_CLIENT_V45, /SILENCE_MS=480/);
});
