import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPORAL_TRANSIT_REVISION,
  __test,
} from '../src/integrated-entry.js';

const {
  buildTalkSysSystemInstruction,
  isImmediateTransitQuestion,
  pastImmediateTransitDepartures,
  runGeminiTurn,
} = __test;

const FIXED = new Date('2026-09-17T23:48:00Z'); // 2026-09-18 08:48 JST

test('v56 restores an explicit no-departed-trains rule in the active Gemini prompt', () => {
  assert.equal(TEMPORAL_TRANSIT_REVISION, 'talksys-v56-transit-time-r1');
  const prompt = buildTalkSysSystemInstruction(FIXED, { immediateTransit: true, forceSearch: true });
  assert.match(prompt, /2026-09-18T08:48:00\+09:00/);
  assert.match(prompt, /発車済みの便を「次」として案内してはいけません/);
  assert.match(prompt, /08:48 より前に発車する便は候補から捨て/);
  assert.match(prompt, /8時55分発/);
  assert.match(prompt, /日付と現在時刻を含め/);
});

test('immediate transit detection targets now/next questions without rewriting explicit future dates', () => {
  assert.equal(isImmediateTransitQuestion('別府駅から大分駅へ、今から乗れる次の電車は？'), true);
  assert.equal(isImmediateTransitQuestion('このあと一番早い電車は何時？'), true);
  assert.equal(isImmediateTransitQuestion('明日の次の電車を教えて'), false);
  assert.equal(isImmediateTransitQuestion('別府駅の時刻表を教えて'), false);
});

test('temporal validator identifies already-departed departures but permits future and midnight rollover', () => {
  assert.equal(pastImmediateTransitDepartures('次は8時30分発です。', FIXED).length, 1);
  assert.equal(pastImmediateTransitDepartures('次は8時55分発です。', FIXED).length, 0);
  const lateNight = new Date('2026-09-18T14:55:00Z'); // 23:55 JST
  assert.equal(pastImmediateTransitDepartures('次は0時05分発です。', lateNight).length, 0);
});

test('past departure triggers a fresh Gemini search and only the corrected future train is returned', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const req = JSON.parse(options.body);
    assert.equal(req.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(req.tools, [{ type: 'google_search' }]);
    assert.match(req.system_instruction, /発車済みの便を「次」として案内してはいけません/);
    assert.match(req.input, /2026-09-18T08:48:00\+09:00/);

    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'interaction-bad-time',
        status: 'completed',
        steps: [
          { type: 'google_search_call', arguments: { queries: ['別府駅 大分駅 2026年9月18日 8時48分 以降 電車'] } },
          { type: 'model_output', content: [{ type: 'text', text: '次は8時30分発です。' }] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (calls === 2) {
      assert.match(req.input, /最終回答前の自己検証/);
      return new Response(JSON.stringify({ error: { message: 'temporary verifier error' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    assert.match(req.input, /前回回答には基準時刻 2026-09-18T08:48:00\+09:00 より前/);
    assert.match(req.input, /Google検索をやり直し/);
    return new Response(JSON.stringify({
      id: 'interaction-fixed-time',
      status: 'completed',
      steps: [
        { type: 'google_search_call', arguments: { queries: ['別府駅 大分駅 2026年9月18日 8時48分 以降 次の電車'] } },
        { type: 'model_output', content: [{ type: 'text', text: '次は8時55分発です。' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runGeminiTurn(
      { text: '別府駅から大分駅へ、今から乗れる次の電車は何時？', history: [] },
      { GEMINI_API_KEY: 'test-key' },
      undefined,
      { now: FIXED },
    );
    assert.equal(calls, 3);
    assert.equal(result.ok, true);
    assert.equal(result.genericVerificationAttempted, true);
    assert.equal(result.genericVerificationSucceeded, false);
    assert.equal(result.verificationFailOpen, true);
    assert.equal(result.temporalTransitGuard, true);
    assert.equal(result.temporalRepairRetried, true);
    assert.equal(result.temporalRepairAttempts, 1);
    assert.equal(result.authoritativeJst, '2026-09-18T08:48:00+09:00');
    assert.doesNotMatch(result.answer, /8時30分/);
    assert.match(result.answer, /8時55分発/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
