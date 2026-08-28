import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

test('voice onTurn uses the direct Workers AI binding', () => {
  assert.match(source, /await\s+this\.env\.AI\.run\(/);
  assert.doesNotMatch(source, /createWorkersAI/);
  assert.doesNotMatch(source, /streamText\(/);
});

test('voice calls explicitly disable reasoning and reserve answer tokens', () => {
  assert.match(source, /reasoning_effort:\s*null/);
  assert.match(source, /enable_thinking:\s*false/);
  assert.match(source, /clear_thinking:\s*true/);
  assert.match(source, /fastChatInput\([\s\S]*?512,\s*0\.35\)/);
});

test('ordinary conversation skips the screen-decision model call', () => {
  assert.match(source, /function\s+mightNeedScreen/);
  assert.match(source, /if\s*\(mightNeedScreen\(transcript\)\)/);
});

test('voice mirrors finalized assistant text in complete transcript format', () => {
  assert.match(source, /type:\s*'transcript'/);
  assert.match(source, /role:\s*'assistant'/);
  assert.match(source, /text:\s*reply/);
  assert.match(source, /assistantTranscriptCompat:\s*true/);
});

test('voice health exposes direct-binding v5 transport', () => {
  assert.match(source, /llmTransport:\s*'env\.AI\.run'/);
  assert.match(source, /llmThinking:\s*false/);
  assert.match(source, /VOICE_REVISION\s*=\s*'direct-binding-v5'/);
});
