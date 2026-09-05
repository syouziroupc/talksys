import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLOUDFLARE_LIVE_CLIENT } from '../src/cloudflare-live-client.js';
import {
  REALTIME_STT_MODEL,
  ACCURATE_STT_MODEL,
  RESOLVER_MODEL,
} from '../src/cloudflare-japanese-stt.js';
import { PRIMARY_TTS_MODEL } from '../src/cloudflare-japanese-tts.js';
import {
  LIVE_CONVERSATION_MODEL,
  QUALITY_CONVERSATION_MODEL,
  GROUNDING_CONVERSATION_MODEL,
  FALLBACK_CONVERSATION_MODEL,
  modelInput,
} from '../src/cloudflare-llm.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const sttSource = fs.readFileSync(new URL('../src/cloudflare-japanese-stt.js', import.meta.url), 'utf8');
const llmSource = fs.readFileSync(new URL('../src/cloudflare-llm.js', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../src/web-search.js', import.meta.url), 'utf8');
const ttsSource = fs.readFileSync(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v15 is fully keyless Cloudflare primary architecture', () => {
  assert.match(wranglerSource, /"main":\s*"src\/worker-v14\.js"/);
  assert.match(workerSource, /VOICE_REVISION = 'cloudflare-live-v15\.0'/);
  assert.match(workerSource, /providerApiKeysRequired: false/);
  assert.doesNotMatch(workerSource + CLOUDFLARE_LIVE_CLIENT + sttSource + llmSource + ttsSource, /GEMINI_API_KEY|OPENAI_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /CHUNK_SAMPLES = 640/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /preferred_format: 'mp3'/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /SpeechRecognition/);
});

test('Japanese STT has a high-confidence Nova fast path and Whisper reconciliation fallback', () => {
  assert.equal(REALTIME_STT_MODEL, '@cf/deepgram/nova-3');
  assert.equal(ACCURATE_STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(RESOLVER_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(sttSource, /language: options\.language \|\| 'ja'/);
  assert.match(sttSource, /endpointingMs: options\.endpointingMs \?\? 320/);
  assert.match(sttSource, /utteranceEndMs: options\.utteranceEndMs \?\? 720/);
  assert.match(sttSource, /silenceMs: options\.silenceMs \?\? 440/);
  assert.match(sttSource, /fastFinalConfidence: options\.fastFinalConfidence \?\? 0\.88/);
  assert.match(sttSource, /const canUseFastNova/);
  assert.match(sttSource, /whisperTranscribe/);
  assert.match(sttSource, /condition_on_previous_text: false/);
  assert.match(sttSource, /beam_size: 8/);
  assert.match(workerSource, /sttHighConfidenceFastPath: true/);
  assert.match(workerSource, /dualAsrReconciliation: true/);
});

test('live, quality and grounded conversation routes use separate Cloudflare-hosted models', () => {
  assert.equal(LIVE_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.equal(QUALITY_CONVERSATION_MODEL, '@cf/zai-org/glm-5.3-flash');
  assert.equal(GROUNDING_CONVERSATION_MODEL, '@cf/openai/gpt-oss-120b');
  assert.equal(FALLBACK_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(llmSource, /x-session-affinity/);
  assert.match(llmSource, /streamCloudflareLiveConversation/);
  assert.match(llmSource, /streamCloudflareQualityConversation/);
  assert.match(llmSource, /streamCloudflareGroundedConversation/);
  assert.match(workerSource, /needsQualityConversation/);
  assert.match(workerSource, /historyLimit: 48/);
  assert.match(workerSource, /modelBenchmarkEndpoint: '\/api\/voice-model-bench'/);
});

test('live Qwen route disables thinking and streams short completions', () => {
  const input = modelInput(LIVE_CONVERSATION_MODEL, [{ role: 'user', content: 'こんにちは' }], 120, 0.2);
  assert.equal(input.stream, true);
  assert.equal(input.max_completion_tokens, 120);
  assert.equal(input.reasoning_effort, null);
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.equal(input.chat_template_kwargs.clear_thinking, true);
});

test('factual questions use multi-engine page evidence, reranking and spoken wait', () => {
  for (const required of ['google-html', 'duckduckgo-html', 'bing-html', 'wikipedia-ja', 'google-news']) {
    assert.match(webSource, new RegExp(required));
  }
  assert.match(webSource, /enrichResult/);
  assert.match(webSource, /extractPageExcerpt/);
  assert.match(llmSource, /rerankSearchResults/);
  assert.match(llmSource, /streamCloudflareGroundedConversation/);
  assert.match(workerSource, /yield 'ちょっと調べますね。'/);
  assert.match(workerSource, /needsWebSearch\(transcript\)/);
  assert.match(workerSource, /Webページ本文と検索結果だけを根拠/);
});

test('server TTS is Cloudflare-hosted Melo and device fallback is Japanese-only', () => {
  assert.equal(PRIMARY_TTS_MODEL, '@cf/myshell-ai/melotts');
  assert.match(ttsSource, /MeloJapaneseTTS/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /\^ja\(\?:-\|_\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /SpeechSynthesisUtterance/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /serverAudioThisTurn/);
  assert.match(workerSource, /browserSpeechSynthesisPrimary: false/);
  assert.match(workerSource, /deviceJapaneseTtsFallback: true/);
});

test('assistant playback is never streamed back into STT unless human barge-in wins', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /Never send the assistant's own audio to STT/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /BARGE_FRAMES = 3/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /type: 'interrupt'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /DEVICE_TTS_GUARD_MS = 350/);
});

test('typed chat shares the same durable voice agent websocket', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /AGENT_PATH = '\/agents\/talk-sys-voice-agent\/default'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /Keep the agent WebSocket alive so typed chat keeps the same conversation/);
  assert.match(workerSource, /sharedTypedAndVoiceHistory: true/);
});

test('current-screen inspection stays grounded in actual screenshot results', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /\/api\/locate/);
  assert.match(workerSource, /type: 'screen_request'/);
  assert.match(workerSource, /画面情報に無いボタン名/);
  assert.match(workerSource, /streamCloudflareQualityConversation/);
});
