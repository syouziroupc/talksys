import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLOUDFLARE_LIVE_CLIENT_V24 } from '../src/cloudflare-live-client-v24.js';
import { resolveGroundedQuestionV22 } from '../src/search-v22.js';
import { buildSearchQueriesV23, sourceEligibleV23 } from '../src/search-v23.js';

const worker = fs.readFileSync(new URL('../src/worker-v24.js', import.meta.url), 'utf8');
const production = fs.readFileSync(new URL('../src/worker-v24-production.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Xperia handshake sends microphone pre-roll before listening acknowledgement', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /callStartPending/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /inCall \|\| callStartPending/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /start_call/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /callStartPending = true/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /socket\.send\(floatToPcm\(samples\)\)/);
});

test('voice barge-in stops local and server speech instead of discarding microphone input', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /BARGE_IN_THRESHOLD/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /BARGE_IN_FRAMES/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /stopPlayback\(true\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /talksys-barge-in/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT_V24, /Strict half-duplex while AI audio is audible/);
});

test('streaming browser speech starts at the first completed sentence', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /queueCompletedStreamSpeech\(streamText, false\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /queueCompletedStreamSpeech\(value, true\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /browserStreamTtsThisTurn/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V24, /pumpStreamSpeechQueue/);
});

test('used-PC Yokohama follow-up carries subject and condition without YouTube pollution', () => {
  const history = [
    { role: 'user', content: 'パソコンの買い替えについて相談したいんですけど' },
    { role: 'user', content: 'YouTube とネットサーフィンぐらいしかしないかな 安いやつがいい' },
    { role: 'user', content: 'どういうところで買うのがいいのかな' },
    { role: 'user', content: 'お店で買いたいな' },
    { role: 'user', content: '中古だったら どこで買うべき？' },
  ];
  const resolved = resolveGroundedQuestionV22('神奈川県横浜市でおすすめのお店ある', history);
  assert.match(resolved, /パソコン/);
  assert.match(resolved, /中古/);
  assert.match(resolved, /神奈川県横浜市/);
  assert.doesNotMatch(resolved, /YouTube|ネットサーフィン/);
});

test('local used-PC intent searches stores rather than specs and comparison pages', () => {
  const queries = buildSearchQueriesV23('パソコン 中古 神奈川県横浜市でおすすめのお店ある');
  assert.equal(queries.length, 3);
  for (const q of queries) {
    assert.match(q, /横浜市/);
    assert.match(q, /中古/);
    assert.match(q, /店舗|専門店|ショップ|店頭/);
    assert.doesNotMatch(q, /仕様|比較/);
  }
});

test('local used-PC evidence rejects generic manufacturer roots and accepts relevant store pages', () => {
  const question = 'パソコン 中古 神奈川県横浜市でおすすめのお店ある';
  assert.equal(sourceEligibleV23({
    title: 'パソコン通販のNEC LAVIE公式サイト',
    url: 'https://www.nec-lavie.jp/',
    engine: 'bing-rss',
    excerpt: '国内生産のパソコンを豊富にラインアップ。',
  }, question), false);
  assert.equal(sourceEligibleV23({
    title: '横浜市の中古パソコン専門店 PCリユース横浜',
    url: 'https://example.com/yokohama-used-pc',
    engine: 'bing-rss',
    excerpt: '横浜市で中古パソコンを店頭販売。店舗住所と営業時間を掲載。',
  }, question), true);
});

test('v24 defaults to concise precise replies and lower token budgets', () => {
  assert.match(worker, /原則1〜3文/);
  assert.match(worker, /次の判断に本当に必要な質問を1つだけ/);
  assert.match(worker, /maxTokens: pc \? 360 : 240/);
  assert.match(worker, /maxTokens: 260/);
  assert.match(worker, /cloudflare-agent-v24-xperia-fast-bargein/);
  assert.match(production, /browserStreamingTtsStartsAtFirstSentence: true/);
});

test('v24 remains available as a rollback entrypoint after v25', () => {
  assert.match(wrangler, /worker-v24-production\.js/);
});
