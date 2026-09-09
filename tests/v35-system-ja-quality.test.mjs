import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync(new URL('../src/worker-v35.js',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../src/talk-client-v35.js',import.meta.url),'utf8');
const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('v35 is production entry and preserves v34 microphone implementation',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v35\.js"/);
  assert.match(client,/TALK_CLIENT_V34/);
  assert.doesNotMatch(worker,/durable_objects|new\s+WebSocket/);
});

test('v35 disables broken server TTS and strictly selects Japanese browser voices',()=>{
  assert.match(worker,/browser\/speechSynthesis/);
  assert.match(worker,/ttsLanguage:'ja-JP'/);
  assert.match(worker,/serverTtsEnabled:false/);
  assert.match(client,/speechSynthesis/);
  assert.match(client,/SpeechSynthesisUtterance/);
  assert.match(client,/\^ja\(\?:-\|\$\)/);
  assert.match(client,/日本語TTS音声（ja-JP）が端末にありません/);
  assert.doesNotMatch(client,/fetch\('\/api\/tts'/);
});

test('v35 PC advice is concise and forbids unsearched prices',()=>{
  assert.match(worker,/返答は電話で聞きやすい自然な日本語で1〜3文/);
  assert.match(worker,/円・万円など具体的な価格額を出してはいけません/);
  assert.match(worker,/pc-contextual-v35/);
  assert.match(worker,/HARD_SEARCH_RE/);
  assert.match(worker,/SPECIFIC_LOOKUP_RE/);
});
