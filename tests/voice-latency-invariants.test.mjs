import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const integrated = readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('generic verification remains enabled and reuses the primary interaction context', () => {
  assert.match(integrated, /shouldRunGenericVerification\(text, primary\.payload\)/);
  assert.match(integrated, /previousInteractionId: compact\(primary\?\.payload\?\.id, 400\)/);
  assert.match(integrated, /createGeminiInteractionStream\(env, verifyBody, request\.signal, \{\s*allowPrevious: true,/s);
  assert.match(integrated, /previous_interaction_id: previousInteractionId/);
  assert.match(integrated, /forceSearch: true/);
});

test('speculative TTS cannot be played before a verified sentence arrives', () => {
  assert.match(integrated, /send\(\{ type: 'speculative', text: speculativeSentence/);
  assert.match(bridge, /event\?\.type === 'speculative'[\s\S]*onSpeculative\(String\(event\.text\)\)/);
  assert.match(bridge, /speculativeText === safe/);
  assert.match(bridge, /verified exact match; reusing prefetched audio/);
  assert.doesNotMatch(bridge, /event\?\.type === 'speculative'[\s\S]{0,300}queueSentence\(/);
});

test('verification preserves a correct candidate verbatim instead of gratuitous rewriting', () => {
  assert.match(integrated, /語句や文順をむやみに書き換えず候補回答をそのまま返してください/);
  assert.match(integrated, /修正が必要な箇所だけ直してください/);
});

test('batch STT is hedged during realtime finalization and cancelled on any realtime transcript', () => {
  assert.match(bridge, /startHedgedBatch\(150, 'realtime-finalize-hedge'\)/);
  assert.match(bridge, /if \(!latest && finalParts\.length === 0\)/);
  assert.match(bridge, /latest = text;\s*cancelHedgedBatch\(\);/s);
  assert.match(bridge, /batchTranscribePcm16\(pcmSnapshot, reason, hedgedBatchController\.signal\)/);
});

test('batch STT latency is propagated to voice metrics', () => {
  assert.match(bridge, /batchSttMs: Number\(speechMetrics\?\.batchSttMs\) \|\| 0/);
  assert.match(bridge, /batchSttMs,\s*sttMode:/s);
});
