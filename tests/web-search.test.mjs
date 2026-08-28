import test from 'node:test';
import assert from 'node:assert/strict';
import { needsWebSearch, parseBingRss, formatSearchContext } from '../src/web-search.js';

test('casual Japanese chat skips web search', () => {
  assert.equal(needsWebSearch('こんにちは'), false);
  assert.equal(needsWebSearch('今日は疲れたなあ'), false);
});

test('current and factual Japanese questions request web search', () => {
  assert.equal(needsWebSearch('今日のニュースを教えて'), true);
  assert.equal(needsWebSearch('現在の総理大臣は誰'), true);
  assert.equal(needsWebSearch('この商品の今の価格を調べて'), true);
});

test('Bing RSS parser extracts grounded result fields', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Example &amp; News]]></title><link>https://example.com/a</link><description><![CDATA[最新の説明です。]]></description></item></channel></rss>`;
  const results = parseBingRss(xml);
  assert.deepEqual(results, [{ title: 'Example & News', url: 'https://example.com/a', snippet: '最新の説明です。' }]);
  assert.match(formatSearchContext(results), /Source: example\.com/);
});
