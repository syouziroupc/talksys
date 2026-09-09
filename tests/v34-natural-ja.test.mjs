import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker-v34.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../src/talk-client-v34.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v34 is production entry and keeps the simple HTTP mic architecture', () => {
  assert.match(wrangler, /"main"\s*:\s*"src\/worker-v34\.js"/);
  assert.doesNotMatch(wrangler, /"durable_objects"\s*:/);
  assert.doesNotMatch(worker, /extends\s+TalkSysVoiceAgent|new\s+WebSocket/);
  assert.doesNotMatch(client, /new\s+WebSocket|AudioWorkletNode/);
  assert.match(client, /getUserMedia/);
  assert.match(client, /createScriptProcessor/);
});

test('v34 uses GLM 5.3, Japanese Whisper and Grok TTS ja', () => {
  assert.match(worker, /@cf\/zai-org\/glm-5\.3-flash/);
  assert.match(worker, /@cf\/openai\/whisper-large-v3-turbo/);
  assert.match(worker, /xai\/grok-tts/);
  assert.match(worker, /TTS_LANGUAGE\s*=\s*'ja'/);
  assert.match(worker, /voice_id:\s*TTS_VOICE/);
  assert.doesNotMatch(worker, /@cf\/myshell-ai\/melotts/);
  assert.match(client, /Grok TTS \/ ja/);
});

test('v34 restores contextual advice routing instead of searching every PC consultation', () => {
  assert.match(worker, /GENERAL_ADVICE_RE/);
  assert.match(worker, /contextual-advice/);
  assert.match(worker, /SPECIFIC_LOOKUP_RE/);
  assert.match(worker, /explicit-current-lookup/);
  assert.match(worker, /pc-conversation/);
});

test('v34 conversation prompt advances the consultation instead of asking generic questions', () => {
  assert.match(worker, /曖昧に「具体的な内容を教えてください」で返さないでください/);
  assert.match(worker, /分かっている範囲でまず一歩進んだ提案/);
  assert.match(worker, /判断材料が十分なら、候補をぼかさず結論/);
  assert.match(worker, /単純な内容は1〜2文、通常は2〜4文/);
});

test('v34 keeps mic, text fallback and diagnostics', () => {
  assert.match(client, /\/api\/transcribe/);
  assert.match(client, /\/api\/turn/);
  assert.match(client, /\/api\/tts/);
  assert.match(client, /noiseFloor/);
  assert.match(client, /lastTranscript/);
  assert.match(client, /talksys-v34-grok-ja-natural/);
});
