import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLOUDFLARE_LIVE_CLIENT_V25 } from '../src/cloudflare-live-client-v25.js';
import { GLM_CONVERSATION_MODEL_V25 } from '../src/glm-conversation-v25.js';

const worker = fs.readFileSync(new URL('../src/worker-v25.js', import.meta.url), 'utf8');
const production = fs.readFileSync(new URL('../archive/v25/worker-production.js', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../src/glm-conversation-v25.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('all active v25 conversation generation uses GLM-5.3 Flash only', () => {
  assert.equal(GLM_CONVERSATION_MODEL_V25, '@cf/zai-org/glm-5.3-flash');
  assert.match(worker, /streamGlmConversationV25/);
  assert.match(worker, /glmOnlyConversation: true/);
  assert.match(worker, /reasoningEffort: 'low'/);
  assert.doesNotMatch(worker, /qwen|deepseek|gpt-oss/i);
  assert.doesNotMatch(runtime, /qwen|deepseek|gpt-oss/i);
});

test('v25 keeps answers concise while allowing more GLM reasoning quality', () => {
  assert.match(worker, /通常は1〜3文/);
  assert.match(worker, /最も価値の高い質問を1つだけ/);
  assert.match(worker, /maxTokens: quality \? 280 : 210/);
  assert.match(worker, /maxTokens: pc \? 340 : 250/);
  assert.match(production, /glmReasoningEffort: 'low'/);
});

test('Android microphone capture has a dedicated native-rate AudioContext', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /const IS_ANDROID = \/Android\/i/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /let captureAudioContext = null/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /createCaptureAudioContextCompat/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /captureAudioContext\.createMediaStreamSource/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /supported\.sampleRate && !IS_ANDROID/);
});

test('Android prefers ScriptProcessor and proves frame delivery before start_call', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /if \(IS_ANDROID\) captureOk = createScriptProcessorCapture\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /IS_ANDROID \? 1024 : 2048/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /if \(IS_ANDROID && micFrameCount < 1\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /マイク入力を確認しています/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /if \(IS_ANDROID && desiredCall && welcomed && micReady && !inCall && !callStartPending\) maybeStartCall\(\)/);
});

test('v25 exposes non-audio microphone diagnostics for handset debugging', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /__talksysVoiceDebug/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /pcmFramesSent/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /captureAudioContext/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V25, /talksys-mic-stalled/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT_V25, /rawAudio|audioBytes|base64Audio/);
});

test('v25 historical production wrapper and health contract are preserved', () => {
  assert.match(wrangler, /"main":\s*"archive\/v25\/worker-production\.js"/);
  assert.match(wrangler, /"main":\s*"src\/worker-v44\.js"/);
  assert.match(production, /Historical TalkSys v25 production wrapper/);
  assert.match(production, /cloudflare-agent-v25-glm-mobile-audio/);
  assert.match(production, /androidCallStartsAfterFirstMicFrame: true/);
  assert.match(production, /microphoneDiagnostics: true/);
});
