import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLOUDFLARE_LIVE_CLIENT } from '../src/cloudflare-live-client.js';
import {
  REALTIME_STT_MODEL,
  ACCURATE_STT_MODEL,
  FALLBACK_STT_MODEL,
} from '../src/cloudflare-japanese-stt.js';
import {
  PRIMARY_TTS_MODEL,
  SECONDARY_TTS_MODEL,
} from '../src/cloudflare-japanese-tts.js';
import {
  PRIMARY_CONVERSATION_MODEL,
  FALLBACK_CONVERSATION_MODEL,
} from '../src/cloudflare-llm.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const sttSource = fs.readFileSync(new URL('../src/cloudflare-japanese-stt.js', import.meta.url), 'utf8');
const llmSource = fs.readFileSync(new URL('../src/cloudflare-llm.js', import.meta.url), 'utf8');
const ttsSource = fs.readFileSync(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v14 is Cloudflare-only primary voice architecture with no provider secrets', () => {
  assert.match(wranglerSource, /"main":\s*"src\/worker-v14\.js"/);
  assert.match(workerSource, /VOICE_REVISION = 'cloudflare-live-v14'/);
  assert.match(workerSource, /providerApiKeysRequired: false/);
  assert.doesNotMatch(workerSource + CLOUDFLARE_LIVE_CLIENT, /GEMINI_API_KEY|OPENAI_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /CHUNK_SAMPLES = 640/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /preferred_format: 'mp3'/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /SpeechRecognition|SpeechSynthesisUtterance/);
});

test('Japanese STT combines realtime Nova-3 with high-accuracy Cloudflare unified final transcription', () => {
  assert.equal(REALTIME_STT_MODEL, '@cf/deepgram/nova-3');
  assert.equal(ACCURATE_STT_MODEL, 'openai/gpt-4o-transcribe');
  assert.equal(FALLBACK_STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.match(sttSource, /language: 'ja'/);
  assert.match(sttSource, /gateway: \{ id: 'default' \}/);
  assert.match(sttSource, /silenceMs: options\.silenceMs \?\? 520/);
  assert.match(sttSource, /condition_on_previous_text: false/);
  assert.match(sttSource, /beam_size: 7/);
});

test('conversation uses one strong fast model with a Cloudflare-hosted fallback', () => {
  assert.equal(PRIMARY_CONVERSATION_MODEL, 'openai/gpt-5.4-mini');
  assert.equal(FALLBACK_CONVERSATION_MODEL, '@cf/nvidia/nemotron-3-120b-a12b');
  assert.match(llmSource, /reasoning_effort: 'low'/);
  assert.match(llmSource, /stream: true/);
  assert.match(workerSource, /historyLimit: 32/);
  assert.match(workerSource, /maxMessageCount: 1000/);
});

test('factual questions use provider-native web search and speak a wait phrase first', () => {
  assert.match(llmSource, /web_search_preview/);
  assert.match(llmSource, /search_context_size: 'medium'/);
  assert.match(llmSource, /country: 'JP'/);
  assert.match(workerSource, /yield 'ちょっと調べますね。'/);
  assert.match(workerSource, /needsWebSearch\(transcript\)/);
  assert.match(workerSource, /nativeWebSearch: 'openai-web-search-via-cloudflare-ai-gateway'/);
});

test('server TTS is Japanese-capable and keyless through Cloudflare Unified Billing', () => {
  assert.equal(PRIMARY_TTS_MODEL, 'inworld/tts-1.5-max');
  assert.equal(SECONDARY_TTS_MODEL, 'openai/tts-1');
  assert.match(ttsSource, /voice_id: 'Hana'/);
  assert.match(ttsSource, /output_format: 'mp3'/);
  assert.match(ttsSource, /gateway: \{ id: 'default' \}/);
  assert.match(workerSource, /serverSideTts: true/);
  assert.match(workerSource, /browserSpeechSynthesisPrimary: false/);
});

test('typed chat shares the exact same durable voice agent websocket', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /AGENT_PATH = '\/agents\/talk-sys-voice-agent\/default'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /Keep the agent WebSocket alive so typed chat keeps the same conversation/);
  assert.match(workerSource, /sharedTypedAndVoiceHistory: true/);
});

test('barge-in and current-screen inspection stay in the live path', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /BARGE_FRAMES = 3/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /type: 'interrupt'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /\/api\/locate/);
  assert.match(workerSource, /type: 'screen_request'/);
  assert.match(workerSource, /画面情報に無いボタン名/);
});
