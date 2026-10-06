import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'),
);

test('Discord npm start uses the updater and unified TalkSys/TalkMan runtime', () => {
  const start = String(packageJson.scripts?.start || '');
  assert.match(start, /update-and-start\.ps1/);
  assert.doesNotMatch(start, /node\s+src[\\/]index\.mjs/);
});
