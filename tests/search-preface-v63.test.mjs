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

  const preface = searchPreface('別府市の今日の天気は？');
  assert.equal(preface.shouldSpeak, true);
  assert.equal(preface.topic, '別府市の今日の天気');
  assert.match(preface.text, /別府市の今日の天気/);
  assert.match(preface.text, /調べています|確認しています|検索して確かめています|最新情報を確認しています|少し調べます/);
  assert.equal(searchPreface('12345÷15').shouldSpeak, false);
});

test('browser client starts the real turn and parallel search preface path', () => {
  assert.equal(SEARCH_PREFACE_CLIENT_REVISION, 'talksys-v63-search-preface-r1');
  assert.equal(clientTest.parallelSearchPreface, true);
  assert.match(TALK_CLIENT_V45, /const turnPromise=fetch\('\/api\/turn'/);
  assert.match(TALK_CLIENT_V45, /fetch\('\/api\/search-preface'/);
  assert.match(TALK_CLIENT_V45, /searchAnnouncement:true/);
  assert.match(TALK_CLIENT_V45, /await searchAnnouncementTask/);
});

test('Discord uses search preface only as independent wait audio', () => {
  assert.match(discord, /\/api\/search-preface/);
  assert.match(discord, /function startWaitCue/);
  assert.match(discord, /activeWaitCue = startWaitCue\(confirmedTranscript/);
  assert.match(discord, /const turn = await talk\(confirmedTranscript/);
  assert.match(discord, /activeWaitCue\?\.stop\('final-answer-ready'\)/);
  assert.doesNotMatch(discord, /waitCuePromise|talkStream|\/api\/turn-stream/);
});


test('search prefaces vary deterministically across different lookup questions', () => {
  const phrases = new Set([
    searchPreface('別府市の今日の天気は？').text,
    searchPreface('CF-SV8の中古価格は？').text,
    searchPreface('城島高原パークの営業時間は？').text,
    searchPreface('別府駅の始発は何時？').text,
    searchPreface('大分市のおすすめPC店は？').text,
  ]);
  assert.ok(phrases.size >= 2);
});
