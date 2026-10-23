import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spokenPhonePlace,
  recentPhonePlaceFromHistory,
  resolvePhoneContextText,
  resolvedUserQuestion,
  shouldStronglyPreferSearch,
  __test,
} from '../src/integrated-entry.js';

const { deterministicLocationClarificationResult, interactionInput } = __test;

test('explicit spoken city is accepted without 市 or prefecture suffix', () => {
  for (const input of ['別府の天気は', '明日の別府の天気', '大分の気温を知りたい', '福岡の天気は', '札幌の天気']) {
    assert.ok(spokenPhonePlace(input), input);
    const body = { channel: 'phone', text: input, history: [] };
    assert.equal(deterministicLocationClarificationResult(resolvedUserQuestion(body), body), null, input);
    assert.equal(shouldStronglyPreferSearch(resolvedUserQuestion(body)), true);
    assert.match(interactionInput(body, { forceSearch: true }), /今回の利用者発言:/);
  }
});

test('unfounded STT bed-weather remains ambiguous, rather than inventing a place', () => {
  const body = { channel: 'phone', text: 'ベッドの天気は', history: [] };
  assert.equal(spokenPhonePlace(body.text), '');
  assert.match(deterministicLocationClarificationResult(resolvedUserQuestion(body), body)?.answer || '', /どの地域/);
});

test('correction Beppu after bed transcription bypasses clarifier and permits grounded lookup', () => {
  const body = {
    channel: 'phone',
    text: '別府の天気は',
    history: [
      { role: 'assistant', content: 'お電話ありがとうございます。' },
      { role: 'user', content: 'ベッドの天気を知りたい' },
      { role: 'assistant', content: 'どの地域でしょうか？' },
    ],
  };
  assert.equal(deterministicLocationClarificationResult(resolvedUserQuestion(body), body), null);
  assert.equal(spokenPhonePlace(resolvePhoneContextText(body)), '別府');
});

test('call-memory anchor fills an omitted place on immediate weather follow-up', () => {
  const body = {
    channel: 'phone',
    history: [
      { role: 'user', content: '別府の天気は？' },
      { role: 'assistant', content: '今日の別府についてです。' },
    ],
    text: '明日の天気はどう？',
  };
  assert.equal(recentPhonePlaceFromHistory(body), '別府');
  assert.match(resolvePhoneContextText(body), /直近の利用者発言で指定された地域: 別府/);
  assert.equal(deterministicLocationClarificationResult(resolvedUserQuestion(body), body), null);
  const input = interactionInput(body, { forceSearch: true });
  assert.match(input, /今回の利用者発言: 明日の天気はどう？/);
  assert.match(input, /指定された地域: 別府/);
  assert.match(input, /電話での連続した会話/);
});

test('correction context never changes an unrelated subject into a location query', () => {
  const body = {
    channel: 'phone',
    history: [{ role: 'user', content: '別府の天気は？' }],
    text: 'ところでノートパソコンの相談がある',
  };
  assert.equal(resolvePhoneContextText(body), body.text);
});

test('most recent explicit user place wins over older places; assistants cannot invent places', () => {
  const body = {
    channel: 'phone',
    history: [
      { role: 'user', content: '東京の天気は？' },
      { role: 'assistant', content: '東京の情報です。' },
      { role: 'user', content: '別府の天気が知りたい' },
      { role: 'assistant', content: '確認します。' },
    ],
    text: '明日は？天気',
  };
  assert.equal(recentPhonePlaceFromHistory(body), '別府');
  assert.match(resolvePhoneContextText(body), /別府/);
  assert.equal(recentPhonePlaceFromHistory({
    channel: 'phone',
    history: [{ role: 'user', content: 'おはよう' }, { role: 'assistant', content: '福岡の天気ですよ。' }],
  }), '');
});

test('phone history carries six recent exchanges without new D1 retrievals', () => {
  const history = [];
  for (let i = 0; i < 7; i++) {
    history.push({ role: 'user', content: '相談' + i });
    history.push({ role: 'assistant', content: '応答' + i });
  }
  const db = {
    prepare() { throw new Error('D1 reads forbidden during context resolution'); },
    exec() { throw new Error('D1 reads forbidden'); },
  };
  const body = { channel: 'phone', text: '続きについて教えて', history, db };
  const input = interactionInput(body);
  assert.match(input, /相談1/);
  assert.doesNotMatch(input, /相談0/);
  assert.match(input, /相談6/);
  assert.match(input, /応答6/);
  const web = interactionInput({ ...body, channel: 'web' });
  assert.doesNotMatch(web, /相談1/);
  assert.match(web, /相談3/);
  assert.ok(db.prepare);
});
