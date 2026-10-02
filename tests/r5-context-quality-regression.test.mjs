import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  resolveAmbiguousFollowupText,
  shouldStronglyPreferSearch,
  requiresGroundedEvidence,
} from '../src/integrated-entry.js';
import {
  fastReaction,
  FAST_REACTION_STATIC_TEXTS,
  realtimeSpeechAlternatives,
} from '../src/voice-fast-reaction.js';

const discordSource = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('ambiguous store followup anchors only to the latest answered user topic', () => {
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

test('explicit topic switch is never anchored to the previous PC topic', () => {
  const body = {
    text: '別府市でおすすめの温泉を教えてください。',
    history: [
      { role: 'user', content: '予算3万円で中古パソコンを買いたいです。' },
      { role: 'assistant', content: '中古パソコン専門店が安心です。' },
    ],
  };
  assert.equal(resolveAmbiguousFollowupText(body), body.text);
});

test('natural named-entity mention is searched and grounded', () => {
  const text = '元マチバルっていうところがいいと聞きましたが。';
  assert.equal(shouldStronglyPreferSearch(text), true);
  assert.equal(requiresGroundedEvidence(text), true);
});

test('Discord clears stale Gemini interaction IDs on reset responses', () => {
  assert.match(discordSource, /if \(body\.interactionReset\) previousInteractionId = '';/);
  assert.match(discordSource, /else if \(body\.interactionId\) previousInteractionId = body\.interactionId;/);
  assert.match(discordSource, /TURN-META/);
});

test('Discord sends Nova only as a secondary speech alternative', () => {
  assert.match(discordSource, /speechAlternatives: Array\.isArray\(speechAlternatives\)/);
  assert.match(discordSource, /realtimeSpeechAlternatives\(/);
  assert.match(discordSource, /STT-ALT/);
  assert.match(discordSource, /talk\(confirmedTranscript, utteranceId, controller\.signal, speechAlternatives\)/);
});

test('Nova alternative selector drops prior-turn carryover and fails safe on cumulative text', () => {
  assert.deepEqual(
    realtimeSpeechAlternatives(
      '今何時ですか?',
      'こんばんは。今何時ですか。',
      ['こんばんは。'],
    ),
    [],
  );

  assert.deepEqual(
    realtimeSpeechAlternatives(
      'おすすめのお店を教えてください。',
      '予算は3万円ぐらい。ネットで買いたい。おすすめのお店を教えてください。',
      ['予算は3万円ぐらい。ネットで買いたい。'],
    ),
    [],
  );

  assert.deepEqual(
    realtimeSpeechAlternatives(
      '元マチバルについて教えて。',
      '元町バルというお店について詳しく教えて。',
      [],
    ),
    ['元町バルというお店について詳しく教えて'],
  );
});

test('Nova alternative selector does not force uncertain punctuation-free carryover into Gemini', () => {
  assert.deepEqual(
    realtimeSpeechAlternatives(
      '今何時ですか?',
      'こんばんは今何時ですか',
      ['こんばんは。'],
    ),
    [],
  );
});

test('all static fast-reaction outputs are eligible for startup warming', () => {
  const expected = [
    'おはようございます。',
    'こんばんは。',
    'はい、フォーンズです。',
    'こんにちは。',
    'どういたしまして。',
    'はい、少し調べますね。',
    '関連情報を確認します。',
    '最新の情報を確認してみます。',
    '少し検索して確かめます。',
    '確認できる情報を調べています。',
    'はい、内容を確認しますね。',
    'はい、確認してお答えしますね。',
    'はい、内容を確認しています。',
  ];
  for (const text of expected) assert.ok(FAST_REACTION_STATIC_TEXTS.includes(text), text);
  assert.equal(new Set(FAST_REACTION_STATIC_TEXTS).size, expected.length);
  assert.match(discordSource, /FAST_REACTION_STATIC_TEXTS/);
  assert.match(discordSource, /let fastReactionWarmPromise = null/);
  assert.match(discordSource, /for \(const text of texts\)/);
  assert.doesNotMatch(discordSource, /Promise\.allSettled\(texts\.map/);
  assert.doesNotMatch(discordSource, /const samples = \['こんにちは'/);
});

test('representative fast reactions are covered by the static warm set', () => {
  const samples = [
    'こんばんは',
    'ありがとう',
    '今日の天気を教えて',
    'この内容について詳しく相談したいです',
    'これはどう思いますか?',
    'これはかなり長い説明文なので内容を確認してほしいと思っています',
  ];
  for (const sample of samples) {
    const reaction = fastReaction(sample);
    if (reaction.shouldSpeak) {
      assert.ok(FAST_REACTION_STATIC_TEXTS.includes(reaction.text), `${sample} -> ${reaction.text}`);
    }
  }
});
