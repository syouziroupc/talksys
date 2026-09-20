import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/integrated-entry.js';

const { splitCompleteSpokenSentences, firstSpokenSentence } = __test;

test('verified voice stream can emit a long natural clause before the full sentence ends', () => {
  const text = 'Panasonic CF-SV8は第8世代Core i5を搭載するモデルで、Windows 11の要件確認が必要です。';
  const split = splitCompleteSpokenSentences(text);
  assert.equal(split.sentences[0], 'Panasonic CF-SV8は第8世代Core i5を搭載するモデルで、');
  assert.equal(split.sentences[1], 'Windows 11の要件確認が必要です。');
  assert.equal(split.rest, '');
});

test('short comma fragments are not emitted early', () => {
  const text = '結論として、対応しています。';
  const split = splitCompleteSpokenSentences(text);
  assert.deepEqual(split.sentences, ['結論として、対応しています。']);
  assert.equal(split.rest, '');
});

test('speculative primary TTS uses the same first chunk boundary as verified streaming', () => {
  const text = 'この製品は公式仕様で対応が確認できており、追加設定なしで利用できます。';
  const split = splitCompleteSpokenSentences(text);
  assert.equal(firstSpokenSentence(text), split.sentences[0]);
});

test('incomplete verifier text remains buffered when no safe pause exists', () => {
  const split = splitCompleteSpokenSentences('この製品は公式仕様で対応が確認');
  assert.deepEqual(split.sentences, []);
  assert.equal(split.rest, 'この製品は公式仕様で対応が確認');
});
