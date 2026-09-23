import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const integrated = readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('generic verification remains enabled in the one common web/Discord turn path', () => {
  assert.match(integrated, /export async function commonTalkSysTurn/);
  assert.match(integrated, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(integrated, /shouldRunGenericVerification\(text, interaction\.payload\)/);
  assert.match(integrated, /runGenericGeminiVerification\(env, body, interaction, signal, now\)/);
  assert.match(integrated, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.match(integrated, /discordTurnStreamResponse[\s\S]*runTalkSysTurn\(request, env, commonBody, request\.signal, ctx\)/);
});

test('Discord never exposes or speaks an unverified primary answer', () => {
  assert.doesNotMatch(integrated, /type: 'speculative'/);
  assert.doesNotMatch(bridge, /onSpeculative|speculativeText|speculativeAudioPromise/);
  assert.match(integrated, /Only the common final answer is emitted/);
  assert.match(bridge, /source=final-answer-first-sentence/);
});

test('verification preserves a correct candidate verbatim instead of gratuitous rewriting', () => {
  assert.match(integrated, /語句や文順をむやみに書き換えず候補回答をそのまま返してください/);
  assert.match(integrated, /修正が必要な箇所だけ直してください/);
});

test('batch STT stays off the normal realtime path and is used only as fallback', () => {
  assert.doesNotMatch(bridge, /startHedgedBatch|realtime-finalize-hedge|stt-hedge/);
  assert.match(bridge, /if \(!text && pcm16\.length\)/);
  assert.match(bridge, /batchTranscribePcm16\(pcm16, realtimeFailureReason \|\| reason, fallbackController\.signal\)/);
  assert.match(bridge, /batchSttMs: Number\(speechMetrics\?\.batchSttMs\) \|\| 0/);
  assert.match(bridge, /batchSttMs,\s*sttMode:/s);
});

test('batch STT latency is propagated to voice metrics', () => {
  assert.match(bridge, /batchSttMs: Number\(speechMetrics\?\.batchSttMs\) \|\| 0/);
  assert.match(bridge, /batchSttMs,\s*sttMode:/s);
});
