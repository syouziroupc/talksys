import test from 'node:test';
import assert from 'node:assert/strict';
import { gateTurnPayload, TRUTH_GATE_REVISION } from '../src/entry.js';

test('generic web evidence cannot authorize an exact transit sequence', () => {
  const payload = gateTurnPayload({
    answer: '大分からソニックで小倉へ向かいます。小倉で鹿児島本線に乗り換えて行橋へ向かいます。',
    searchUseful: true,
    sources: [
      { title: '大分 行橋 小倉 ソニック 乗換案内', url: 'https://example.test/transit' },
      { title: '日豊本線 鹿児島本線 路線案内', url: 'https://example.test/rail' },
    ],
    apiSources: [],
  }, '大分から行橋まで電車でどう行く？');

  assert.equal(payload.truthGate.revision, TRUTH_GATE_REVISION);
  assert.equal(payload.truthGate.structuredTransitAuthorized, false);
  assert.equal(payload.truthGate.applied, true);
  assert.doesNotMatch(payload.answer, /小倉|鹿児島本線|ソニック/);
});

test('structured transit route evidence authorizes exact route wording', () => {
  const answer = '大分から行橋まではソニックを利用できます。';
  const payload = gateTurnPayload({
    answer,
    searchUseful: false,
    apiSources: [{ tool: 'navitime_market', category: 'transit_route', sourceUrl: 'https://example.test/api' }],
  }, '大分から行橋まで電車でどう行く？');

  assert.equal(payload.truthGate.structuredTransitAuthorized, true);
  assert.equal(payload.answer, answer);
});

test('failed dynamic lookup cannot mint a new live price', () => {
  const payload = gateTurnPayload({
    answer: '現在価格は29,800円です。中古PCはSSDと保証の有無を確認してください。',
    searchUseful: false,
    apiSources: [],
  }, 'この中古PCの現在価格はいくら？');

  assert.doesNotMatch(payload.answer, /29,800円/);
  assert.match(payload.answer, /SSD|保証/);
  assert.ok(payload.truthGate.reasons.includes('dynamic_specifics_require_external_evidence'));
});

test('a specific value supplied by the user may be repeated on a failed lookup', () => {
  const payload = gateTurnPayload({
    answer: '29,800円という条件なら、保証内容も比較してください。',
    searchUseful: false,
    apiSources: [],
  }, '29,800円の中古PCは妥当？現在の相場も知りたい');

  assert.match(payload.answer, /29,800円/);
});

test('ordinary low-risk conversation is not gated', () => {
  const answer = 'バナナはおやつに入る派です。';
  const payload = gateTurnPayload({ answer, searchUseful: false, apiSources: [] }, 'バナナはおやつに入る？');
  assert.equal(payload.answer, answer);
  assert.equal(payload.truthGate.applied, false);
});
