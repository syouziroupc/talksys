import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAmbiguousFollowupText } from '../src/integrated-entry.js';

test('ambiguous store followup anchors to the latest answered user topic', () => {
  const body = {
    text: 'おすすめのお店を教えてください。',
    history: [
      { role: 'user', content: '別府でイタリアンを探しています。' },
      { role: 'assistant', content: 'いくつか候補があります。' },
      { role: 'user', content: 'パソコンが壊れました。予算3万円でネットで中古パソコンを買いたいです。' },
      { role: 'assistant', content: '保証付きの中古パソコン専門店が安心です。' },
    ],
  };
  const resolved = resolveAmbiguousFollowupText(body);
  assert.match(resolved, /予算3万円/);
  assert.match(resolved, /中古パソコン/);
  assert.match(resolved, /おすすめのお店/);
  assert.doesNotMatch(resolved, /イタリアン/);
});

test('explicit topic switch is not anchored to the previous topic', () => {
  const body = {
    text: '別府市でおすすめの温泉を教えてください。',
    history: [
      { role: 'user', content: '予算3万円で中古パソコンを買いたいです。' },
      { role: 'assistant', content: '中古パソコン専門店が安心です。' },
    ],
  };
  assert.equal(resolveAmbiguousFollowupText(body), body.text);
});

test('short selection followup anchors to the latest answered user topic', () => {
  const body = {
    text: 'どれがいい？',
    history: [
      { role: 'user', content: '大学のレポート用に中古ノートPCを探してる。予算は3万円。' },
      { role: 'assistant', content: 'Officeとブラウザ中心ですね。' },
    ],
  };
  const resolved = resolveAmbiguousFollowupText(body);
  assert.match(resolved, /中古ノートPC/);
  assert.match(resolved, /どれがいい/);
});
