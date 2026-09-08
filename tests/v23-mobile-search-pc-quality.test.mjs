import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSearchQueriesV23, SEARCH_TOOL_V23_REVISION } from '../src/search-v23.js';
import { CLOUDFLARE_LIVE_CLIENT_V23 } from '../src/cloudflare-live-client-v23.js';
import { SEARCH_TRACE_CLIENT_V23 } from '../src/search-trace-client-v23.js';

const worker = fs.readFileSync(new URL('../src/worker-v23.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v23 is production entrypoint with v22 rollback base', () => {
  assert.match(wrangler, /"main":\s*"src\/worker-v23\.js"/);
  assert.match(worker, /extends TalkSysVoiceAgentV22/);
  assert.match(worker, /workerV22\.fetch/);
  assert.match(worker, /cloudflare-agent-v23-mobile-search-pc-quality/);
});

test('transit search expands route intent instead of sending only raw question', () => {
  const queries = buildSearchQueriesV23('鷺沼駅から用賀駅までの行き方を知りたい');
  assert.equal(queries.length, 3);
  assert.match(queries[0], /鷺沼駅/);
  assert.match(queries[0], /用賀駅/);
  assert.match(queries[0], /所要時間/);
  assert.match(queries[0], /運賃/);
  assert.match(queries[1], /直通/);
});

test('PC search adds official specification-oriented queries', () => {
  const queries = buildSearchQueriesV23('CF-SV8のUSB-C充電対応を詳しく知りたい');
  assert.equal(queries.length, 3);
  assert.match(queries[0], /CF-SV8/i);
  assert.match(queries[0], /仕様/);
  assert.match(queries[0], /公式/);
  assert.match(queries[1], /マニュアル/);
  assert.equal(SEARCH_TOOL_V23_REVISION, 'evidence-only-web-tool-v23-parallel-intent-search');
});

test('search wait phrase is actually spoken and has a bounded follow-up phrase', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /speakJapaneseFallback\(phrase, 'search-wait'\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /speakJapaneseFallback\(followupPhrase, 'search-wait'\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /2800/);
  assert.match(worker, /waitPhrase,/);
  assert.match(worker, /followupPhrase,/);
  assert.match(worker, /少し調べますね。/);
});

test('browser answer fallback waits for server audio and suppresses duplicate replay', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /lastFallbackAnswerText/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /now - lastFallbackAnswerAt < 8000/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /\}, 3500\);/);
  assert.match(worker, /duplicateBrowserTtsGuard: true/);
});

test('mobile microphone has constraint fallbacks, frame watchdog, and automatic recovery', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /async function acquireMicrophone/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /\{ audio: true \}/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /function armCaptureWatchdog/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /micCaptureKind === 'audio-worklet'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /createScriptProcessorCapture\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /scheduleMicRecovery\('track-ended'\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V23, /scheduleMicRecovery\('capture-stalled'\)/);
});

test('processing trace no longer wraps WebSocket a second time', () => {
  assert.doesNotMatch(SEARCH_TRACE_CLIENT_V23, /class TraceWebSocket/);
  assert.doesNotMatch(SEARCH_TRACE_CLIENT_V23, /window\.WebSocket = TraceWebSocket/);
  assert.match(SEARCH_TRACE_CLIENT_V23, /key === lastEventKey/);
});

test('PC answer mode is technical while search-meta chatter is forbidden', () => {
  assert.match(worker, /PC販売・修理の実務者/);
  assert.match(worker, /CPUの世代・型番・コア\/スレッド/);
  assert.match(worker, /メモリ容量と増設可否/);
  assert.match(worker, /SSDの規格/);
  assert.match(worker, /検索結果には記載がありません/);
  assert.match(worker, /検索メタ発言は禁止/);
  assert.match(worker, /pcExpertAnswerMode: true/);
});

test('grounded search stream can continue after interruption without repeating the prefix', () => {
  assert.match(worker, /streamGroundedWithContinuation/);
  assert.match(worker, /同じ内容を繰り返さず/);
  assert.match(worker, /groundedContinuationRetry: true/);
});
