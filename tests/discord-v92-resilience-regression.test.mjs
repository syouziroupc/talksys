import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fastReaction, isIgnorableSttFailure } from '../src/voice-fast-reaction.js';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const supervisor = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
const integratedEntry = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('receiver does not re-subscribe after empty transport end', () => {
  const block = source.slice(source.indexOf('function startReceiverSession('), source.indexOf('function destroyVoiceConnection('));
  assert.match(block, /if \(!pcm\.length\) \{/);
  assert.doesNotMatch(block, /queueMicrotask\(\(\) => \{[\s\S]*?startReceiverSession\(userId, false\)/);
  assert.match(source, /startReceiverSession\(userId, true, \{ startedDuringBotPlayback \}\)/);
});

test('voice health includes the real voice connection status', () => {
  assert.match(source, /const voiceStatus = connection\?\.state\?\.status \|\| 'none'/);
  assert.match(source, /voice=\$\{voiceStatus\}/);
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


test('Whisper hallucination guard failures can never be promoted from Nova realtime text', () => {
  assert.equal(isIgnorableSttFailure('stt_http_422: {"error":"hallucinated transcript rejected","rejected":"hallucination-guard"}'), false);
  assert.equal(isIgnorableSttFailure('stt_http_422: {"error":"no speech detected","rejected":"empty-transcript"}'), true);
  assert.equal(isIgnorableSttFailure('weak-speech-signal'), true);
  const block = source.slice(source.indexOf('async function handleCapturedUtterance('), source.indexOf('function interruptActiveAnswer('));
  assert.match(block, /if \(isIgnorableSttFailure\(message\)\)/);
  assert.match(block, /correctionReason: 'realtime-rescue-after-whisper-failure'/);
});

test('Discord supervisor keeps an OS-level single-instance lock', () => {
  assert.match(supervisor, /talksys-discord-supervisor\.lock/);
  assert.match(supervisor, /\[System\.IO\.FileShare\]::None/);
  assert.match(supervisor, /singleton lock acquired pid=\$PID/);
  assert.match(supervisor, /duplicate start refused/);
});

test('Discord runtime logs process and interaction identity and uses current interaction APIs', () => {
  assert.match(source, /MessageFlags\.Ephemeral/);
  assert.match(source, /client\.once\('clientReady'/);
  assert.match(source, /received id=\$\{interaction\.id\} pid=\$\{process\.pid\}/);
  assert.match(source, /process start pid=\$\{process\.pid\} node=\$\{process\.version\}/);
  assert.doesNotMatch(source, /deferReply\(\{ ephemeral: true \}\)/);
});

test('Discord voice metrics carry and persist the exact bridge revision', () => {
  const clientBlock = source.slice(source.indexOf('async function postVoiceMetrics('), source.indexOf('async function postVoiceStage('));
  assert.match(clientBlock, /bridgeRevision: DISCORD_BRIDGE_REVISION/);
  const serverStart = integratedEntry.indexOf('function discordVoiceMetricsResponse(');
  const serverEnd = integratedEntry.indexOf('\nfunction ', serverStart + 10);
  const serverBlock = integratedEntry.slice(serverStart, serverEnd);
  assert.match(serverBlock, /const bridgeRevision = compact\(body\?\.bridgeRevision \|\| '', 160\)/);
  assert.match(serverBlock, /route: 'discord-client-metrics',[\s\S]*bridgeRevision,[\s\S]*search: false/);
});


test('health watchdog keeps 10s recovery checks but logs only connection-state changes', () => {
  assert.match(source, /healthSignature !== lastHealthLogSignature/);
  assert.match(source, /voiceStatus,[\s\S]*voiceChannel,[\s\S]*desiredChannel/);
  assert.doesNotMatch(source, /DISCORD_HEALTH_LOG_INTERVAL_MS/);
  assert.doesNotMatch(source, /summaryDue/);
  assert.doesNotMatch(source, /healthSignature = \[[\s\S]{0,220}answering/);
  assert.match(source, /if \(healthChanged\)/);
  assert.match(source, /scheduleFullReconnect\(missing \? 'health-missing-connection' : 'health-channel-mismatch'\)/);
  assert.match(source, /\}, 10_000\);/);
});


test('Windows TTS cannot wait forever after timeout or abort kill request', () => {
  assert.match(source, /const hardClosePromise = new Promise/);
  assert.match(source, /requestChildStop\('tts-timeout-8000ms'\)/);
  assert.match(source, /requestChildStop\('abort'\)/);
  assert.match(source, /windows_tts_hard_close_timeout/);
  assert.match(source, /Promise\.race\(\[childDone, hardClosePromise\]\)/);
  assert.match(source, /hardCloseTimer = setTimeout\([\s\S]*5000\)/);
});


test('playback start failure cancels completion waiters on the shared AudioPlayer', () => {
  assert.match(source, /let cancelCompletionWait = \(\) => \{\}/);
  assert.match(source, /completionPromise\.catch\(\(\) => \{\}\)/);
  assert.match(source, /cancelCompletionWait\(\);[\s\S]*ffmpeg\.kill\('SIGKILL'\)[\s\S]*player\.stop\(true\)[\s\S]*playback_start_timeout/);
  assert.match(source, /player\.off\(AudioPlayerStatus\.Idle, done\)/);
  assert.match(source, /player\.off\('error', fail\)/);
});

test('receiver close clears stale TalkSys sessions immediately', () => {
  assert.match(source, /opus\.on\('close', \(\) => \{/);
  assert.match(source, /AudioReceiveStream closed before finalize/);
  assert.match(source, /finalize\('discord-transport-close'\)/);
  assert.match(source, /sessions\.delete\(userId\)/);
});


test('full voice reconnect cannot hang forever resolving Discord targets', () => {
  assert.match(source, /async function promiseWithTimeout/);
  assert.match(source, /voice_reconnect_target_resolve_timeout/);
  assert.match(source, /client\.guilds\.cache\.get\(target\.guildId\)/);
  assert.match(source, /guild\.channels\.cache\.get\(target\.channelId\)/);
  assert.match(source, /VOICE_REJOIN_TIMEOUT_MS/);
  assert.match(source, /finally \{[\s\S]*fullReconnectInFlight = false/);
});
