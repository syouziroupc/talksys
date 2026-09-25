import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord Gateway watchdog allows normal guild ready latency', () => {
  assert.match(source, /const DISCORD_READY_TIMEOUT_MS = 60000;/);
  assert.match(source, /client\.on\('shardReady'/);
  assert.match(source, /status=\$\{client\.ws\.status\} ping=\$\{client\.ws\.ping\} guilds=\$\{client\.guilds\.cache\.size\}/);
});
