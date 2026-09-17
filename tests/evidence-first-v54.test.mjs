import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, shouldGroundFactualTurn } from '../src/worker-v44.js';
import { __test as entryTest } from '../src/entry.js';
import { __test as searchTest } from '../src/search-v45.js';

const { gateTurnPayload } = entryTest;
const { extractLocalCandidates } = searchTest;

test('real-world details and compatibility questions are grounded by default', () => {
  for (const q of [
    'MILK HALLの電話番号は？',
    '別府で実在する中古PC店を3つ教えて',
    'QCM1250とこのACアダプタは互換性ある？',
    'この型番はWindows 11に対応してる？',
    'このホテルの営業時間は？',
  ]) {
    assert.equal(shouldGroundFactualTurn(q, []), true, q);
    const decision = classifyTurn(q, []);
    assert.equal(decision.mode, 'external', q);
    assert.equal(decision.webSearch === true || (Array.isArray(decision.apiIntents) && decision.apiIntents.length > 0), true, q);
  }
});

test('pure transformation and personal advice remain local unless current facts are requested', () => {
  assert.equal(classifyTurn('この文章を短く要約して', []).mode, 'casual');
  assert.equal(classifyTurn('メールの返信文を整えて', []).mode, 'casual');
  assert.equal(classifyTurn('仕事の進め方を一緒に考えて', []).mode, 'casual');
  assert.equal(classifyTurn('最新情報を調べて要約して', []).mode, 'external');
});

test('unsupported invented named businesses are removed when evidence does not contain the name', () => {
  const result = gateTurnPayload({
    answer: '別府なら架空パソコン工房がおすすめです。営業時間は10時からです。',
    search: true,
    searchUseful: false,
    sources: [],
    apiSources: [],
  }, '別府でおすすめの中古PC店は？');
  assert.doesNotMatch(result.answer, /架空パソコン工房/);
  assert.match(result.answer, /根拠|確認/);
  assert.equal(result.truthGate.applied, true);
});

test('a named business present in retrieved source titles survives the entity gate', () => {
  const result = gateTurnPayload({
    answer: '実在PC工房という店舗を確認できました。',
    search: true,
    searchUseful: true,
    sources: [{ title: '実在PC工房 - 別府市の中古パソコン店', url: 'https://example.com/shop', engine: 'test' }],
    apiSources: [],
  }, '別府で中古PC店を教えて');
  assert.match(result.answer, /実在PC工房/);
});

test('local candidate allow-list is built only from OSM/Nominatim evidence', () => {
  const candidates = extractLocalCandidates([
    { title: '実在ショップ', engine: 'openstreetmap-nominatim', snippet: '別府市...' },
    { title: '怪しい記事のおすすめ10選', engine: 'bing-html', snippet: '...' },
  ]);
  assert.deepEqual(candidates.map((x) => x.name), ['実在ショップ']);
});
