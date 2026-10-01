import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const LEGACY_DISCORD_REFERENCE_TESTS = new Set([
  'discord-fast-ack-echo-v81.test.mjs',
  'discord-gateway-ready-v106.test.mjs',
  'discord-persistent-stt-v67.test.mjs',
  'discord-stt-correction-barge-v88.test.mjs',
  'discord-voice-smoke.test.mjs',
  'discord-web-adapter-v106.test.mjs',
  'discord-web-audio-adapter-v79.test.mjs',
  'discord-web-parity-v107.test.mjs',
]);

const testsDir = path.resolve('tests');
const all = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

const active = all
  .filter((name) => !LEGACY_DISCORD_REFERENCE_TESTS.has(name))
  .map((name) => path.join('tests', name));

if (!active.length) {
  throw new Error('No active TalkSys tests found');
}

console.log(`[tests] active=${active.length} legacy-discord-reference=${LEGACY_DISCORD_REFERENCE_TESTS.size}`);
console.log('[tests] legacy Discord reference suites are retained in tests/ but are not release gates for the R5 rollback runtime.');

const result = spawnSync(process.execPath, ['--test', ...active], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
