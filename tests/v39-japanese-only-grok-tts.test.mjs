import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V39 } from '../src/talk-client-v39.js';
import { __test as routing } from '../src/worker-v39.js';

const worker=fs.readFileSync(new URL('../src/worker-v39.js',import.meta.url),'utf8');
const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('v39 generated browser client is valid JavaScript',()=>{
  assert.doesNotThrow(()=>new Function(TALK_CLIENT_V39));
});

test('v39 treats English-only input as outside the Japanese-only conversation mode',()=>{
  assert.equal(routing.isNonJapaneseLanguageInput('Hello'),true);
  assert.equal(routing.isNonJapaneseLanguageInput('Where is Beppu Onsen in Japan?'),true);
  assert.equal(routing.isNonJapaneseLanguageInput('別府温泉はどこですか？'),false);
  assert.equal(routing.isNonJapaneseLanguageInput('Windows 11のおすすめは？'),false);
});

test('v39 detects an English answer that needs Japanese repair',()=>{
  assert.equal(routing.needsJapaneseRepair('Sure, go ahead. What would you like to ask?'),true);
  assert.equal(routing.needsJapaneseRepair('はい、別府温泉は大分県別府市にあります。'),false);
});

test('v39 client uses device Japanese voice first and Grok Japanese TTS only as fallback',()=>{
  assert.match(TALK_CLIENT_V39,/Grok TTS 日本語 fallback/);
  assert.match(TALK_CLIENT_V39,/Grok TTS日本語へフォールバック/);
  assert.match(TALK_CLIENT_V39,/日本語専用（端末→Grok）/);
  assert.doesNotMatch(TALK_CLIENT_V39,/Cloudflare MeloTTS fallback/);
});

test('v39 server removes MeloTTS from active fallback and uses Grok TTS ja',()=>{
  assert.match(worker,/GROK_TTS_MODEL_V29/);
  assert.match(worker,/GROK_TTS_LANGUAGE_V29/);
  assert.match(worker,/GrokJapaneseTTSV29/);
  assert.match(worker,/melottsFallback:false/);
  assert.match(worker,/englishConversationEnabled:false/);
  assert.match(worker,/日本語でお話しください。/);
});

test('v39 is selected as production entry',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v39\.js"/);
});
