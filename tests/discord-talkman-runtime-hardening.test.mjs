import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTalkmanRuntimeSource } from '../discord-voice-smoke/src/build-talkman-runtime.mjs';

const sourcePath = path.resolve('discord-voice-smoke/src/index.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');

test('hardened TalkMan runtime is parseable and leaves stable source untouched', () => {
  const before = fs.readFileSync(sourcePath, 'utf8');
  const built = buildTalkmanRuntimeSource(before);
  const after = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(after, before);

  const tmp = path.join(os.tmpdir(), `talkman-hardening-${process.pid}.mjs`);
  fs.writeFileSync(tmp, built, 'utf8');
  try {
    const checked = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('TalkMan strips assistant-like wait phrases and keeps TalkMan identity', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /function normalizeTalkmanAnswer/);
  assert.match(built, /replace\(\/フォーンズ\/g, 'トークマン'\)/);
  assert.match(built, /確認してお答えします/);
  assert.match(built, /司会者、案内係、サポート窓口ではなく、VCに一人混ざっている参加者/);
  assert.match(built, /自分の名前を言う必要があるときはTalkMan/);
});

test('mode switch renews session only when reset cleared it', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /if \(modeChanged && !discordSessionId\)/);
  assert.match(built, /mode-switch renewed/);
});

test('classic TalkSys and TalkMan group queue behavior both remain present', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /name: 'talksys'/);
  assert.match(built, /name: 'talkman'/);
  assert.match(built, /enqueueTalkmanTurn\(nextTurn\)/);
  assert.match(built, /TALKMAN_QUEUE_LIMIT = 12/);
  assert.match(built, /conversationMode !== 'talkman' && answering && captureMetrics\?\.overlappedBotPlayback/);
  assert.match(built, /conversationMode !== 'talkman' && !timeline\.fastReactionRequestedAt/);
});
