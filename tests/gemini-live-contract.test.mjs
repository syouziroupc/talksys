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
  GROUNDING_FALLBACK_MODEL,
  FALLBACK_CONVERSATION_MODEL,
  modelInput,
} from '../src/cloudflare-llm.js';
import { SEARCH_FILLER_MODEL, SEARCH_MAX_QUERIES, SEARCH_MAX_ROUNDS } from '../src/search-orchestrator.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const sttSource = fs.readFileSync(new URL('../src/cloudflare-japanese-stt.js', import.meta.url), 'utf8');
const llmSource = fs.readFileSync(new URL('../src/cloudflare-llm.js', import.meta.url), 'utf8');
const boundedSource = fs.readFileSync(new URL('../src/bounded-conversation.js', import.meta.url), 'utf8');
const memorySource = fs.readFileSync(new URL('../src/conversation-memory.js', import.meta.url), 'utf8');
const searchSource = fs.readFileSync(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const auditSource = fs.readFileSync(new URL('../src/search-answer-v18.js', import.meta.url), 'utf8');
const fallbackSource = fs.readFileSync(new URL('../src/search-fallbacks.js', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../src/web-search.js', import.meta.url), 'utf8');
const ttsSource = fs.readFileSync(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v18.6 production entrypoint is phone consultation only and keyless', () => {
  assert.match(wranglerSource, /"main":\s*"src\/worker-v14\.js"/);
  assert.match(workerSource, /VOICE_REVISION = 'cloudflare-live-v18\.6'/);
  assert.match(workerSource, /mode: 'phone-consultation-only'/);
  assert.match(workerSource, /providerApiKeysRequired: false/);
  assert.match(workerSource, /screenFunction: false/);
  assert.match(workerSource, /screenOverlay: false/);
  assert.doesNotMatch(workerSource + CLOUDFLARE_LIVE_CLIENT + indexSource + sttSource + llmSource + ttsSource, /GEMINI_API_KEY|OPENAI_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY/);
  assert.doesNotMatch(workerSource, /screen_request|requestScreen|SCREEN_SYSTEM_PROMPT|mightNeedScreen/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /screenToggle|screenVideo|drawArrow|\/api\/locate|screen_request/);
});

test('Japanese STT keeps high-confidence fast path and now receives conversation context', () => {
  assert.equal(REALTIME_STT_MODEL, '@cf/deepgram/nova-3');
  assert.equal(ACCURATE_STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(RESOLVER_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(sttSource, /contextProvider/);
  assert.match(sttSource, /直近会話/);
  assert.match(workerSource, /contextProvider: \(\) => this\.getTalkSysHistory\(connection\)/);
  assert.match(workerSource, /sttUsesConversationContext: true/);
});

test('live, quality and grounded routes keep separate Cloudflare-hosted model tiers', () => {
  assert.equal(LIVE_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.equal(QUALITY_CONVERSATION_MODEL, '@cf/zai-org/glm-5.3-flash');
  assert.equal(GROUNDING_CONVERSATION_MODEL, '@cf/deepseek-ai/deepseek-v4-pro-0813');
  assert.equal(GROUNDING_FALLBACK_MODEL, '@cf/openai/gpt-oss-120b');
  assert.equal(FALLBACK_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(workerSource, /qualityRouteForComplexConversation: true/);
  assert.match(workerSource, /casualFastPath: true/);
});

test('live Qwen route disables thinking and bounded conversation enforces startup timeouts', () => {
  const input = modelInput(LIVE_CONVERSATION_MODEL, [{ role: 'user', content: 'こんにちは' }], 120, 0.2);
  assert.equal(input.stream, true);
  assert.equal(input.max_completion_tokens, 120);
  assert.equal(input.reasoning_effort, null);
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.match(boundedSource, /openTimeoutMs/);
  assert.match(boundedSource, /fallbackTimeoutMs/);
  assert.match(boundedSource, /Workers AI first token/);
  assert.match(workerSource, /openTimeoutMs: 1900/);
});

test('factual search uses current conversation context, up to eight queries and recovery coverage', () => {
  assert.equal(SEARCH_MAX_QUERIES, 8);
  assert.equal(SEARCH_MAX_ROUNDS, 2);
  for (const required of ['google-html', 'duckduckgo-html', 'bing-html', 'wikipedia-ja', 'google-news']) assert.match(webSource, new RegExp(required));
  assert.match(searchSource, /6〜8本/);
  assert.match(searchSource, /assessCoverage/);
  assert.match(searchSource, /shouldForceSecondPass/);
  assert.match(searchSource, /searchBingRss/);
  assert.match(searchSource, /searchOpenStreetMapLocal/);
  assert.match(searchSource, /rerankSearchResults/);
  assert.match(fallbackSource, /format=rss/);
  assert.match(workerSource, /shouldDeepSearch\(transcript, history\)/);
  assert.match(workerSource, /answerWithVerifiedWebSearch/);
  assert.match(workerSource, /verified-context-search/);
});

test('search wait speech is contextual and cannot fall back to unknown-search nonsense', () => {
  assert.equal(SEARCH_FILLER_MODEL, LIVE_CONVERSATION_MODEL);
  assert.match(searchSource, /回答・推測・店名の新規生成は禁止/);
  assert.match(searchSource, /前の話を踏まえて確認しています/);
  assert.match(searchSource, /検索内容(?:が)?不明/);
  assert.match(workerSource, /Promise\.race/);
  assert.match(workerSource, /searchFillerGeneratedInParallel: true/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /前の話を踏まえて確認しています/);
});

test('typed speech simulation has audible replies without automatic microphone startup', () => {
  assert.match(indexSource, /話したことにする/);
  assert.match(indexSource, /返事は文字と音声で再生します/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /typedVoiceOutput = true/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /ensurePlaybackAudio/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /CALL_CONNECT_TIMEOUT_MS = 10000/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /setTimeout\(\(\) => startCall\(true\)/);
  assert.match(workerSource, /typedSpeechSimulation: true/);
  assert.match(workerSource, /typedSpeechVoiceOutput: true/);
});

test('answer layer audits unsupported proper nouns against retrieved evidence', () => {
  assert.match(auditSource, /Web根拠監査担当/);
  assert.match(auditSource, /unsupportedNamedCandidates/);
  assert.match(auditSource, /根拠にない名前を絶対に残さない/);
  assert.match(auditSource, /sourceTitleRescue/);
  assert.match(workerSource, /searchAnswerAudit: true/);
  assert.match(workerSource, /auditPassed/);
});

test('server TTS and browser playback are tuned for clearer Japanese speech', () => {
  assert.equal(PRIMARY_TTS_MODEL, '@cf/myshell-ai/melotts');
  assert.match(ttsSource, /normalizeJapaneseTtsText/);
  assert.match(ttsSource, /Mbps/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /createDynamicsCompressor\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /highpass\.frequency\.value = 90/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /presence\.frequency\.value = 2800/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /utterance\.rate = 0\.95/);
});

test('assistant playback is never streamed back into STT unless human barge-in wins', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /Never send the assistant's own audio to STT/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /BARGE_FRAMES = 3/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /type: 'interrupt'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /DEVICE_TTS_GUARD_MS = 350/);
});

test('conversation memory follows call lifecycle and only trusted caller identity persists across calls', () => {
  assert.match(workerSource, /historyLimit: 0/);
  assert.match(workerSource, /maxMessageCount: 0/);
  assert.match(workerSource, /onCallStart\(connection\)/);
  assert.match(workerSource, /onCallEnd\(connection\)/);
  assert.match(workerSource, /talksys_caller_memory/);
  assert.match(workerSource, /crossSessionContext: 'trusted-caller-only'/);
  assert.match(workerSource, /sessionMemoryTimeBasedExpiry: false/);
  assert.match(memorySource, /talksysTrustedCaller/);
  assert.match(memorySource, /trusted\.trusted !== true/);
  assert.doesNotMatch(workerSource, /CONTEXT_TTL_MS/);
});
