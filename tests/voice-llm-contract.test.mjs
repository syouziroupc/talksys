import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

test('voice onTurn uses the AI SDK 7 instructions field', () => {
  assert.match(source, /instructions:\s*VOICE_SYSTEM_PROMPT/);
  assert.doesNotMatch(source, /\bsystem:\s*VOICE_SYSTEM_PROMPT/);
});

test('voice onTurn returns the Cloudflare Voice-supported result.stream', () => {
  assert.match(source, /return\s+result\.stream\s*;/);
  assert.doesNotMatch(source, /return\s+result\.fullStream\s*;/);
});

test('voice health exposes the deployed LLM stream contract', () => {
  assert.match(source, /llmStream:\s*'result\.stream'/);
  assert.match(source, /aiSdkContract:\s*7/);
});
