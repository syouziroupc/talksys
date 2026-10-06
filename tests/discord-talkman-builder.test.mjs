import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTalkmanSource } from '../discord-voice-smoke/src/build-talkman.mjs';

const sourcePath = path.resolve('discord-voice-smoke/src/index.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');

test('TalkMan builder leaves the checked-in stable bridge untouched and creates a parseable variant', () => {
  const before = fs.readFileSync(sourcePath, 'utf8');
  const built = buildTalkmanSource(before);
  const after = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(after, before);
  assert.notEqual(built, before);

  const tmp = path.join(os.tmpdir(), `talkman-check-${process.pid}.mjs`);
  fs.writeFileSync(tmp, built, 'utf8');
  try {
    const checked = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('TalkMan variant registers /talkman while retaining /talksys', () => {
  const built = buildTalkmanSource(source);
  assert.match(built, /name: 'talksys'/);
  assert.match(built, /name: 'talkman'/);
  assert.match(built, /interaction\.commandName === 'talksys' \|\| interaction\.commandName === 'talkman'/);
  assert.match(built, /requestedMode = interaction\.commandName === 'talkman' \? 'talkman' : 'talksys'/);
});

test('TalkMan keeps speaker-attributed FIFO turns without changing classic latest-only queue behavior', () => {
  const built = buildTalkmanSource(source);
  assert.match(built, /enqueueTalkmanTurn\(nextTurn\)/);
  assert.match(built, /TALKMAN_QUEUE_LIMIT = 12/);
  assert.match(built, /sameSpeakerIndex/);
  assert.match(built, /if \(pendingTurns\.length === 0\) pendingTurns\.push\(nextTurn\);\n      else pendingTurns\[0\] = nextTurn;/);
  assert.match(built, /conversationMode !== 'talkman' \|\| String\(activeUserId/);
  assert.match(built, /conversationMode !== 'talkman' \|\| String\(item\?\.userId/);
});

test('TalkMan disables chatter cues and generic overlap preemption but preserves explicit stop policy', () => {
  const built = buildTalkmanSource(source);
  assert.match(built, /if \(conversationMode === 'talkman'\) return false;\n  const active = helper\?\.active;/);
  assert.match(built, /conversationMode !== 'talkman' && answering && captureMetrics\?\.overlappedBotPlayback/);
  assert.match(built, /if \(policy\.action === 'interrupt'\)/);
  assert.match(built, /interruptActiveAnswer\('explicit-user-stop'\)/);
});

test('TalkMan sends speaker identity and humor policy only in TalkMan mode', () => {
  const built = buildTalkmanSource(source);
  assert.match(built, /buildTalkmanInput\(confirmedTranscript, talkmanSpeaker\)/);
  assert.match(built, /const conversationalInput = conversationMode === 'talkman'/);
  assert.match(built, /軽いツッコミ、言葉遊び、直前の話題へのコールバック/);
  assert.match(built, /質問、事実確認、安全に関わる話ではユーモアより正確さを優先/);
  assert.match(built, /const turn = await talk\(conversationalInput/);
  assert.match(built, /commitConversationTurn\(conversationalInput, turn\)/);
});

test('TalkMan builder accepts LF and CRLF source text', () => {
  const lf = source.replace(/\r\n?/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const builtLf = buildTalkmanSource(lf);
  const builtCrlf = buildTalkmanSource(crlf);
  assert.equal(builtCrlf, builtLf);
  assert.match(builtCrlf, /name: 'talkman'/);
});
