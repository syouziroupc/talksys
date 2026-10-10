import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { phoneSearchTopic, phoneSearchProgressText, PHONE_SEARCH_PROGRESS_REVISION } from '../src/telephony/index.js';
import { phoneTtsVoice } from '../src/telephony/phone-tts.js';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('production phone voice is explicitly switched to energetic eve', () => {
  assert.match(wrangler, /"TELEPHONY_TTS_VOICE"\s*:\s*"eve"/);
  assert.equal(phoneTtsVoice({ TELEPHONY_TTS_VOICE: 'eve' }), 'eve');
});

test('lookup progress extracts a concise topic locally without another model call', () => {
  assert.equal(phoneSearchTopic('近くの牛丼屋を探して'), '近くの牛丼屋');
  assert.equal(phoneSearchTopic('東京の天気はどう'), '東京の天気');
  assert.equal(phoneSearchTopic('iPhone 17の価格を調べてください'), 'iPhone 17の価格');
  assert.equal(phoneSearchProgressText('東京の天気はどう'), 'いま、東京の天気について調べています。少々お待ちください。');
  assert.equal(PHONE_SEARCH_PROGRESS_REVISION, 'talksys-phone-search-progress-v1-r1');
});

test('lookup progress runs after TalkSys answer generation has already started', () => {
  const turnStart = telephony.indexOf('const turnPromise=answerWithTalkSys');
  const progressSpeak = telephony.indexOf("await speak(progressText,{purpose:'progress'");
  assert.ok(turnStart >= 0 && progressSpeak > turnStart);
  assert.match(telephony, /reaction\.kind==='lookup'/);
  assert.match(telephony, /PHONE_PROGRESS_WAIT_MS = 2400/);
  assert.match(telephony, /progress_skipped/);
});

test('dynamic progress has bounded in-memory cache and single-flight generation', () => {
  assert.match(telephony, /PHONE_PROGRESS_CACHE_MAX = 12/);
  assert.match(telephony, /phoneProgressAudioPromises\.has\(progressText\)/);
  assert.match(telephony, /phoneProgressAudioPromises\.set\(progressText, promise\)/);
  assert.match(telephony, /phoneProgressAudioCache\.size > PHONE_PROGRESS_CACHE_MAX/);
});

test('phone transport and answer quality paths remain frozen', () => {
  assert.match(telephony, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(telephony, /streamPcmu20ms\(audio\.bytes/);
  assert.match(telephony, /channel:\s*'phone'/);
  assert.match(telephony, /api_usage/);
  assert.doesNotMatch(telephony, /bidirectionalMode="mp3"/);
});
