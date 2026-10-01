import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fastReaction } from '../src/voice-fast-reaction.js';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const supervisor = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');

test('receiver does not re-subscribe after empty transport end', () => {
  const block = source.slice(source.indexOf('function startReceiverSession('), source.indexOf('function destroyVoiceConnection('));
  assert.match(block, /if \(!pcm\.length\) \{/);
  assert.doesNotMatch(block, /queueMicrotask\(\(\) => \{[\s\S]*?startReceiverSession\(userId, false\)/);
  assert.match(source, /startReceiverSession\(userId, true, \{ startedDuringBotPlayback \}\)/);
});

test('voice health includes the real voice connection status', () => {
  assert.match(source, /voice=\$\{connection\?\.state\?\.status \|\| 'none'\}/);
  assert.match(source, /captures=\$\{sessions\.size\}/);
});

test('signalling and connecting stalls trigger bounded recovery', () => {
  assert.match(source, /VOICE-STALLED/);
  assert.match(source, /VoiceConnectionStatus\.Connecting, VoiceConnectionStatus\.Signalling/);
  assert.match(source, /scheduleRecovery\('nonready-timeout'\)/);
  assert.match(source, /Math\.min\(30_000/);
  assert.match(source, /\[4014, 4021, 4022\]/);
});

test('stalled event loop and stage operation have supervisor heartbeat', () => {
  assert.match(source, /TALKSYS_BRIDGE_HEARTBEAT_FILE/);
  assert.match(source, /writeBridgeHeartbeat\(\)/);
  assert.match(source, /startBridgeMonitors\(\)/);
  assert.match(source, /beginWatchStage\(\`stt:/);
  assert.match(source, /beginWatchStage\(\`turn:/);
  assert.match(source, /beginWatchStage\(\`tts:/);
  assert.match(source, /stageDeadlineMs: stage\?\.deadlineMs/);
  assert.match(supervisor, /heartbeat stale/);
  assert.match(supervisor, /blocking pipeline stage stuck/);
});

test('API route errors record status and timeout separately', () => {
  assert.match(source, /mirrorRuntimeLog\('API-ERROR'/);
  assert.match(source, /mirrorRuntimeLog\(kind, \`\$\{label\} reason=/);
  assert.match(source, /API-CANCEL/);
  assert.match(source, /http=\$\{response\.status\}/);
});

test('failed Discord log sends retain their batch and retry with backoff', () => {
  const block = source.slice(source.indexOf('async function flushRuntimeLogQueue('), source.indexOf('function mirrorRuntimeLog('));
  const sent = block.indexOf('await runtimeLogChannel.send(');
  const removed = block.indexOf('discordLogQueue.splice(0, batch.count)');
  assert.ok(sent >= 0 && removed > sent);
  assert.match(block, /discordLogSendFailCount \+= 1/);
  assert.match(block, /Math\.min\(60_000/);
  assert.doesNotMatch(block, /while \(runtimeLogChannel && discordLogQueue.length\)/);
});

test('private log dump is an attachment and includes rotated file', () => {
  assert.match(source, /new AttachmentBuilder\(data, \{ name: filename \}\)/);
  assert.match(source, /discordLogPreviousFile, discordLogFile/);
  assert.match(source, /interaction\.commandName === 'logdump'/);
  assert.match(source, /owner !== interaction\.user\.id/);
});

test('log sanitizer redacts keys and bearer tokens', () => {
  const block = source.slice(source.indexOf('function sanitizeLogText('), source.indexOf('function persistRuntimeLogChannelId('));
  const sanitize = vm.runInNewContext(block + '\nsanitizeLogText', {});
  assert.match(sanitize('{"token":"abcdefghijklmnopqrstuvwxyz"}'), /\[redacted\]/);
  assert.match(sanitize('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /\[redacted\]/);
});

test('barge-in rescue recalculates terminal greeting/thanks classification', () => {
  assert.equal(fastReaction('ありがとうございました').terminal, true);
  assert.equal(fastReaction('今フランスは何時ですか').terminal, false);
  const block = source.slice(source.indexOf('async function processConfirmedTranscript('), source.indexOf('async function handleCapturedUtterance('));
  assert.match(block, /reaction = fastReaction\(realtimeRescue\)/);
  assert.match(block, /if \(reaction\?\.terminal && reaction\?\.shouldSpeak\)/);
});
