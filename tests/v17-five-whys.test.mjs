import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicSearchQueries,
  parseBingRss,
  hasUsefulSearchEvidence,
} from '../src/search-fallbacks.js';
import { isEvasiveGroundedAnswer } from '../src/cloudflare-llm.js';
import { normalizeJapaneseTtsText } from '../src/cloudflare-japanese-tts.js';

test('local PC purchase intent expands into deterministic Beppu store searches', () => {
  const queries = buildDeterministicSearchQueries('例えば別府市内でパソコンを買うならどこがいいのかな', []);
  assert.ok(queries.length >= 3);
  assert.match(queries[0], /別府市/);
  assert.match(queries.join('\n'), /パソコン/);
  assert.match(queries.join('\n'), /販売店/);
  assert.match(queries.join('\n'), /家電量販店/);
  assert.match(queries.join('\n'), /中古/);
});

test('local purchase query can inherit the product from recent conversation', () => {
  const queries = buildDeterministicSearchQueries('別府市内ならどこがいい？', [
    { role: 'assistant', content: 'パソコン、まだ迷っていますか？' },
    { role: 'user', content: '3万円ぐらいで考えている' },
  ]);
  assert.match(queries.join('\n'), /別府市/);
  assert.match(queries.join('\n'), /パソコン/);
});

test('Bing RSS parser gives a DOM-independent search result path', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[別府市 パソコンショップ 公式]]></title>
    <link>https://example.jp/beppu-pc</link>
    <description><![CDATA[別府市内でパソコンを販売しています。]]></description>
  </item></channel></rss>`;
  const results = parseBingRss(xml);
  assert.equal(results.length, 1);
  assert.equal(results[0].engine, 'bing-rss');
  assert.match(results[0].title, /別府市/);
  assert.match(results[0].snippet, /パソコン/);
});

test('evidence gate distinguishes useful search results from empty retrieval', () => {
  assert.equal(hasUsefulSearchEvidence([], 2), false);
  assert.equal(hasUsefulSearchEvidence([
    { title: '店舗A', url: 'https://a.example/', snippet: '別府市内のパソコン販売店。店頭販売と修理に対応しています。' },
    { title: '店舗B', url: 'https://b.example/', snippet: 'ノートパソコンを扱う店舗情報とアクセス案内です。' },
  ], 2), true);
});

test('answer quality gate rejects the exact evasive failure family seen in production', () => {
  assert.equal(isEvasiveGroundedAnswer('ご提示いただいた検索結果には、購入先の具体的な情報は含まれていませんでした。'), true);
  assert.equal(isEvasiveGroundedAnswer('今の検索では現在情報の裏付けが十分ではありませんでした。ただ、確認できる範囲の選び方や比較なら続けられます。'), true);
  assert.equal(isEvasiveGroundedAnswer('別府市内なら、まず検索で確認できた販売店を2店ほど比べて、保証と総額で決めるのがいいです。'), false);
});

test('Japanese TTS normalization makes common PC terms explicit and pronounceable', () => {
  const spoken = normalizeJapaneseTtsText('PCは8GB RAM、256GB SSD、Wi-Fi対応。CPUはCore i5です。');
  assert.match(spoken, /パソコン/);
  assert.match(spoken, /8ギガバイト/);
  assert.match(spoken, /メモリー/);
  assert.match(spoken, /256ギガバイト/);
  assert.match(spoken, /エスエスディー/);
  assert.match(spoken, /ワイファイ/);
  assert.match(spoken, /シーピーユー/);
});
