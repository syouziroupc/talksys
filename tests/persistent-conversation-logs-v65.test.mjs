import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const logger = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');
const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('current integrated entry persists every successful and failed TalkSys turn asynchronously', () => {
  assert.match(integrated, /persistTalkLog/);
  assert.match(integrated, /scheduleConversationLog/);
  assert.match(integrated, /ctx\?\.waitUntil/);
  assert.match(integrated, /runTalkSysTurn\(request, env, body, request\.signal, ctx\)/);
  assert.match(integrated, /'turn-error'/);
});

test('unified conversation log schema is self-healing and stores readable user and assistant text', () => {
  assert.match(logger, /CREATE TABLE IF NOT EXISTS conversation_logs/);
  assert.match(logger, /user_text TEXT/);
  assert.match(logger, /result_json TEXT/);
  assert.match(logger, /assistantText:clean\(result\?\.answer\|\|result\?\.text/);
  assert.match(logger, /channel:clean\(body\?\.channel/);
});

test('private conversation log reader requires a bearer token', () => {
  assert.match(integrated, /conversationLogAuthorized/);
  assert.match(integrated, /TALKSYS_LOG_ADMIN_TOKEN/);
  assert.match(integrated, /TELEPHONY_ADMIN_TOKEN/);
  assert.match(integrated, /DISCORD_BRIDGE_TOKEN/);
  assert.match(integrated, /\/api\/conversation-logs/);
  assert.match(wrangler, /"binding"\s*:\s*"TALKSYS_LOG_DB"/);
});

test('phone turns reuse the Telnyx call id as the unified TalkSys session id', () => {
  assert.match(telephony, /sessionId: clean\(sessionId, 200\)/);
  assert.match(telephony, /spokenBackchannel, callId/);
  assert.match(telephony, /channel: 'phone'/);
});
