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

test('R7 builder preserves R6 hardening and marks R7 runtime', () => {
  assert.equal(TALKMAN_RUNTIME_R7_REVISION, 'talkman-group-v1-hardening-r7-search-progress');
  assert.match(generated, /talksys-discord-bridge-v92-resilience-r5-talkman-v1-r7/);
  assert.match(generated, /MAX_DISCORD_LOG_PENDING = 240/);
  assert.match(generated, /exportRuntimeLogsZip/);
  assert.match(generated, /name: 'logclear'/);
});

test('lookup reactions are deferred until confirmed search progress', () => {
  assert.match(generated, /reaction\?\.kind === 'lookup' && !reaction\?\.terminal/);
  assert.match(generated, /REACTION-DEFER/);
  assert.match(generated, /lookup waits for confirmed search-progress cue/);
  assert.match(generated, /const searchDelayMs = 1100/);
});

test('answer completion uses soft handoff instead of cutting search progress', () => {
  assert.match(generated, /async finishForAnswer\(reason = 'answer-ready'\)/);
  assert.match(generated, /if \(!playing\) \{/);
  assert.match(generated, /await done\.catch\(\(\) => false\)/);
  assert.match(generated, /if \(finishingWaitCue\) await finishingWaitCue\.finishForAnswer\('final-answer-ready'\)/);
  assert.doesNotMatch(generated, /activeWaitCue\?\.stop\('final-answer-ready'\);/);
  assert.doesNotMatch(generated, /activeFastReaction = null;\n    player\.stop\(true\);/);
});

test('explicit stop still hard-stops an actively playing wait cue', () => {
  assert.match(generated, /stop\(reason = 'user-interrupt'\)/);
  assert.match(generated, /if \(playing\) player\.stop\(true\)/);
});

test('lookup filler phrases stay short', () => {
  for (const text of [
    '別府市の今日の天気は？',
    'CF-SV8の中古価格を調べて',
    '別府駅の時刻を確認して',
    'おすすめの店を探して',
  ]) {
    const reaction = fastReaction(text);
    assert.equal(reaction.kind, 'lookup');
    assert.equal(reaction.shouldSpeak, true);
    assert.ok(reaction.text.length <= 12, `${text}: ${reaction.text}`);
    assert.match(reaction.text, /確認しています|調べています/);
  }
});

test('generated R7 runtime passes node syntax check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talksys-r7-'));
  const file = path.join(dir, 'runtime.mjs');
  fs.writeFileSync(file, generated, 'utf8');
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
});
