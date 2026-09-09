import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSearchQueriesV23, sourceEligibleV23 } from '../src/search-v23.js';
import { __test as v26 } from '../src/search-v26.js';

const v26Source=fs.readFileSync(new URL('../src/search-v26.js',import.meta.url),'utf8');

test('PC purchase instructions become short purchase queries instead of raw prompts',()=>{
  const q='ノートパソコンの購入先を検索して。低価格帯を優先し、メーカー直販、パソコン専門店、大手販売店の公式情報を比較し、保証や販売実態を確認できる具体的な購入先を挙げて。根拠にない販売店名は挙げないで。';
  const queries=buildSearchQueriesV23(q);
  assert.deepEqual(queries,[
    'ノートパソコン 低価格 メーカー直販 公式ストア',
    'ノートパソコン パソコン専門店 公式通販',
    'ノートパソコン 家電量販店 公式通販',
  ]);
  assert.ok(queries.every(x=>x.length<40));
});

test('PC purchase source filter rejects unrelated books and Reddit',()=>{
  const q='ノートパソコンの購入先 メーカー直販 公式通販 保証';
  assert.equal(sourceEligibleV23({title:'Statistics textbook',url:'https://www.elsevier.com/books/example',snippet:'statistics book'},q),false);
  assert.equal(sourceEligibleV23({title:'Reddit discussion',url:'https://www.reddit.com/r/laptops/',snippet:'PC laptop purchase discussion'},q),false);
});

test('PC purchase source filter accepts grounded official commerce pages',()=>{
  const q='ノートパソコンの購入先 メーカー直販 公式通販 保証';
  assert.equal(sourceEligibleV23({title:'ノートパソコン 公式',url:'https://www.lenovo.com/jp/ja/laptops/',snippet:'ノートパソコンを購入。価格、製品、保証、ストア情報。'},q),true);
  assert.equal(sourceEligibleV23({title:'ノートパソコン Dell 日本',url:'https://www.dell.com/ja-jp/shop/dell-laptops/scr/laptops',snippet:'Dell ノートパソコンの販売価格と購入、製品情報。'},q),true);
});

test('v26 commerce fallback uses concise queries and trusted direct seeds',()=>{
  const queries=v26.pcPurchaseQueries('ノートパソコン 低価格 メーカー直販 公式情報');
  assert.deepEqual(queries,[
    'ノートパソコン 低価格 メーカー直販 公式ストア',
    'ノートパソコン パソコン専門店 公式通販',
    'ノートパソコン 家電量販店 公式通販',
  ]);
  assert.match(v26Source,/OFFICIAL_PC_SEEDS/);
  assert.match(v26Source,/www\.lenovo\.com\/jp\/ja\/laptops/);
  assert.match(v26Source,/www\.dell\.com\/ja-jp\/shop\/dell-laptops/);
  assert.match(v26Source,/augmentPcPurchaseEvidence/);
  assert.match(v26Source,/if \(PC_RE\.test\(resolved\) && PC_PURCHASE_RE\.test\(resolved\)\) return base/);
});
