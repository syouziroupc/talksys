import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTalkmanRuntimeR7Source, TALKMAN_RUNTIME_R7_REVISION } from '../discord-voice-smoke/src/build-talkman-runtime-r7.mjs';
import { fastReaction } from '../src/voice-fast-reaction.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const basePath = path.join(repoRoot, 'discord-voice-smoke', 'src', 'index-classic-base.mjs');
const base = fs.readFileSync(basePath, 'utf8');
const generated = buildTalkmanRuntimeR7Source(base);

test('R7 builder preserves R6 hardening and marks no-wait runtime', () => {
  assert.equal(TALKMAN_RUNTIME_R7_REVISION, 'talkman-group-v1-hardening-r7-no-wait-cues');
  assert.match(generated, /talksys-discord-bridge-v92-resilience-r5-talkman-v1-r7/);
  assert.match(generated, /MAX_DISCORD_LOG_PENDING = 240/);
  assert.match(generated, /exportRuntimeLogsZip/);
  assert.match(generated, /name: 'logclear'/);
});

test('non-terminal realtime filler reactions are never played', () => {
  assert.match(generated, /if \(!reaction\?\.terminal\) \{/);
  assert.match(generated, /REACTION-SKIP/);
  assert.match(generated, /non-terminal filler disabled/);
  assert.doesNotMatch(generated, /REACTION-DEFER/);
});

test('pre-answer wait cue is a no-op', () => {
  assert.match(generated, /done: Promise\.resolve\(false\)/);
  assert.match(generated, /stop\(\) \{\}/);
  assert.doesNotMatch(generated, /const searchDelayMs = 1100/);
  assert.doesNotMatch(generated, /purpose: searchCue \? 'search-progress'/);
  assert.doesNotMatch(generated, /finishForAnswer\('final-answer-ready'\)/);
});

test('terminal social replies remain available while ordinary filler is suppressed by runtime', () => {
  const greeting = fastReaction('こんにちは');
  assert.equal(greeting.terminal, true);
  assert.equal(greeting.shouldSpeak, true);

  const lookup = fastReaction('別府市の今日の天気は？');
  assert.equal(lookup.terminal, false);
  assert.equal(lookup.shouldSpeak, true);
  assert.equal(lookup.kind, 'lookup');
});

test('generated R7 runtime passes node syntax check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talksys-r7-'));
  const file = path.join(dir, 'runtime.mjs');
  fs.writeFileSync(file, generated, 'utf8');
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
});
