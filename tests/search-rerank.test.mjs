import test from 'node:test';
import assert from 'node:assert/strict';
import { rerankSearchResults, SEARCH_RERANK_MODEL } from '../src/search-rerank.js';

const results = [
  { title: '無関係', snippet: '料理の記事', url: 'https://example.com/a' },
  { title: '日本の内閣総理大臣', snippet: '内閣と首相について', url: 'https://example.jp/pm' },
  { title: '別記事', snippet: '政治一般', url: 'https://example.org/c' },
];

test('reranker uses Cloudflare BGE and reorders by returned indexes', async () => {
  let model = '';
  const ai = {
    async run(name, input) {
      model = name;
      assert.equal(input.contexts.length, 3);
      return { response: [{ index: 1, score: 0.91 }, { index: 2, score: 0.31 }, { index: 0, score: 0.02 }] };
    },
  };
  const ranked = await rerankSearchResults(ai, '現在の日本の総理大臣', results, 2);
  assert.equal(model, SEARCH_RERANK_MODEL);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].title, '日本の内閣総理大臣');
  assert.equal(ranked[1].title, '別記事');
});

test('reranker falls back safely if model fails', async () => {
  const ranked = await rerankSearchResults({ async run() { throw new Error('temporary'); } }, 'query', results, 2);
  assert.deepEqual(ranked, results.slice(0, 2));
});
