import test from 'node:test';
import assert from 'node:assert/strict';
import { rerankSearchResults, SEARCH_RERANK_MODEL } from '../src/search-rerank.js';

const results = [
  { title: '無関係', snippet: '料理の記事', url: 'https://example.com/a' },
  { title: '日本の内閣総理大臣', snippet: '内閣と首相について', excerpt: '政府公式ページ本文の詳細な根拠', url: 'https://example.jp/pm' },
  { title: '別記事', snippet: '政治一般', url: 'https://example.org/c' },
];

test('reranker uses Cloudflare BGE, includes excerpt, and reorders by returned indexes', async () => {
  let model = '';
  const ai = {
    async run(name, input) {
      model = name;
      assert.equal(input.contexts.length, 3);
      assert.match(input.contexts[1].text, /政府公式ページ本文の詳細な根拠/);
      return { response: [{ index: 1, score: 0.91 }, { index: 2, score: 0.31 }, { index: 0, score: 0.02 }] };
    },
  };
  const ranked = await rerankSearchResults(ai, '現在の日本の総理大臣', results, 2);
  assert.equal(model, SEARCH_RERANK_MODEL);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].title, '日本の内閣総理大臣');
  assert.equal(ranked[1].title, '別記事');
});

test('reranker can preserve up to six useful candidates', async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    title: `候補${index}`,
    snippet: `関連情報${index}`,
    url: `https://example.com/${index}`,
  }));
  const ai = {
    async run(_name, input) {
      return { response: input.contexts.map((_item, index) => ({ index, score: 0.9 - index * 0.01 })) };
    },
  };
  const ranked = await rerankSearchResults(ai, '関連情報', many, 6);
  assert.equal(ranked.length, 6);
});

test('reranker falls back safely if model fails', async () => {
  const ranked = await rerankSearchResults({ async run() { throw new Error('temporary'); } }, 'query', results, 2);
  assert.deepEqual(ranked, results.slice(0, 2));
});
