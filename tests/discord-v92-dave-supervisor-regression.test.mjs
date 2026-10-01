import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'));

test('V92 Discord bridge enables required DAVE voice negotiation', () => {
  assert.equal(packageJson.dependencies['@discordjs/voice'], '0.19.2');
  assert.doesNotMatch(source, /daveEncryption:\s*false/);
  assert.match(source, /dave=enabled/);
});

test('Discord bridge package accepts current supported Node runtimes', () => {
  assert.equal(packageJson.engines.node, '>=22.12.0');
});

test('Supervisor does not kill a rollback runtime that never emitted heartbeat', () => {
  assert.match(launcher, /\$heartbeatSeen = \$false/);
  assert.match(launcher, /\$heartbeatSeen = \$true/);
  assert.match(launcher, /elseif \(\$heartbeatSeen\)/);
  assert.doesNotMatch(launcher, /elseif \(\(\(Get-Date\) - \$startedAt\)\.TotalSeconds -gt 20\)/);
});
