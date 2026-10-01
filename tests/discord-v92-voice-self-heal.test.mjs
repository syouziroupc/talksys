import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('desired voice target survives ordinary resets and leave clears it', () => {
  assert.match(source, /let desiredVoiceTarget = null/);
  assert.match(source, /function destroyVoiceConnection\(\{ clearIntent = false \} = \{\}\)/);
  assert.match(source, /if \(clearIntent\) desiredVoiceTarget = null/);
  assert.match(source, /destroyVoiceConnection\(\{ clearIntent: true \}\)/);
});

test('destroyed and non-rejoinable voice states create a fresh connection', () => {
  assert.match(source, /function scheduleFullReconnect/);
  assert.match(source, /forceReconnectDesiredVoice/);
  assert.match(source, /scheduleFullReconnect\('destroyed'\)/);
  assert.match(source, /scheduleFullReconnect\('non-rejoin-close-' \+ code\)/);
  assert.match(source, /await connectToVoiceChannel\(channel, target\.initialUserId, \{ suppressGreeting: true \}\)/);
});

test('health watchdog repairs missing or wrong voice connection', () => {
  assert.match(source, /health-missing-connection/);
  assert.match(source, /health-channel-mismatch/);
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*\}, 10_000\)/);
});
