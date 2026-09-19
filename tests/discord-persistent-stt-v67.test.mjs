import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord bridge reuses one realtime STT websocket per user across utterances', () => {
  assert.match(source, /const realtimeSttSockets = new Map\(\)/);
  assert.match(source, /function acquireRealtimeSttSocket\(userId, sessionEpoch\)/);
  assert.match(source, /websocket reuse user=/);
  assert.match(source, /reusedSocket = acquired\.reused/);
  assert.doesNotMatch(source, /try \{ ws\?\.close\(1000, 'utterance-complete'\); \} catch \{\}/);
});

test('idle reusable STT sockets stay alive without sending synthetic audio', () => {
  assert.match(source, /setInterval\(\(\) => \{/);
  assert.match(source, /Date\.now\(\) - transport\.lastAudioAt < 3000/);
  assert.match(source, /JSON\.stringify\(\{ type: 'KeepAlive' \}\)/);
  assert.match(source, /\}, 4000\)/);
});

test('Finalize ends only the utterance while preserving a healthy websocket', () => {
  assert.match(source, /JSON\.stringify\(\{ type: 'Finalize' \}\)/);
  assert.match(source, /payload\?\.from_finalize/);
  assert.match(source, /complete\('from-finalize'\)/);
  assert.match(source, /detachWsListeners\(\)/);
  assert.match(source, /sessions\.delete\(userId\)/);
});

test('broken reusable sockets still fail over to batch STT and back off on 429', () => {
  assert.match(source, /destroyReusableSttSocket\(userId, 'realtime-failed'\)/);
  assert.match(source, /realtimeSttBackoffUntil = Date\.now\(\) \+ 60_000/);
  assert.match(source, /batchTranscribePcm16\(pcm16, realtimeFailureReason \|\| reason\)/);
  assert.match(source, /markRealtimeFailed\('finalize-timeout'\)/);
});

test('voice disconnect closes idle reusable sockets and exposes a versioned bridge revision', () => {
  assert.match(source, /for \(const userId of \[\.\.\.realtimeSttSockets\.keys\(\)\]\)/);
  assert.match(source, /destroyReusableSttSocket\(userId, 'voice-disconnect'\)/);
  assert.match(source, /const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v[0-9]+-[^']+'/);
});
