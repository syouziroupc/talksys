import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildTalkmanRuntimeSource,
  buildTalkmanRuntimeWithFallback,
  hasTalkmanWorkingTreeMarkers,
} from '../discord-voice-smoke/src/build-talkman-runtime.mjs';

const sourcePath = path.resolve('discord-voice-smoke/src/index.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const sourceLf = source.replace(/\r\n?/g, '\n');

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

test('TalkMan uses a compact sharp persona and final-answer guard', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /function normalizeTalkmanAnswer/);
  assert.match(built, /replace\(\/フォーンズ\/g, 'トークマン'\)/);
  assert.match(built, /原則1文45字以内/);
  assert.match(built, /VC参加者として即答/);
  assert.match(built, /待ち文句・司会口調・丁寧な締め・長い一般論は禁止/);
  assert.doesNotMatch(built, /このモードは複数人の雑談用です/);
  assert.doesNotMatch(built, /通常は1文から3文で短く返してください/);
});

test('mode switch renews session only when reset cleared it', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /if \(modeChanged && !discordSessionId\)/);
  assert.match(built, /mode-switch renewed/);
});

test('TalkMan reactions are local, cached and enabled while Whisper stays authoritative', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /function talkmanFastReaction/);
  assert.match(built, /conversationMode === 'talkman' \? talkmanFastReaction\(value\) : fastReaction\(value\)/);
  assert.match(built, /talkmanTexts = \['お、どうも。'/);
  assert.doesNotMatch(built, /if \(conversationMode === 'talkman'\) return false;/);
  assert.match(built, /final STT: Whisper Large v3 Turbo/);
  assert.match(built, /const stt = await transcribeCapturedUtterance/);
});

test('TalkMan preempts stale answers and coalesces backlog to latest only', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /const TALKMAN_QUEUE_LIMIT = 1/);
  assert.match(built, /pendingTurns\.splice\(0, pendingTurns\.length, nextTurn\)/);
  assert.match(built, /if \(answering && captureMetrics\?\.overlappedBotPlayback\)/);
  assert.doesNotMatch(built, /conversationMode !== 'talkman' && answering && captureMetrics\?\.overlappedBotPlayback/);
  assert.match(built, /TalkMan latest user=/);
  assert.doesNotMatch(built, /TalkMan FIFO user=/);
});

test('TalkMan trims local prompt history and does not persist the directive in history', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /history\.slice\(-\(conversationMode === 'talkman' \? 6 : MAX_HISTORY\)\)/);
  assert.match(built, /TOKEN-PROXY/);
  assert.match(built, /\('\[TM ' \+ talkmanSpeaker \+ '\] ' \+ confirmedTranscript\)/);
  assert.doesNotMatch(built, /commitConversationTurn\(conversationalInput, turn\)/);
});

test('classic TalkSys path remains present and unchanged in mode branches', () => {
  const built = buildTalkmanRuntimeSource(source);
  assert.match(built, /name: 'talksys'/);
  assert.match(built, /name: 'talkman'/);
  assert.match(built, /if \(conversationMode === 'talkman'\) \{/);
  assert.match(built, /else \{\n      if \(pendingTurns\.length === 0\) pendingTurns\.push\(nextTurn\);/);
  assert.match(built, /conversationMode !== 'talkman'\) \{\n        activeWaitCue = startWaitCue/);
});

test('clean classic source builds without fallback', () => {
  const result = buildTalkmanRuntimeWithFallback(source, source);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.reason, '');
  assert.match(result.built, /name: 'talkman'/);
});

test('partially patched activeUserId source falls back to canonical classic base', () => {
  const partial = sourceLf.replace(
    "let activeUserText = '';\nlet activeUserUtteranceId = '';",
    "let activeUserText = '';\nlet activeUserId = '';\nlet activeUserUtteranceId = '';",
  );
  assert.notEqual(partial, sourceLf);
  assert.equal(hasTalkmanWorkingTreeMarkers(partial), true);

  const result = buildTalkmanRuntimeWithFallback(partial, sourceLf);
  assert.equal(result.fallbackUsed, true);
  assert.match(result.reason, /active user id/);
  assert.match(result.built, /name: 'talksys'/);
  assert.match(result.built, /name: 'talkman'/);
  assert.match(result.built, /let activeUserId = '';/);
});

test('ordinary upstream anchor drift is not hidden by canonical fallback', () => {
  const drifted = source.replace(
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5';",
    "const DISCORD_BRIDGE_REVISION = 'unexpected-upstream-revision';",
  );
  assert.equal(hasTalkmanWorkingTreeMarkers(drifted), false);
  assert.throws(
    () => buildTalkmanRuntimeWithFallback(drifted, source),
    /TalkMan build anchor missing: revision/,
  );
});
