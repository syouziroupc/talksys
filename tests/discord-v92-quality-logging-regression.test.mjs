import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const reactionSource = fs.readFileSync(new URL('../src/voice-fast-reaction.js', import.meta.url), 'utf8');

test('dedicated Discord logging is persistent, append-only, and secret-redacted', () => {
  assert.match(source, /discord-log-channel\.txt/);
  assert.match(source, /persistRuntimeLogChannelId\(channel\.id\)/);
  assert.match(source, /await restoreRuntimeLogChannel\(\)/);
  assert.match(source, /discordLogQueue/);
  assert.match(source, /runtimeLogChannel\.send/);
  assert.doesNotMatch(source, /runtimeLogMessage\.edit/);
  assert.match(source, /\[redacted\]/);
  assert.match(source, /installConsoleMirror\(\)/);
});

test('fast reaction uses shared local classifier at capture finalization without HTTP round trip', () => {
  assert.match(source, /const reaction = fastReaction\(value\)/);
  assert.match(source, /triggerWebFastReaction\(realtimeHelper, realtimeTranscript, 'capture-finalize'\)/);
  assert.match(source, /active\.startedDuringBotPlayback && !active\.bargeInTriggered/);
});

test('barge-in mismatch rescues meaningful realtime transcript instead of blind drop', () => {
  assert.match(source, /function rescueBargeInTranscriptFromRealtime/);
  assert.match(source, /barge-in-realtime-rescue/);
  assert.match(source, /STT-RESCUE/);
});

test('pure greeting and thanks are terminal voice reactions', () => {
  assert.match(reactionSource, /kind: 'greeting'[\s\S]*terminal: true/);
  assert.match(reactionSource, /kind: 'thanks'[\s\S]*terminal: true/);
  assert.match(source, /fastReaction\?\.terminal && fastReaction\?\.shouldSpeak/);
  assert.match(source, /mirrorRuntimeLog\('TERMINAL'/);
});
