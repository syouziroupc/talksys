import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V40 } from '../src/talk-client-v40.js';
import { __test as routing } from '../src/worker-v40.js';

const worker=fs.readFileSync(new URL('../src/worker-v40.js',import.meta.url),'utf8');
const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('v40 generated browser client is valid JavaScript',()=>{
  assert.doesNotThrow(()=>new Function(TALK_CLIENT_V40));
});

test('v40 blocks English sentences but permits technical terms used in Japanese PC consultation',()=>{
  assert.equal(routing.isEnglishSentence('Hello'),true);
  assert.equal(routing.isEnglishSentence('Where is Beppu Onsen in Japan?'),true);
  assert.equal(routing.isEnglishSentence('I want to ask you'),true);
  assert.equal(routing.isEnglishSentence('Windows 11'),false);
  assert.equal(routing.isEnglishSentence('SSD 256GB'),false);
  assert.equal(routing.isEnglishSentence('別府温泉はどこですか？'),false);
});

test('v40 client keeps English-only turns out of history and uses Japanese-only reply',()=>{
  assert.match(TALK_CLIENT_V40,/英語発話を日本語専用モードで遮断（履歴へ保存しません）/);
  assert.match(TALK_CLIENT_V40,/日本語でお話しください。/);
});

test('v40 client falls back to browser language selection instead of a server TTS',()=>{
  assert.match(TALK_CLIENT_V40,/lang=ja-JPで端末の自動選択を使用/);
  assert.match(TALK_CLIENT_V40,/u\.lang='ja-JP'/);
  assert.match(TALK_CLIENT_V40,/ttsStrategy='auto-lang-ja-JP'/);
  const speak=TALK_CLIENT_V40.slice(TALK_CLIENT_V40.indexOf('async function speak(text,options={})'),TALK_CLIENT_V40.indexOf('function interruptSpeechForBargeIn'));
  assert.doesNotMatch(speak,/playServerTtsChunk/);
  assert.doesNotMatch(speak,/\/api\/tts/);
});

test('v40 worker disables both Grok and Melo server fallback',()=>{
  assert.match(worker,/serverTtsEnabled:false/);
  assert.match(worker,/grokTtsActive:false/);
  assert.match(worker,/melottsFallback:false/);
  assert.match(worker,/browser default voice selected by lang=ja-JP/);
});

test('v40 remains Japanese-output guarded',()=>{
  assert.equal(routing.needsJapaneseRepair('Sure, go ahead. What would you like to ask?'),true);
  assert.equal(routing.needsJapaneseRepair('はい、別府温泉は大分県別府市にあります。'),false);
});

test('v40 is selected as production entry',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v40\.js"/);
});
