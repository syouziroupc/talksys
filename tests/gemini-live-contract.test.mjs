import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLOUDFLARE_LIVE_CLIENT } from '../src/cloudflare-live-client.js';
import { CLOUDFLARE_LIVE_CLIENT_V20 } from '../src/cloudflare-live-client-v20.js';
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
const legacyV19Source = fs.readFileSync(new URL('../src/worker-v19.js', import.meta.url), 'utf8');
const productionWorkerSource = fs.readFileSync(new URL('../src/worker-v20.js', import.meta.url), 'utf8');
const searchToolV20Source = fs.readFileSync(new URL('../src/search-tool-v20.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../src/index-v19.js', import.meta.url), 'utf8');
const sttSource = fs.readFileSync(new URL('../src/cloudflare-japanese-stt.js', import.meta.url), 'utf8');
const llmSource = fs.readFileSync(new URL('../src/cloudflare-llm.js', import.meta.url), 'utf8');
const boundedSource = fs.readFileSync(new URL('../src/bounded-conversation.js', import.meta.url), 'utf8');
const memorySource = fs.readFileSync(new URL('../src/conversation-memory.js', import.meta.url), 'utf8');
const searchSource = fs.readFileSync(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const searchV19Source = fs.readFileSync(new URL('../src/search-v19.js', import.meta.url), 'utf8');
const auditSource = fs.readFileSync(new URL('../src/search-answer-v18.js', import.meta.url), 'utf8');
const fallbackSource = fs.readFileSync(new URL('../src/search-fallbacks.js', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../src/web-search.js', import.meta.url), 'utf8');
const ttsSource = fs.readFileSync(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v20.2 production entrypoint uses tiered Cloudflare conversation, deterministic search and robust audio while staying keyless', () => {
  assert.match(wranglerSource, /"main":\s*"src\/worker-v20\.js"/);
  assert.match(productionWorkerSource, /VOICE_REVISION = 'cloudflare-agent-v20\.2-audio-search'/);
  assert.match(productionWorkerSource, /extends BaseTalkSysVoiceAgent/);
  assert.match(productionWorkerSource, /conversationOrchestrator: 'tiered-fast-agent-v20\.2'/);
  assert.match(productionWorkerSource, /toolCalling: 'deterministic-search-router-v20\.2'/);
  assert.match(productionWorkerSource, /CLOUDFLARE_LIVE_CLIENT_V20/);
  assert.match(productionWorkerSource, /modelDecidesToolUse: false/);
  assert.match(productionWorkerSource, /ordinaryConversationUsesToolInference: false/);
  assert.match(productionWorkerSource, /midStreamContinuationRecovery: true/);
  assert.match(productionWorkerSource, /strictHalfDuplexEchoGuard: true/);
  assert.doesNotMatch(productionWorkerSource, /runWithTools/);
  assert.match(workerSource, /mode: 'phone-consultation-only'/);
  assert.match(workerSource, /providerApiKeysRequired: false/);
  assert.match(workerSource, /screenFunction: false/);
  assert.match(workerSource, /screenOverlay: false/);
  assert.doesNotMatch(workerSource + legacyV19Source + productionWorkerSource + CLOUDFLARE_LIVE_CLIENT + CLOUDFLARE_LIVE_CLIENT_V20 + indexSource + sttSource + llmSource + ttsSource, /GEMINI_API_KEY|OPENAI_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY/);
  assert.doesNotMatch(workerSource + productionWorkerSource, /screen_request|requestScreen|SCREEN_SYSTEM_PROMPT|mightNeedScreen/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT_V20, /screenToggle|screenVideo|drawArrow|\/api\/locate|screen_request/);
});

test('Japanese STT keeps high-confidence fast path and receives conversation context', () => {
  assert.equal(REALTIME_STT_MODEL, '@cf/deepgram/nova-3');
  assert.equal(ACCURATE_STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(RESOLVER_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(sttSource, /contextProvider/);
  assert.match(sttSource, /直近会話/);
  assert.match(workerSource, /contextProvider: \(\) => this\.getTalkSysHistory\(connection\)/);
  assert.match(workerSource, /sttUsesConversationContext: true/);
});

test('Qwen is the v20.2 fast center and GLM handles quality and grounded search turns', () => {
  assert.equal(LIVE_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.equal(QUALITY_CONVERSATION_MODEL, '@cf/zai-org/glm-5.3-flash');
  assert.equal(GROUNDING_CONVERSATION_MODEL, '@cf/deepseek-ai/deepseek-v4-pro-0813');
  assert.equal(GROUNDING_FALLBACK_MODEL, '@cf/openai/gpt-oss-120b');
  assert.equal(FALLBACK_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(workerSource, /qualityRouteForComplexConversation: true/);
  assert.match(workerSource, /casualFastPath: true/);
  assert.match(productionWorkerSource, /primaryConversationModel: LIVE_CONVERSATION_MODEL/);
  assert.match(productionWorkerSource, /qualityConversationModel: QUALITY_CONVERSATION_MODEL/);
  assert.match(productionWorkerSource, /streamBoundedLiveConversation/);
  assert.match(productionWorkerSource, /streamBoundedQualityConversation/);
});

test('live Qwen disables thinking and bounded conversation now repairs mid-stream truncation', () => {
  const input = modelInput(LIVE_CONVERSATION_MODEL, [{ role: 'user', content: 'こんにちは' }], 120, 0.2);
  assert.equal(input.stream, true);
  assert.equal(input.max_completion_tokens, 120);
  assert.equal(input.reasoning_effort, null);
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.match(boundedSource, /openTimeoutMs/);
  assert.match(boundedSource, /fallbackTimeoutMs/);
  assert.match(boundedSource, /Workers AI first token/);
  assert.match(boundedSource, /recoverContinuation/);
  assert.match(boundedSource, /直前の回答が通信上の理由で途中までしか届いていません/);
  assert.match(productionWorkerSource, /openTimeoutMs: 1700/);
  assert.match(productionWorkerSource, /firstTokenTimeoutMs: 2000/);
});

test('v19 search remains rollback while v20.2 uses deterministic evidence-only retrieval', () => {
  assert.equal(SEARCH_MAX_QUERIES, 8);
  assert.equal(SEARCH_MAX_ROUNDS, 2);
  for (const required of ['google-html', 'duckduckgo-html', 'bing-html', 'wikipedia-ja', 'google-news']) assert.match(webSource, new RegExp(required));
  assert.match(searchSource, /6〜8本/);
  assert.match(searchV19Source, /const plan = await resolvePlan\(ai, question, history, options\)/);
  assert.match(searchV19Source, /const search = await runSearch\(ai, plan, options\)/);
  assert.match(fallbackSource, /format=rss/);
  assert.match(productionWorkerSource, /collectWebEvidenceV20/);
  assert.match(productionWorkerSource, /requiresFreshSearch\(transcript\)/);
  assert.match(productionWorkerSource, /namedBusinessContactSearch: true/);
  assert.doesNotMatch(productionWorkerSource, /runWithTools/);
  assert.doesNotMatch(searchToolV20Source, /runNonStreamingCascade/);
  assert.doesNotMatch(searchToolV20Source, /auditAnswer/);
});

test('v20 uses fixed search wait speech instead of an extra filler model call', () => {
  assert.equal(SEARCH_FILLER_MODEL, LIVE_CONVERSATION_MODEL);
  assert.match(searchSource, /回答・推測・店名の新規生成は禁止/);
  assert.match(productionWorkerSource, /少し調べますね/);
  assert.match(productionWorkerSource, /fixedSearchWaitSpeech: true/);
  assert.doesNotMatch(productionWorkerSource, /generateSearchFiller/);
});

test('typed speech simulation remains audible without automatically opening the microphone', () => {
  assert.match(indexSource, /話したことにする/);
  assert.match(indexSource, /返事は文字と音声で再生します/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /typedVoiceOutput = true/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /ensurePlaybackAudio/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /CALL_CONNECT_TIMEOUT_MS = 10000/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT_V20, /setTimeout\(\(\) => startCall\(true\)/);
  assert.match(workerSource, /typedSpeechSimulation: true/);
  assert.match(workerSource, /typedSpeechVoiceOutput: true/);
});

test('production microphone capture prefers AudioWorklet, falls back on older browsers, and never monitors mic into speakers', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /echoCancellation/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /noiseSuppression/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /autoGainControl/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /createWorkletCapture/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /createScriptProcessorCapture/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /captureSilenceGain\.gain\.value = 0/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /if \(assistantAudioActive\(\)\) return/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /PLAYBACK_TAIL_GUARD_MS = 700/);
});

test('server TTS and browser playback remain tuned for Japanese speech', () => {
  assert.equal(PRIMARY_TTS_MODEL, '@cf/myshell-ai/melotts');
  assert.match(ttsSource, /normalizeJapaneseTtsText/);
  assert.match(ttsSource, /Mbps/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /createDynamicsCompressor\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /highpass\.frequency\.value = 90/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /presence\.frequency\.value = 2800/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V20, /utterance\.rate = 0\.95/);
});

test('legacy answer audit remains available for rollback but is not in v20 production answer path', () => {
  assert.match(auditSource, /Web根拠監査担当/);
  assert.match(auditSource, /unsupportedNamedCandidates/);
  assert.match(searchV19Source, /auditAnswer/);
  assert.doesNotMatch(productionWorkerSource, /auditAnswer/);
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
