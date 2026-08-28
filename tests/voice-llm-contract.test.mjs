import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

test('voice routes casual chat to fast GLM and grounded facts to Qwen', () => {
  assert.match(source, /CASUAL_VOICE_MODEL\s*=\s*'@cf\/zai-org\/glm-4\.7-flash'/);
  assert.match(source, /GROUNDED_VOICE_MODEL\s*=\s*'@cf\/qwen\/qwen3\.8-27b'/);
  assert.match(source, /const\s+model\s*=\s*searchIntent\s*\?\s*GROUNDED_VOICE_MODEL\s*:\s*CASUAL_VOICE_MODEL/);
  assert.match(source, /await\s+this\.env\.AI\.run\(\s*model/);
});

test('voice calls explicitly disable reasoning for low latency', () => {
  assert.match(source, /reasoning_effort:\s*null/);
  assert.match(source, /enable_thinking:\s*false/);
  assert.match(source, /clear_thinking:\s*true/);
});

test('system prompt supports casual chat and forbids unsupported factual claims', () => {
  assert.match(source, /普通の日常会話、雑談、相談、挨拶/);
  assert.match(source, /何でもPC操作の話に結び付けない/);
  assert.match(source, /\[ウェブ検索結果\]/);
  assert.match(source, /検索結果に無い内容を補完しない/);
  assert.match(source, /画面内容を想像しない/);
  assert.match(source, /実際に行っていないPC操作/);
});

test('screen intent and web search are mutually exclusive', () => {
  assert.match(source, /const\s+screenIntent\s*=\s*mightNeedScreen\(transcript\)/);
  assert.match(source, /const\s+searchIntent\s*=\s*!screenIntent\s*&&\s*needsWebSearch\(transcript\)/);
});

test('cloud TTS is skipped and device ja-JP is production speech path', () => {
  assert.match(source, /beforeSynthesize\(\)\s*\{\s*return null;/);
  assert.match(source, /connectionGreetingTts:\s*false/);
  assert.match(source, /cloudTtsDisabled:\s*true/);
  assert.match(source, /ttsPrimary:\s*'device-ja-JP'/);
});

test('voice mirrors finalized assistant text in complete transcript format', () => {
  assert.match(source, /type:\s*'transcript'/);
  assert.match(source, /role:\s*'assistant'/);
  assert.match(source, /text:\s*reply/);
});

test('voice health exposes grounded search v7', () => {
  assert.match(source, /VOICE_REVISION\s*=\s*'grounded-search-v7'/);
  assert.match(source, /webSearch:\s*true/);
  assert.match(source, /webSearchEngine:\s*'bing-rss'/);
  assert.match(source, /groundedExternalFacts:\s*true/);
});
