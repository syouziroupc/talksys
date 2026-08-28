import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

test('voice routes casual chat to Llama 3B and grounded facts to Qwen', () => {
  assert.match(source, /CASUAL_VOICE_MODEL\s*=\s*'@cf\/meta\/llama-3\.2-3b-instruct'/);
  assert.match(source, /GROUNDED_VOICE_MODEL\s*=\s*'@cf\/qwen\/qwen3\.8-27b'/);
  assert.match(source, /await\s+this\.env\.AI\.run\(\s*CASUAL_VOICE_MODEL/);
  assert.match(source, /await\s+this\.env\.AI\.run\(\s*GROUNDED_VOICE_MODEL/);
});

test('casual path uses a short prompt and small completion budget', () => {
  assert.match(source, /CASUAL_SYSTEM_PROMPT/);
  assert.match(source, /max_tokens:\s*96/);
  assert.match(source, /casualPrompt:\s*'short'/);
});

test('grounded calls explicitly disable reasoning', () => {
  assert.match(source, /reasoning_effort:\s*null/);
  assert.match(source, /enable_thinking:\s*false/);
  assert.match(source, /clear_thinking:\s*true/);
});

test('grounded prompt forbids unsupported external and screen claims', () => {
  assert.match(source, /検索結果にない事実は補完しない/);
  assert.match(source, /実際に行っていないPC操作/);
  assert.match(source, /現在画面を断定できるのは/);
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

test('voice health exposes fast grounded v8 search', () => {
  assert.match(source, /VOICE_REVISION\s*=\s*'fast-grounded-v8'/);
  assert.match(source, /webSearch:\s*true/);
  assert.match(source, /webSearchEngine:\s*'wikipedia\+bing-html\+google-news'/);
  assert.match(source, /searchRelevanceFilter:\s*true/);
});
