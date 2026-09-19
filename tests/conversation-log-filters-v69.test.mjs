import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const logSource = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('conversation log storage supports indexed event and session filters', () => {
  assert.match(logSource, /idx_conversation_logs_event_time/);
  assert.match(logSource, /export async function listTalkLogs\(env,limit=100,filters=\{\}\)/);
  assert.match(logSource, /session_id = \?/);
  assert.match(logSource, /session_id LIKE \?/);
  assert.match(logSource, /event = \?/);
  assert.match(logSource, /user_text LIKE \?/);
});

test('private conversation log endpoint exposes bounded filter parameters', () => {
  assert.match(server, /sessionId: url\.searchParams\.get\('sessionId'\) \|\| ''/);
  assert.match(server, /sessionPrefix: url\.searchParams\.get\('sessionPrefix'\) \|\| ''/);
  assert.match(server, /event: url\.searchParams\.get\('event'\) \|\| ''/);
  assert.match(server, /q: url\.searchParams\.get\('q'\) \|\| ''/);
  assert.match(server, /listTalkLogs\(env, limit, filters\)/);
  assert.match(server, /conversationLogAuthorized\(request, env\)/);
});
