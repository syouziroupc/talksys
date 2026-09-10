import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { needsSearchDirector, SEARCH_V45_PROVIDER, SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED } from '../src/search-v45.js';
import { parseShoppingBudget, shoppingKeyword, publicShoppingApiRegistry, searchFormalShoppingApis } from '../src/free-shopping-api-v45.js';
import { __test as primaryTest } from '../src/direct-primary-v45.js';
import { deterministicStableFallback } from '../src/worker-v44.js';

test('general RSS/web scraping provider is disabled', () => {
  assert.equal(SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, false);
  assert.equal(SEARCH_V45_PROVIDER, 'formal-structured-apis+direct-primary');
  const source = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /searchBingRss\(/);
});

test('routine generic shopping skips Qwen director', () => {
  assert.equal(needsSearchDirector('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで'), false);
});

test('shopping parser separates budget and short keyword', () => {
  assert.equal(parseShoppingBudget('3万円以下で動画視聴用の中古ノートPC'), 30000);
  assert.equal(parseShoppingBudget('29,800円以内の中古PC'), 29800);
  const q = shoppingKeyword('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで');
  assert.ok(q.includes('中古'));
  assert.ok(q.includes('ノートパソコン'));
  assert.ok(!q.includes('3万円'));
});

test('formal shopping adapters require explicit operator opt-in', async () => {
  const out = await searchFormalShoppingApis('3万円以下 中古ノートPC', {}, Date.now() + 2000);
  assert.equal(out.results.length, 0);
  assert.ok(out.diagnostics.every(x => x.error === 'operator_opt_in_required'));
});

test('shopping registry documents credentials and terms gates', () => {
  const reg = publicShoppingApiRegistry();
  assert.equal(reg.yahoo_jp_shopping.requiresKey, true);
  assert.equal(reg.rakuten_ichiba.requiresKey, true);
  assert.match(reg.yahoo_jp_shopping.activation, /attribution/i);
  assert.match(reg.rakuten_ichiba.endpoint, /20260701/);
});

test('direct primary user agent remains identifiable but browser compatible', () => {
  const source = fs.readFileSync(new URL('../src/direct-primary-v45.js', import.meta.url), 'utf8');
  assert.match(source, /Mozilla\/5\.0 TalkSys\/45/);
  assert.equal(primaryTest.evidenceKind('BIOS Version 2.8 2014-01-01').hasVersionLike, true);
});

test('model timeout fallback is useful without inventing live listings', () => {
  const text = deterministicStableFallback('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで');
  assert.match(text, /メモリ8GB/);
  assert.match(text, /SSD/);
  assert.match(text, /価格・在庫/);
  assert.doesNotMatch(text, /ThinkPad|Let.?s note|Latitude/);
});

test('firmware fallback never invents current version', () => {
  const text = deterministicStableFallback('MSI X79A-GD45の最新BIOSを公式で確認して');
  assert.match(text, /最新BIOS\/UEFI/);
  assert.match(text, /推測しません/);
});

test('worker health overrides inherited stale search metadata', () => {
  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(source, /webSearchEngine: 'none-general; formal-api\+direct-primary'/);
  assert.match(source, /searchFillerModel: 'none'/);
  assert.match(source, /bingRssEnabled: false/);
  assert.match(source, /shoppingApiRegistry/);
});
