import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guardUnsupportedTransitEntities } from '../src/worker-v44.js';

test('search director overlaps with deterministic seed retrieval', () => {
  const source = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');
  assert.match(source, /const planPromise = directorPlan/);
  assert.match(source, /seedSearchPromise/);
  assert.match(source, /Promise\.all\(\[\s*planPromise,\s*seedSearchPromise,/);
  assert.match(source, /directorParallelSeedSearch: true/);
});

test('grounded synthesis excludes assistant prose from factual context', () => {
  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(source, /const hist = userHistory\(body\?\.history\)\.slice\(-8\)/);
  assert.match(source, /groundedHistoryUserOnly: true/);
});

test('transit guard removes sentences containing unsupported rail entities', () => {
  const search = { evidenceUseful: true, results: [{ title: 'JR九州 日豊本線 大分 行橋', excerpt: '大分と行橋は日豊本線の駅です。' }] };
  const bad = guardUnsupportedTransitEntities('小倉で鹿児島本線に乗り換えます。', '大分から行橋まで電車で行きたい', search);
  assert.doesNotMatch(bad, /小倉|鹿児島本線/);
  const good = guardUnsupportedTransitEntities('日豊本線を利用します。', '大分から行橋まで電車で行きたい', search);
  assert.match(good, /日豊本線/);
});
