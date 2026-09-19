import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SEARCH_PREFACE_REVISION,
  searchAnnouncementTopic,
  searchPreface,
} from '../src/integrated-entry.js';
import { TALK_CLIENT_V45, SEARCH_PREFACE_CLIENT_REVISION, __test as clientTest } from '../src/talk-client-v45.js';

const discord = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('search preface keeps greetings untouched', () => {
  assert.equal(SEARCH_PREFACE_REVISION, 'talksys-v63-search-preface-r1');
  for (const text of ['こんにちは', 'もしもし', 'ありがとう', 'こんばんは！']) {
    assert.deepEqual(searchPreface(text), { shouldSpeak: false, topic: '', text: '' });
  }
});

test('search preface names the topic for non-greeting search turns', () => {
  assert.equal(searchAnnouncementTopic('別府市の今日の天気は？'), '別府市の今日の天気');
  assert.equal(searchAnnouncementTopic('CF-SV8の中古価格は？'), 'CF-SV8の中古価格');
  assert.equal(searchAnnouncementTopic('おすすめのノートPCを探して'), 'おすすめのノートPC');

  assert.deepEqual(searchPreface('別府市の今日の天気は？'), {
    shouldSpeak: true,
    topic: '別府市の今日の天気',
    text: '別府市の今日の天気について検索しています。',
  });
  assert.equal(searchPreface('12345÷15').shouldSpeak, true);
});

test('browser client starts the real turn and parallel search preface path', () => {
  assert.equal(SEARCH_PREFACE_CLIENT_REVISION, 'talksys-v63-search-preface-r1');
  assert.equal(clientTest.parallelSearchPreface, true);
  assert.match(TALK_CLIENT_V45, /const turnPromise=fetch\('\/api\/turn'/);
  assert.match(TALK_CLIENT_V45, /fetch\('\/api\/search-preface'/);
  assert.match(TALK_CLIENT_V45, /searchAnnouncement:true/);
  assert.match(TALK_CLIENT_V45, /await searchAnnouncementTask/);
});

test('Discord voice bridge intentionally omits the web search preface for lower latency', () => {
  assert.doesNotMatch(discord, /\/api\/search-preface/);
  assert.doesNotMatch(discord, /searchPreface|prefaceTask|prefacePlaybackPromise/);
  assert.match(discord, /const answer = await talk\(text\)/);
});
