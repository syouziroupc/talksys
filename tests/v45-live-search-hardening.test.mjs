import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as searchTest } from '../src/search-v45.js';
import { sanitizeUserFacingAnswer } from '../src/worker-v44.js';

test('current price coverage requires concrete seller money evidence', () => {
  assert.equal(searchTest.isPriceQuestion('Panasonic CF-SV8の現在の中古価格を調べて'), true);
  assert.equal(searchTest.hasConcretePriceEvidence([{ sourceRole:'seller', title:'CF-SV8 中古', url:'https://shop.example/item', excerpt:'在庫あり' }]), false);
  assert.equal(searchTest.hasConcretePriceEvidence([{ sourceRole:'seller', title:'CF-SV8 中古 24,800円', url:'https://shop.example/item', excerpt:'在庫あり' }]), true);
});

test('price recovery generates same-turn seller queries', () => {
  const facets = searchTest.priceRecoveryFacets({ resolvedQuestion:'Panasonic CF-SV8の現在の中古価格を調べて' }, [{ title:'Panasonic CF-SV8 中古', snippet:'整備済み', url:'https://shop.example/item' }]);
  assert.ok(facets.length >= 1);
  assert.ok(facets.every(x => x.sourceRole === 'seller'));
  assert.match(facets[0].primaryQuery, /CF-SV8/);
  assert.match(facets[0].primaryQuery, /価格/);
});

test('answer sanitizer removes background promises and user handoff', () => {
  const out = sanitizeUserFacingAnswer('販売ページは見つかりました。改めて確認しますので、少しお待ちください。各サイトでご自身で価格を確認してください。', 'CF-SV8の現在価格を調べて', { hasLivePriceEvidence:false });
  assert.doesNotMatch(out, /待ち|後ほど|改めて確認|ご自身で|自分で/);
});

test('answer sanitizer blocks unsupported new price claims but preserves user budget', () => {
  const out = sanitizeUserFacingAnswer('予算3万円以下なら探せます。2万円前後の機種が見つかることがあります。メモリ8GB以上を優先します。', '3万円以下の中古ノートPCを探して', { hasLivePriceEvidence:false });
  assert.match(out, /3万円/);
  assert.doesNotMatch(out, /2万円/);
  assert.match(out, /メモリ8GB/);
});

test('answer sanitizer allows concrete price when live evidence exists', () => {
  const out = sanitizeUserFacingAnswer('確認できた販売価格は24,800円です。', 'CF-SV8の現在価格を調べて', { hasLivePriceEvidence:true });
  assert.match(out, /24,800円/);
});
