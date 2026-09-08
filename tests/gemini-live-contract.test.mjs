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
const searchSource = fs.readFileSync(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const auditSource = fs.readFileSync(new URL('../src/search-answer-v18.js', import.meta.url), 'utf8');
const fallbackSource = fs.readFileSync(new URL('../src/search-fallbacks.js', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../src/web-search.js', import.meta.url), 'utf8');
const ttsSource = fs.readFileSync(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v18 production entrypoint is phone consultation only and keyless', () => {
  assert.match(wranglerSource, /"main":\s*"src\/worker-v14\.js"/);
  assert.match(workerSource, /VOICE_REVISION = 'cloudflare-live-v18\.0'/);
  assert.match(workerSource, /mode: 'phone-consultation-only'/);
  assert.match(workerSource, /providerApiKeysRequired: false/);
  assert.match(workerSource, /screenFunction: false/);
  assert.match(workerSource, /screenOverlay: false/);
  assert.doesNotMatch(workerSource + CLOUDFLARE_LIVE_CLIENT + indexSource + sttSource + llmSource + ttsSource, /GEMINI_API_KEY|OPENAI_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY/);
  assert.doesNotMatch(workerSource, /screen_request|requestScreen|SCREEN_SYSTEM_PROMPT|mightNeedScreen/);
  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /screenToggle|screenVideo|overlay|\/api\/locate|screen_request/);
  assert.doesNotMatch(indexSource, /画面共有|screenToggle|overlay|\/api\/locate|VISION_MODEL/);
});

test('Japanese STT keeps high-confidence fast path and accurate reconciliation fallback', () => {
  assert.equal(REALTIME_STT_MODEL, '@cf/deepgram/nova-3');
  assert.equal(ACCURATE_STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(RESOLVER_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(sttSource, /language: options\.language \|\| 'ja'/);
  assert.match(sttSource, /fastFinalConfidence: options\.fastFinalConfidence \?\? 0\.88/);
  assert.match(sttSource, /whisperTranscribe/);
  assert.match(workerSource, /sttHighConfidenceFastPath: true/);
  assert.match(workerSource, /dualAsrReconciliation: true/);
});

test('live, quality and grounded routes keep separate Cloudflare-hosted model tiers', () => {
  assert.equal(LIVE_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.equal(QUALITY_CONVERSATION_MODEL, '@cf/zai-org/glm-5.3-flash');
  assert.equal(GROUNDING_CONVERSATION_MODEL, '@cf/deepseek-ai/deepseek-v4-pro-0813');
  assert.equal(GROUNDING_FALLBACK_MODEL, '@cf/openai/gpt-oss-120b');
  assert.equal(FALLBACK_CONVERSATION_MODEL, '@cf/qwen/qwen3.8-27b');
  assert.match(llmSource, /x-session-affinity/);
  assert.match(workerSource, /needsQualityConversation/);
  assert.match(workerSource, /historyLimit: 48/);
});

test('live Qwen route disables thinking and streams short completions', () => {
  const input = modelInput(LIVE_CONVERSATION_MODEL, [{ role: 'user', content: 'こんにちは' }], 120, 0.2);
  assert.equal(input.stream, true);
  assert.equal(input.max_completion_tokens, 120);
  assert.equal(input.reasoning_effort, null);
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.equal(input.chat_template_kwargs.clear_thinking, true);
});

test('v18 factual search uses contextual planning, up to eight queries and two-pass coverage checking', () => {
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
  assert.match(workerSource, /shouldDeepSearch\(transcript, context\.messages\)/);
  assert.match(workerSource, /answerWithVerifiedWebSearch/);
  assert.match(workerSource, /verified-deep-search-v18/);
});

test('search wait speech is deterministic and cannot leak guessed facts before search finishes', () => {
  assert.equal(SEARCH_FILLER_MODEL, 'deterministic-safe-filler');
  assert.match(searchSource, /詳しく確認します。少し待ってください。/);
  assert.doesNotMatch(searchSource, /ai\.run\(SEARCH_FILLER_MODEL/);
  assert.match(workerSource, /Promise\.race/);
  assert.match(workerSource, /searchFillerGeneratedInParallel: false/);
});

test('v18 answer layer audits unsupported proper nouns against retrieved evidence', () => {
  assert.match(auditSource, /Web根拠監査担当/);
  assert.match(auditSource, /unsupportedNamedCandidates/);
  assert.match(auditSource, /根拠にない店舗名・会社名・施設名/);
  assert.match(auditSource, /sourceTitleRescue/);
  assert.match(workerSource, /searchAnswerAudit: true/);
  assert.match(workerSource, /auditPassed/);
});

test('server TTS remains normalized and playback conditioned for clearer Japanese speech', () => {
  assert.equal(PRIMARY_TTS_MODEL, '@cf/myshell-ai/melotts');
  assert.match(ttsSource, /MeloJapaneseTTS/);
  assert.match(ttsSource, /normalizeJapaneseTtsText/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /createDynamicsCompressor\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /compressor\.threshold\.value = -24/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /speechGain\.gain\.value = 1\.12/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /utterance\.rate = 0\.98/);
});

test('assistant playback is never streamed back into STT unless human barge-in wins', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /Never send the assistant's own audio to STT/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /BARGE_FRAMES = 3/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /type: 'interrupt'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /DEVICE_TTS_GUARD_MS = 350/);
});

test('same durable voice agent keeps the conversation context across the call', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT, /AGENT_PATH = '\/agents\/talk-sys-voice-agent\/default'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);
  assert.match(workerSource, /sharedTypedAndVoiceHistory: true/);
});
