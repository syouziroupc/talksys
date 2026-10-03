import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAmbiguousFollowupText,
  searchRoutingQuestion,
  shouldStronglyPreferSearch,
} from '../src/integrated-entry.js';

test('generic anchored advice keeps current utterance for search routing', () => {
  const body = {
    text: 'どれがいい？',
    history: [
      { role: 'user', content: '大学のレポート用に中古ノートPCを探してる。予算は3万円。' },
      { role: 'assistant', content: 'Officeとブラウザ中心ですね。' },
    ],
  };
  assert.match(resolveAmbiguousFollowupText(body), /中古ノートPC/);
  assert.equal(searchRoutingQuestion(body), 'どれがいい？');
  assert.equal(shouldStronglyPreferSearch(searchRoutingQuestion(body)), false);
});

test('store recommendation followup still routes to search', () => {
  const body = {
    text: 'おすすめのお店を教えてください。',
    history: [
      { role: 'user', content: '予算3万円でネットで中古パソコンを買いたいです。' },
      { role: 'assistant', content: '保証付きの専門店が安心です。' },
    ],
  };
  assert.match(resolveAmbiguousFollowupText(body), /中古パソコン/);
  assert.equal(searchRoutingQuestion(body), body.text);
  assert.equal(shouldStronglyPreferSearch(searchRoutingQuestion(body)), true);
});
