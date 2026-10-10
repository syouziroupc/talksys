import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeProviderUsage, normalizeGeminiUsage, USAGE_TELEMETRY_REVISION } from '../src/usage-telemetry.js';

const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('usage telemetry normalizes Gemini Interactions usage without another API call', () => {
  const usage = normalizeGeminiUsage({
    usage: { total_input_tokens: 120, total_output_tokens: 30, total_cached_tokens: 40, total_tool_use_tokens: 12, grounding_tool_count: 1 },
    steps: [{ type: 'google_search_call' }],
  }, { transport: 'interactions' });
  assert.equal(usage.revision, USAGE_TELEMETRY_REVISION);
  assert.equal(usage.inputTokens, 120);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.cachedTokens, 40);
  assert.equal(usage.toolUseTokens, 12);
  assert.equal(usage.searchCalls, 1);
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.usageAvailable, true);
});

test('usage telemetry normalizes generateContent usageMetadata', () => {
  const usage = normalizeGeminiUsage({
    usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, cachedContentTokenCount: 15, toolUsePromptTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 110 },
    candidates: [{ groundingMetadata: { webSearchQueries: ['query'] } }],
  }, { transport: 'generateContent' });
  assert.equal(usage.inputTokens, 80);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cachedTokens, 15);
  assert.equal(usage.toolUseTokens, 7);
  assert.equal(usage.thoughtTokens, 3);
  assert.equal(usage.totalTokens, 110);
  assert.equal(usage.searchCalls, 1);
});

test('usage telemetry merges multiple provider calls additively', () => {
  const merged = mergeProviderUsage([
    normalizeGeminiUsage({ usage: { total_input_tokens: 100, total_output_tokens: 20 } }, { transport: 'interactions' }),
    normalizeGeminiUsage({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 } }, { transport: 'generateContent' }),
  ]);
  assert.equal(merged.providerCalls, 2);
  assert.equal(merged.inputTokens, 150);
  assert.equal(merged.outputTokens, 30);
  assert.equal(merged.totalTokens, 180);
  assert.match(merged.transport, /interactions/);
  assert.match(merged.transport, /generateContent/);
});

test('usage telemetry remains observational and preserves the phone quality path', () => {
  assert.match(integrated, /apiUsage/);
  assert.match(integrated, /normalizeGeminiUsage/);
  assert.match(integrated, /mergeProviderUsage/);
  assert.match(telephony, /api_usage/);
  assert.match(telephony, /tts_usage/);
  assert.match(telephony, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(telephony, /streamPcmu20ms\(audio\.bytes/);
  assert.doesNotMatch(telephony, /bidirectionalMode=\"mp3\"/);
});
