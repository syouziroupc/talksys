import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAuditJson,
  riskyNamedCandidates,
  unsupportedNamedCandidates,
  sourceTitleRescue,
} from '../src/search-answer-v18.js';

test('audit parser accepts a corrected evidence-only answer', () => {
  const parsed = parseAuditJson(JSON.stringify({
    ok: false,
    unsupported: ['パソコン工房 別府店'],
    reason: '検索根拠に店舗名がない',
    answer: '検索で確認できた店舗だけを候補にします。',
  }));
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.unsupported, ['パソコン工房 別府店']);
  assert.match(parsed.answer, /確認できた店舗/);
});

test('named-store guard catches hallucinated or renamed local stores absent from evidence', () => {
  const answer = '別府市内なら、パソコン工房別府店とヤマダデンキ別府店が候補です。';
  const sources = [
    { title: 'ヤマダデンキ テックランド別府駅前店', snippet: '大分県別府市の店舗情報です。', url: 'https://example.com/yamada' },
    { title: 'エディオン 別府店', snippet: '別府市の家電量販店。', url: 'https://example.com/edion' },
  ];
  const unsupported = unsupportedNamedCandidates(answer, sources);
  assert.ok(unsupported.some((item) => /パソコン工房別府店/.test(item)));
  assert.ok(unsupported.some((item) => /ヤマダデンキ別府店/.test(item)), 'evidence says 別府駅前店, so the model must not rename it to 別府店');
});

test('named-store guard permits the exact store wording found in evidence', () => {
  const answer = '検索で確認できた候補は、ヤマダデンキテックランド別府駅前店です。';
  const sources = [
    { title: 'ヤマダデンキテックランド別府駅前店', snippet: '大分県別府市の店舗情報です。', url: 'https://example.com/yamada' },
  ];
  const risky = riskyNamedCandidates(answer);
  assert.ok(risky.length >= 1);
  assert.deepEqual(unsupportedNamedCandidates(answer, sources), []);
});

test('source-title rescue never invents a store outside retrieved titles', () => {
  const text = sourceTitleRescue('別府市内でパソコンを買うならどこがいい？', [
    { title: 'ヤマダデンキ テックランド別府駅前店 | 店舗情報', url: 'https://example.com/a' },
    { title: 'エディオン 別府店 | 公式サイト', url: 'https://example.com/b' },
  ]);
  assert.match(text, /ヤマダデンキ/);
  assert.match(text, /エディオン/);
  assert.doesNotMatch(text, /パソコン工房/);
});
