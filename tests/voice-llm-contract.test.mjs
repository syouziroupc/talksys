import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const liveClient = await readFile(new URL('../src/cloudflare-live-client.js', import.meta.url), 'utf8');
const streaming = await readFile(new URL('../src/streaming-workers-ai.js', import.meta.url), 'utf8');
const search = await readFile(new URL('../src/web-search.js', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const audit = await readFile(new URL('../src/search-answer-v18.js', import.meta.url), 'utf8');
const searchFallbacks = await readFile(new URL('../src/search-fallbacks.js', import.meta.url), 'utf8');
const cloudflareLlm = await readFile(new URL('../src/cloudflare-llm.js', import.meta.url), 'utf8');
const japaneseTts = await readFile(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');
const reranker = await readFile(new URL('../src/search-rerank.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('voice keeps fast live model and high-accuracy grounded cascade', () => {
  assert.match(streaming, /LIVE_VOICE_MODEL\s*=\s*'@cf\/qwen\/qwen3\.8-27b'/);
  assert.match(streaming, /GROUNDING_VOICE_MODEL\s*=\s*'@cf\/deepseek-ai\/deepseek-v4-pro-0813'/);
  assert.match(streaming, /GROUNDING_FALLBACK_MODEL\s*=\s*'@cf\/openai\/gpt-oss-120b'/);
  assert.match(streaming, /reasoning_effort:\s*null/);
  assert.match(streaming, /enable_thinking:\s*false/);
});

test('v18 phone runtime has no screen overlay or screenshot routing', () => {
  assert.match(worker, /VOICE_REVISION = 'cloudflare-live-v18\.5'/);
  assert.match(worker, /mode: 'phone-consultation-only'/);
  assert.doesNotMatch(worker, /requestScreen|screen_request|SCREEN_SYSTEM_PROMPT|mightNeedScreen/);
  assert.doesNotMatch(liveClient, /screenToggle|screenVideo|drawArrow|handleScreenRequest|api\/locate/);
  assert.doesNotMatch(index, /画面共有|PNG保存|VISION_MODEL|api\/locate/);
});

test('recent conversation context is connection-scoped and feeds both search and normal chat', () => {
  assert.match(worker, /conversationMemory = new Map/);
  assert.match(worker, /getConversationHistory\(context\)/);
  assert.match(worker, /CONTEXT_MAX_MESSAGES = 8/);
  assert.match(worker, /CONTEXT_TTL_MS = 30 \* 60 \* 1000/);
  assert.match(worker, /shouldDeepSearch\(transcript, history\)/);
  assert.match(worker, /answerWithVerifiedWebSearch[\s\S]*?transcript,[\s\n]*history/);
  assert.match(worker, /generateSearchFiller\(self\.env\.AI, transcript, history/);
  assert.match(worker, /\.\.\.history,[\s\n]*\{ role: 'user', content: transcript \}/);
  assert.match(worker, /crossTurnContext: true/);
  assert.match(worker, /crossSessionContext: false/);
  assert.match(liveClient, /talk-sys-voice-agent\/default/);
});

test('deep search plans up to eight queries and performs a second research pass when needed', () => {
  assert.match(orchestrator, /SEARCH_MAX_QUERIES = 8/);
  assert.match(orchestrator, /SEARCH_MAX_ROUNDS = 2/);
  assert.match(orchestrator, /6〜8本/);
  assert.match(orchestrator, /assessCoverage/);
  assert.match(orchestrator, /shouldForceSecondPass/);
  assert.match(orchestrator, /retryQueries/);
  assert.match(orchestrator, /searchBingRss/);
  assert.match(orchestrator, /searchOpenStreetMapLocal/);
  assert.match(searchFallbacks, /buildDeterministicSearchQueries/);
  assert.match(searchFallbacks, /format=rss/);
  assert.match(reranker, /@cf\/baai\/bge-reranker-base/);
  assert.match(cloudflareLlm, /runNonStreamingCascade/);
});

test('search query planner preserves user constraints and diversifies query intent', () => {
  assert.match(orchestrator, /予算、用途、地域、型番、日時、数量、条件/);
  assert.match(orchestrator, /広い探索1本/);
  assert.match(orchestrator, /一次情報\/公式1〜2本/);
  assert.match(orchestrator, /独立した確認1本/);
  assert.match(orchestrator, /比較\/評判1本/);
  assert.match(orchestrator, /存在確認と価格\/在庫確認を別クエリ/);
});

test('grounded answers receive a separate evidence audit for named businesses and current facts', () => {
  assert.match(audit, /Web根拠監査担当/);
  assert.match(audit, /店舗名、会社名、施設名、製品名、価格、在庫、営業時間/);
  assert.match(audit, /unsupportedNamedCandidates/);
  assert.match(audit, /sourceTitleRescue/);
  assert.match(audit, /answerWithVerifiedWebSearch/);
  assert.match(worker, /searchAnswerAudit: true/);
});

test('search failure boilerplate cannot be the final answer path', () => {
  assert.match(cloudflareLlm, /isEvasiveGroundedAnswer/);
  assert.match(cloudflareLlm, /deterministicRescue/);
  assert.match(cloudflareLlm, /perModelTimeoutMs: 3800/);
  assert.match(audit, /BAD_SEARCH_BOILERPLATE_RE/);
  assert.match(audit, /ご提示いただいた/);
  assert.match(audit, /裏付けが十分ではありません/);
});

test('search progress is a one-shot spoken status and is not duplicated into the answer transcript', () => {
  assert.match(orchestrator, /SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL/);
  assert.match(orchestrator, /SEARCH_FILLER_MIN_DELAY_MS = 320/);
  assert.match(worker, /waitPhrase: filler/);
  assert.doesNotMatch(worker, /yield `\$\{filler\}\\n`/);
  assert.match(liveClient, /lastSearchWaitPhrase/);
  assert.match(liveClient, /speakJapaneseFallback\(phrase\)/);
});

test('typed text simulates speech and plays the reply without opening the microphone', () => {
  assert.match(index, /話したことにする/);
  assert.match(index, /返事は文字と音声で再生します/);
  assert.match(liveClient, /typedVoiceOutput = true/);
  assert.match(liveClient, /ensurePlaybackAudio/);
  assert.match(liveClient, /desiredCall \|\| typedVoiceOutput/);
  assert.match(liveClient, /ttsFallbackTimer/);
  assert.match(liveClient, /!serverAudioThisTurn && !playing && !deviceSpeaking/);
  assert.doesNotMatch(liveClient, /setTimeout\(\(\) => startCall\(true\)/);
});

test('call connection has a hard timeout and cannot stay stuck on connecting', () => {
  assert.match(liveClient, /CALL_CONNECT_TIMEOUT_MS = 10000/);
  assert.match(liveClient, /armCallConnectTimeout/);
  assert.match(liveClient, /clearCallConnectTimeout/);
  assert.match(liveClient, /接続が完了しませんでした/);
  assert.match(worker, /callConnectTimeoutMs: 10000/);
});

test('Japanese server TTS normalizes technical terms and keeps speech clarity processing', () => {
  assert.match(japaneseTts, /normalizeJapaneseTtsText/);
  assert.match(japaneseTts, /パソコン/);
  assert.match(japaneseTts, /エスエスディー/);
  assert.match(japaneseTts, /ギガバイト/);
  assert.match(liveClient, /createDynamicsCompressor/);
  assert.match(liveClient, /speechGain\.gain\.value = 1\.12/);
  assert.match(liveClient, /utterance\.rate = 0\.98/);
});

test('40ms capture and safe barge-in remain enabled', () => {
  assert.match(liveClient, /CHUNK_SAMPLES = 640/);
  assert.match(liveClient, /BARGE_FRAMES = 3/);
  assert.match(liveClient, /Never send the assistant's own audio to STT/);
  assert.match(worker, /bargeIn: true/);
});

test('health contract advertises precision-first verified two-pass search', () => {
  assert.match(worker, /searchMaxQueries: 8/);
  assert.match(worker, /searchMaxRounds: 2/);
  assert.match(worker, /searchAnswerAudit: true/);
  assert.match(worker, /bounded-contextual-grounded-search/);
  assert.match(worker, /screenFunction: false/);
  assert.match(worker, /screenOverlay: false/);
  assert.match(worker, /crossTurnContext: true/);
  assert.match(worker, /typedSpeechVoiceOutput: true/);
  assert.match(worker, /normalConversationLiveOnly: true/);
  assert.match(worker, /casualFastPath: true/);
  assert.match(worker, /searchPrecisionOnly: true/);
  assert.match(cloudflareLlm, /result instanceof ReadableStream \|\| typeof result\.getReader === 'function'/);
  assert.match(cloudflareLlm, /extraHeaders/);
});
