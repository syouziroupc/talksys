import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLOUDFLARE_LIVE_CLIENT_V30 } from '../src/cloudflare-live-client-v30.js';

const client = CLOUDFLARE_LIVE_CLIENT_V30;

test('v30 never lets browser streaming TTS suppress Grok server audio', () => {
  assert.doesNotMatch(client, /if \(browserStreamTtsThisTurn\) return/);
  assert.doesNotMatch(client, /queueCompletedStreamSpeech\(streamText, false\)/);
  assert.doesNotMatch(client, /queueCompletedStreamSpeech\(value, true\)/);
  assert.match(client, /browserSpeechSynthesisEnabled: false/);
  assert.match(client, /talksys-grok-audio/);
});

test('v30 disables audible browser speech fallback', () => {
  assert.match(client, /function speakJapaneseFallback\(text, purpose = 'answer'\) \{\s*\/\/ Browser\/device speech is deliberately disabled[\s\S]*?return false;/);
  assert.doesNotMatch(client, /window\.addEventListener\('voiceschanged'/);
});

test('話したことにする routes completed text to server Grok TTS', () => {
  assert.match(client, /const GROK_TTS_ENDPOINT = '\/api\/grok-tts-v30'/);
  assert.match(client, /requestTypedGrokTts/);
  assert.match(client, /fetch\(GROK_TTS_ENDPOINT/);
  assert.match(client, /typedTtsGeneration \+= 1/);
});

test('v30 Grok startup budget no longer aborts at 1.55 seconds', async () => {
  const conversation = await readFile(new URL('../src/grok-conversation-v29.js', import.meta.url), 'utf8');
  assert.match(conversation, /Math\.max\(stream \? 4500 : 6500/);
  assert.match(conversation, /Math\.max\(4500, Number\(options\.firstTokenTimeoutMs\)/);
});

test('v30 health source declares Grok authoritative audio and typed Grok TTS', async () => {
  const worker = await readFile(new URL('../src/worker-v30.js', import.meta.url), 'utf8');
  assert.match(worker, /cloudflare-agent-v30-real-grok-audio-runtime/);
  assert.match(worker, /GROK_CONVERSATION_MODEL_V29/);
  assert.match(worker, /GROK_TTS_MODEL_V29/);
  assert.match(worker, /browserSpeechSynthesisEnabled:\s*false/);
  assert.match(worker, /typedSpeechUsesGrokTts:\s*true/);
  assert.match(worker, /serverAudioAuthoritative:\s*true/);
  assert.match(worker, /\/api\/grok-binding-probe-v30/);
});

test('v30 is the selected production entrypoint while v29 remains rollback', async () => {
  const [wrangler, production] = await Promise.all([
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    readFile(new URL('../src/worker-v30-production.js', import.meta.url), 'utf8'),
  ]);
  assert.match(wrangler, /"main":\s*"src\/worker-v30-production\.js"/);
  assert.match(wrangler, /worker-v29-production\.js/);
  assert.match(production, /grok-authoritative-browser-and-pstn-v30/);
  assert.match(production, /phone\/incoming/);
  assert.match(production, /phone\/media/);
});
