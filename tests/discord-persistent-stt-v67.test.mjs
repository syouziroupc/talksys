import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord bridge opens a fresh realtime STT websocket for every utterance', () => {
  assert.match(source, /function acquireRealtimeSttSocket\(userId, sessionEpoch\)/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'fresh-utterance'\)/);
  assert.match(source, /reusable=false/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'utterance-complete'\)/);
  assert.doesNotMatch(source, /websocket reuse user=/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ type: 'KeepAlive' \}\)/);
});

test('Finalize flushes the current utterance but the socket is not reused afterward', () => {
  assert.match(source, /JSON\.stringify\(\{ type: 'Finalize' \}\)/);
  assert.match(source, /payload\?\.from_finalize/);
  assert.match(source, /complete\('from-finalize'\)/);
  assert.match(source, /detachWsListeners\(\)/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'utterance-complete'\)/);
});

test('broken realtime STT still fails over to batch STT and backs off on 429', () => {
  assert.match(source, /destroyReusableSttSocket\(userId, 'realtime-failed'\)/);
  assert.match(source, /realtimeSttBackoffUntil = Date\.now\(\) \+ 60_000/);
  assert.match(source, /batchTranscribePcm16\(pcm16, realtimeFailureReason \|\| reason\)/);
  assert.match(source, /markRealtimeFailed\('finalize-timeout'\)/);
});

test('voice disconnect closes any current STT socket and exposes a versioned recovery revision', () => {
  assert.match(source, /for \(const userId of \[\.\.\.realtimeSttSockets\.keys\(\)\]\)/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'voice-disconnect'\)/);
  assert.match(source, /const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v70-reply-recovery-r1'/);
});
