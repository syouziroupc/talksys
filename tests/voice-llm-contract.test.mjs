import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

test('voice onTurn uses the direct Workers AI binding', () => {
  assert.match(source, /await\s+this\.env\.AI\.run\(TEXT_MODEL/);
  assert.doesNotMatch(source, /createWorkersAI/);
  assert.doesNotMatch(source, /streamText\(/);
});

test('voice onTurn returns a non-empty cleaned string', () => {
  assert.match(source, /cleanSpeechText\(extractText\(result\)\)/);
  assert.match(source, /return\s+reply\s*;/);
});

test('voice health exposes direct-binding transport', () => {
  assert.match(source, /llmTransport:\s*'env\.AI\.run'/);
  assert.match(source, /llmStreaming:\s*false/);
  assert.match(source, /VOICE_REVISION\s*=\s*'direct-binding-v3'/);
});
