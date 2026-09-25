import test from 'node:test';
import assert from 'node:assert/strict';
import { TALK_CLIENT_V45, __test } from '../src/talk-client-v45.js';

test('web v108 bounds every network wait used by voice turns', () => {
  assert.equal(__test.boundedHttp, true);
  assert.match(TALK_CLIENT_V45, /WEB_HTTP_BUDGETS=Object\.freeze\(\{fastReaction:2500,searchPreface:3000,transcribe:30000,turn:35000\}\)/);
  assert.match(TALK_CLIENT_V45, /fetchJsonWithDeadline\('\/api\/transcribe'/);
  assert.match(TALK_CLIENT_V45, /fetchJsonWithDeadline\('\/api\/turn'/);
  assert.match(TALK_CLIENT_V45, /fetchJsonWithDeadline\('\/api\/search-preface'/);
  assert.match(TALK_CLIENT_V45, /fetchJsonWithDeadline\('\/api\/fast-reaction'/);
});

test('web v108 prevents indefinite device TTS waits', () => {
  assert.equal(__test.deviceTtsWatchdog, true);
  assert.match(TALK_CLIENT_V45, /端末日本語TTSタイムアウト/);
  assert.match(TALK_CLIENT_V45, /speechSynthesis\.cancel/);
  assert.match(TALK_CLIENT_V45, /Math\.min\(30000/);
});

test('web v108 reconnects realtime STT without blocking Whisper fallback', () => {
  assert.equal(__test.realtimeSttReconnect, true);
  assert.match(TALK_CLIENT_V45, /realtimeReconnectTimer=setTimeout/);
  assert.match(TALK_CLIENT_V45, /if\(micOn&&!realtimeSttSocket\)openRealtimeStt\(\)/);
  assert.match(TALK_CLIENT_V45, /Whisper確定へフォールバック/);
});
