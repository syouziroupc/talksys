import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

test('voice onTurn uses direct Workers AI with Qwen 3.8', () => {
  assert.match(source, /VOICE_TEXT_MODEL\s*=\s*'@cf\/qwen\/qwen3\.8-27b'/);
  assert.match(source, /await\s+this\.env\.AI\.run\(\s*VOICE_TEXT_MODEL/);
  assert.doesNotMatch(source, /createWorkersAI/);
  assert.doesNotMatch(source, /streamText\(/);
});

test('voice calls explicitly disable reasoning for low-latency conversation', () => {
  assert.match(source, /reasoning_effort:\s*null/);
  assert.match(source, /enable_thinking:\s*false/);
  assert.match(source, /clear_thinking:\s*true/);
  assert.match(source, /fastChatInput\([\s\S]*?420,\s*0\.45\)/);
});

test('system prompt supports casual chat and forbids invented screen claims', () => {
  assert.match(source, /普通の日常会話、雑談、相談、挨拶/);
  assert.match(source, /何でもPC操作の話に結び付けない/);
  assert.match(source, /現在のPC画面について/);
  assert.match(source, /画面内容を想像しない/);
  assert.match(source, /実際に行っていないPC操作/);
});

test('ordinary conversation skips the screen-decision model call', () => {
  assert.match(source, /function\s+mightNeedScreen/);
  assert.match(source, /if\s*\(mightNeedScreen\(transcript\)\)/);
});

test('voice mirrors finalized assistant text in complete transcript format', () => {
  assert.match(source, /type:\s*'transcript'/);
  assert.match(source, /role:\s*'assistant'/);
  assert.match(source, /text:\s*reply/);
});

test('voice health exposes grounded chat v6 and TTS fallback', () => {
  assert.match(source, /VOICE_REVISION\s*=\s*'grounded-chat-v6'/);
  assert.match(source, /casualConversation:\s*true/);
  assert.match(source, /groundedScreenClaims:\s*true/);
  assert.match(source, /deviceTtsFallback:\s*true/);
  assert.match(source, /ttsRetries:\s*3/);
});
