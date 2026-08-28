import test from 'node:test';
import assert from 'node:assert/strict';
import { needsWebSearch, parseRss, parseBingHtml, relevanceScore, formatSearchContext } from '../src/web-search.js';

test('casual Japanese chat and personal advice skip web search', () => {
  assert.equal(needsWebSearch('こんにちは'), false);
  assert.equal(needsWebSearch('今日は疲れたなあ'), false);
  assert.equal(needsWebSearch('最近仕事ばかりで疲れてる。どうしたらいいと思う'), false);
});

test('current and factual Japanese questions request web search', () => {
  assert.equal(needsWebSearch('今日のニュースを教えて'), true);
  assert.equal(needsWebSearch('現在の総理大臣は誰'), true);
  assert.equal(needsWebSearch('この商品の今の価格を調べて'), true);
});

test('ordinary knowledge questions default to web search', () => {
  assert.equal(needsWebSearch('HIFUってどういうもの？'), true);
  assert.equal(needsWebSearch('キャビテーションとHIFUの違いは'), true);
  assert.equal(needsWebSearch('Windows 11の要件を説明して'), true);
  assert.equal(needsWebSearch('Cloudflare Workersって何'), true);
});

test('RSS parser extracts result fields', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Example &amp; News]]></title><link>https://example.com/a</link><description><![CDATA[最新の説明です。]]></description></item></channel></rss>`;
  const results = parseRss(xml, 'test-rss');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Example & News');
  assert.equal(results[0].url, 'https://example.com/a');
  assert.equal(results[0].engine, 'test-rss');
  assert.match(formatSearchContext(results), /Source: example\.com/);
});

test('Bing HTML parser extracts b_algo results', () => {
  const html = `<ol><li class="b_algo"><h2><a href="https://example.jp/pm">日本の内閣総理大臣</a></h2><div><p>現在の内閣総理大臣について説明します。</p></div></li></ol>`;
  const results = parseBingHtml(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, '日本の内閣総理大臣');
  assert.equal(results[0].url, 'https://example.jp/pm');
});

test('relevance ranking rejects unrelated junk and rewards query overlap', () => {
  const query = '現在の日本の総理大臣は誰？';
  const relevant = relevanceScore(query, { title: '内閣総理大臣 - 日本', snippet: '日本の首相について', url: 'https://example.jp/pm' });
  const junk = relevanceScore(query, { title: 'Bookcase Junk Journal Printable Kit', snippet: 'Vintage book lover digital download', url: 'https://example.com/junk' });
  assert.ok(relevant >= 2);
  assert.equal(junk, 0);
});
