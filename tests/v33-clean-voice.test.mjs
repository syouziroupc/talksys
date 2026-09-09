import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker-v33.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../src/talk-client-v33.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v33 is a clean worker and does not inherit the legacy voice stack', () => {
  assert.doesNotMatch(worker, /extends\s+TalkSysVoiceAgentV\d+/);
  assert.doesNotMatch(worker, /@cloudflare\/voice|routeAgentRequest|new\s+WebSocket/);
  assert.match(wrangler, /"main"\s*:\s*"src\/worker-v33\.js"/);
  assert.doesNotMatch(wrangler, /"durable_objects"\s*:/);
});

test('v33 uses the requested GLM, Japanese STT and dedicated Japanese TTS', () => {
  assert.match(worker, /@cf\/zai-org\/glm-5\.3-flash/);
  assert.match(worker, /@cf\/openai\/whisper-large-v3-turbo/);
  assert.match(worker, /@cf\/myshell-ai\/melotts/);
  assert.match(worker, /lang:\s*'JP'/);
  assert.match(worker, /language:\s*'ja'/);
});

test('v33 browser path is only mic turns, text fallback and diagnostics', () => {
  assert.doesNotMatch(client, /new\s+WebSocket|AudioWorkletNode/);
  assert.match(client, /getUserMedia/);
  assert.match(client, /createScriptProcessor/);
  assert.match(client, /\/api\/transcribe/);
  assert.match(client, /\/api\/turn/);
  assert.match(client, /\/api\/tts/);
  assert.match(client, /noiseFloor/);
  assert.match(client, /lastTranscript/);
});

test('v33 answer policy is short and decisive', () => {
  assert.match(worker, /原則1〜3文/);
  assert.match(worker, /最初の一文で質問へ直接答えてください/);
  assert.match(worker, /候補をぼかさず1つ選び/);
});
