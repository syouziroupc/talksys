import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V36 } from '../src/talk-client-v36.js';
import { __test as routing } from '../src/worker-v36.js';

const worker=fs.readFileSync(new URL('../src/worker-v36.js',import.meta.url),'utf8');
const search=fs.readFileSync(new URL('../src/search-v26.js',import.meta.url),'utf8');
const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('v36 rewrites subjectless transit search into a compact transit intent',()=>{
  const history=[
    {role:'user',content:'大分駅から別府駅まで行かないといけないんだけど、何を乗っていけばいいかわかんないんだよね。'},
    {role:'assistant',content:'JRで移動できます。'},
  ];
  const r=routing.buildContextualSearch('今から君がちょっと検索してほしいんだけど。',history);
  assert.equal(r.reason,'context-carry-transit-search');
  assert.match(r.text,/大分駅から別府駅まで/);
  assert.match(r.text,/電車の経路/);
  assert.match(r.text,/直通/);
  assert.match(r.text,/所要時間/);
  assert.match(r.text,/運賃/);
  assert.match(r.text,/時刻表/);
  assert.match(r.text,/検索して/);
});

test('v36 extracts station pairs from conversational Japanese',()=>{
  assert.deepEqual(routing.stationPairFrom('大分駅から別府駅まで行かないといけない。'),['大分駅','別府駅']);
});

test('v36 forces local PC store requests into a location-aware search',()=>{
  const history=[
    {role:'user',content:'パソコンの買い替えについて相談したい。'},
    {role:'user',content:'ネットとYouTubeだけ。安いやつでいい。'},
    {role:'user',content:'ノートで画面の大きいやつがいい。'},
  ];
  const r=routing.buildContextualSearch('大分県内でおすすめのお店はありますか?',history);
  assert.equal(r.reason,'local-store-search');
  assert.match(r.text,/大分県/);
  assert.match(r.text,/ノートパソコン/);
  assert.match(r.text,/大画面/);
  assert.match(r.text,/安い/);
  assert.match(r.text,/店舗/);
});

test('v36 local store search has independent Bing RSS and OpenStreetMap fallbacks',()=>{
  assert.match(search,/searchBingRss/);
  assert.match(search,/searchOpenStreetMapLocal/);
  assert.match(search,/大分|localArea/);
  assert.match(search,/地域店舗を複数の検索経路で再確認/);
  assert.match(search,/localFallbackSucceeded:\s*true/);
});

test('v36 keeps one preferred Japanese voice for the session',()=>{
  assert.match(TALK_CLIENT_V36,/lockedVoiceKey/);
  assert.match(TALK_CLIENT_V36,/Google.*(?:日本語|Japanese)/i);
  assert.match(TALK_CLIENT_V36,/日本語音声を固定/);
  assert.match(TALK_CLIENT_V36,/utterance\.rate=1\.0/);
});

test('v36 supports microphone barge-in while TTS is playing',()=>{
  assert.match(TALK_CLIENT_V36,/interruptSpeechForBargeIn/);
  assert.match(TALK_CLIENT_V36,/音声割込み/);
  assert.match(TALK_CLIENT_V36,/speechSynthesis&&window\.speechSynthesis\.cancel/);
  assert.match(TALK_CLIENT_V36,/bargeHits>=3/);
  assert.match(TALK_CLIENT_V36,/if\(busy&&!speech\)/);
});

test('v36 still does not call broken server TTS',()=>{
  assert.doesNotMatch(TALK_CLIENT_V36,/fetch\('\/api\/tts'/);
  assert.match(TALK_CLIENT_V36,/\/api\/transcribe/);
  assert.match(TALK_CLIENT_V36,/\/api\/turn/);
});

test('transit evidence prioritizes the direct route page even when web sources exist',()=>{
  assert.match(search,/directTransitPrimary:\s*true/);
  assert.match(search,/(?:乗換案内の実ページ|現在時刻を指定した乗換案内)を優先根拠として確認/);
});

test('v36 is wired as production entry',()=>{
  assert.match(worker,/talksys-v36-search-voice-barge/);
  assert.match(worker,/searchContextRewrite:true/);
  assert.match(worker,/bargeIn:true/);
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v36\.js"/);
});
