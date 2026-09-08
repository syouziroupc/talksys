import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCandidateFromTitle, sourceTitleRescue } from '../src/search-answer-v18.js';

test('search quality guard rejects listicles and buying guides as store candidates', () => {
  const bad = [
    { title: '別府市の中古・アウトレットパソコン専門店【安いおすすめ10選】' },
    { title: 'ノートパソコン、自作パソコン、パソコン選び方ガイド【2024】スペックの目安を診断' },
    { title: 'パソコン おすすめ10選｜初心者向け比較ガイド' },
  ];
  assert.deepEqual(bad.map(sourceCandidateFromTitle), ['', '', '']);
});

test('search quality guard extracts actual store names from official-looking result titles', () => {
  assert.equal(
    sourceCandidateFromTitle({ title: 'エディオン トキハ別府店｜エディオングループ店舗・チラシ検索' }),
    'エディオン トキハ別府店',
  );
  assert.equal(
    sourceCandidateFromTitle({ title: 'ヤマダデンキ テックランド別府駅前店 | 店舗情報' }),
    'ヤマダデンキ テックランド別府駅前店',
  );
  assert.equal(
    sourceCandidateFromTitle({ title: '正二郎商事亀川店｜別府の中古パソコン販売' }),
    '正二郎商事亀川店',
  );
});

test('fallback never reads article titles aloud as if they were stores', () => {
  const answer = sourceTitleRescue('安いパソコンを別府で買いたい', [
    { title: '別府市の中古・アウトレットパソコン専門店【安いおすすめ10選】' },
    { title: 'ノートパソコン、自作パソコン、パソコン選び方ガイド【2024】スペックの目安を診断' },
  ]);
  assert.doesNotMatch(answer, /おすすめ10選|選び方ガイド|自作パソコン/);
  assert.match(answer, /メモリ8GB以上/);
});

test('fallback gives concrete verified store candidates when available', () => {
  const answer = sourceTitleRescue('安いパソコンを別府で買いたい', [
    { title: 'エディオン トキハ別府店｜エディオングループ店舗・チラシ検索' },
    { title: 'ヤマダデンキ テックランド別府駅前店 | 店舗情報' },
    { title: 'パソコンおすすめ10選｜比較ガイド' },
  ]);
  assert.match(answer, /エディオン トキハ別府店/);
  assert.match(answer, /ヤマダデンキ テックランド別府駅前店/);
  assert.doesNotMatch(answer, /おすすめ10選/);
  assert.match(answer, /保証/);
});
