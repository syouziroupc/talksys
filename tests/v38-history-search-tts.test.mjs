import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V38 } from '../src/talk-client-v38.js';
import { __test as routing } from '../src/worker-v38.js';

const worker=fs.readFileSync(new URL('../src/worker-v38.js',import.meta.url),'utf8');
const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('v38 client falls back from missing Japanese device voice to Cloudflare TTS',()=>{
  assert.match(TALK_CLIENT_V38,/端末日本語音声なし → Cloudflare TTSへフォールバック/);
  assert.match(TALK_CLIENT_V38,/fetch\('\/api\/tts'/);
  assert.match(TALK_CLIENT_V38,/Cloudflare MeloTTS fallback/);
  assert.match(TALK_CLIENT_V38,/fallbackSource/);
  assert.match(TALK_CLIENT_V38,/fallbackAudio/);
});

test('v38 client passes the dedicated history-aware search plan into the answer turn',()=>{
  assert.match(TALK_CLIENT_V38,/searchPlan:plan\|\|null/);
  assert.match(TALK_CLIENT_V38,/検索計画/);
  assert.match(TALK_CLIENT_V38,/lastSearchPlan/);
  assert.match(TALK_CLIENT_V38,/相槌:/);
});

test('v38 server uses GLM as a dedicated search planning turn',()=>{
  assert.match(worker,/検索計画専用AI/);
  assert.match(worker,/最新の発言で変更された条件は過去条件より優先/);
  assert.match(worker,/searchInstruction/);
  assert.match(worker,/planner:'glm-history-v38'/);
  assert.match(worker,/workerV34\.fetch\(rewritten,env\)/);
});

test('v38 server keeps browser Japanese TTS primary and MeloTTS as fallback',()=>{
  assert.match(worker,/ttsPrimary:'browser\/speechSynthesis ja-JP'/);
  assert.match(worker,/ttsFallback:'@cf\/myshell-ai\/melotts'/);
  assert.match(worker,/workerV33\.fetch\(request,env\)/);
});

test('v38 planner JSON parser and local backchannels are safe',()=>{
  assert.deepEqual(routing.parseJson('```json\n{"search":true}\n```'),{search:true});
  assert.equal(routing.ackFor('こんにちは'),'');
  assert.match(routing.ackFor('もうちょっと安い方がいい'),/なるほど/);
  assert.match(routing.ackFor('パソコンの買い替えについて相談したいです'),/もちろん/);
});

test('v38 is production entry',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v38\.js"/);
  assert.match(worker,/talksys-v38-history-search-tts-fallback/);
  assert.match(worker,/historyAwareSearchPlanner:true/);
  assert.match(worker,/ttsFallbackEnabled:true/);
  assert.match(worker,/backchannels:true/);
});
