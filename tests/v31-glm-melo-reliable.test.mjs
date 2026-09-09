import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLOUDFLARE_LIVE_CLIENT_V31 } from '../src/cloudflare-live-client-v31.js';
import { GLM_CONVERSATION_MODEL_V31 } from '../src/glm-conversation-v31.js';

const client = CLOUDFLARE_LIVE_CLIENT_V31;

test('v31 production conversation is GLM 5.3 Flash only', async () => {
  const [worker, production] = await Promise.all([
    readFile(new URL('../src/worker-v31.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/worker-v31-production.js', import.meta.url), 'utf8'),
  ]);
  assert.equal(GLM_CONVERSATION_MODEL_V31, '@cf/zai-org/glm-5.3-flash');
  assert.match(worker, /streamGlmConversationV31/);
  assert.match(worker, /glmSameModelRecoveryOnly:\s*true/);
  assert.doesNotMatch(worker, /GROK_CONVERSATION|GROK_TTS|QWEN|DEEPSEEK|GPT_OSS/);
  assert.doesNotMatch(production, /grok-|xai\//i);
});

test('v31 removes the old hidden six-second GLM fallback minimum', async () => {
  const source = await readFile(new URL('../src/glm-conversation-v31.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.max\(6000/);
  assert.match(source, /Math\.max\(2800, Number\(options\.fallbackTimeoutMs\) \|\| 4300\)/);
  assert.match(source, /visible first-token timeout/);
  assert.match(source, /reader\.cancel\(\)/);
  assert.match(source, /continuationMessages/);
  assert.match(source, /Same-model recovery only/);
});

test('v31 records the user turn before answer completion', async () => {
  const worker = await readFile(new URL('../src/worker-v31.js', import.meta.url), 'utf8');
  assert.match(worker, /recordConversationUser\(connection, user\)/);
  assert.match(worker, /duplicateUserTurnGuard:\s*true/);
  assert.match(worker, /inFlightUserContext:\s*true/);
});

test('v31 makes MeloTTS the only audible assistant voice', () => {
  assert.match(client, /const MELO_TTS_ENDPOINT = '\/api\/melo-tts-v31'/);
  assert.match(client, /ttsProvider: '@cf\/myshell-ai\/melotts'/);
  assert.match(client, /browserSpeechSynthesisEnabled: false/);
  assert.match(client, /requestTypedMeloTts/);
  assert.match(client, /fetch\(MELO_TTS_ENDPOINT/);
  assert.match(client, /talksys-melo-audio/);
  assert.doesNotMatch(client, /queueCompletedStreamSpeech\(streamText, false\)/);
  assert.doesNotMatch(client, /queueCompletedStreamSpeech\(value, true\)/);
  assert.doesNotMatch(client, /window\.addEventListener\('voiceschanged'/);
});

test('話したことにする gets an explicit MeloTTS recovery path', () => {
  assert.match(client, /typedTtsGeneration \+= 1/);
  assert.match(client, /typedMeloOwnsTurn = false/);
  assert.match(client, /queueAudio\(buffer, 'typed-melo'\)/);
  assert.match(client, /if \(sourceKind === 'server' && typedMeloOwnsTurn\) return/);
});

test('v31 preserves Android PCM verification and recovery from v26', () => {
  assert.match(client, /verifyAndroidCapturePipeline/);
  assert.match(client, /Android microphone track is live but PCM capture produced no frames/);
  assert.match(client, /resumeMobileRuntime/);
  assert.match(client, /socket\?\.close\(\)/);
});

test('v31 production health is GLM plus Melo with no third-party credits', async () => {
  const worker = await readFile(new URL('../src/worker-v31.js', import.meta.url), 'utf8');
  assert.match(worker, /cloudflare-agent-v31-glm-melo-reliable/);
  assert.match(worker, /ttsPrimary:\s*PRIMARY_TTS_MODEL/);
  assert.match(worker, /ttsFallback:\s*null/);
  assert.match(worker, /thirdPartyModelCreditsRequired:\s*false/);
  assert.match(worker, /typedSpeechUsesMeloTts:\s*true/);
  assert.match(worker, /\/api\/glm-binding-probe-v31/);
  assert.match(worker, /\/api\/melo-tts-v31/);
});

test('v31 is selected while v30 stays as rollback marker', async () => {
  const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"main":\s*"src\/worker-v31-production\.js"/);
  assert.match(wrangler, /worker-v30-production\.js/);
});
