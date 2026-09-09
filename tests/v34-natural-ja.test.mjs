import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker-v34.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../src/talk-client-v34.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v34 kept the simple HTTP mic architecture', () => {
  assert.doesNotMatch(wrangler, /"durable_objects"\s*:/);
  assert.doesNotMatch(worker, /extends\s+TalkSysVoiceAgent|new\s+WebSocket/);
  assert.doesNotMatch(client, /new\s+WebSocket|AudioWorkletNode/);
  assert.match(client, /getUserMedia/);
  assert.match(client, /createScriptProcessor/);
});

test('v34 introduced GLM 5.3, Japanese Whisper and Grok TTS attempt', () => {
  assert.match(worker, /@cf\/zai-org\/glm-5\.3-flash/);
  assert.match(worker, /@cf\/openai\/whisper-large-v3-turbo/);
  assert.match(worker, /xai\/grok-tts/);
  assert.match(worker, /TTS_LANGUAGE\s*=\s*'ja'/);
});

test('v34 restored contextual advice routing', () => {
  assert.match(worker, /GENERAL_ADVICE_RE/);
  assert.match(worker, /contextual-advice/);
  assert.match(worker, /SPECIFIC_LOOKUP_RE/);
  assert.match(worker, /explicit-current-lookup/);
  assert.match(worker, /pc-conversation/);
});
