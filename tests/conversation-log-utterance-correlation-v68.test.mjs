import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const logSource = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('D1 stored result preserves utterance id alongside channel', () => {
  assert.match(logSource, /utteranceId:clean\(input\?\.body\?\.utteranceId,180\)/);
  assert.match(logSource, /utteranceId:clean\(result\?\.utteranceId,180\)/);
});

test('voice metric endpoint forwards utterance id into conversation logging', () => {
  assert.match(server, /utteranceId: compact\(body\?\.utteranceId, 180\)/);
  assert.match(server, /scheduleConversationLog\(ctx, env, request, logBody, result, 'voice-metrics', 202\)/);
});
