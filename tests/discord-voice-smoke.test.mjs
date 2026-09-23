import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'));
const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
const setupSecret = fs.readFileSync(new URL('../discord-voice-smoke/setup-bridge-secret.ps1', import.meta.url), 'utf8');
const secretStore = fs.readFileSync(new URL('../discord-voice-smoke/secret-store.ps1', import.meta.url), 'utf8');

test('Discord smoke uses real TalkSys voice paths and never browser-side TTS', () => {
  assert.match(source, /\/api\/realtime-stt/);
  assert.match(source, /\/api\/turn/);
  assert.match(source, /\/api\/voice\/synthesize/);
  assert.doesNotMatch(source, /speechSynthesis|SpeechSynthesisUtterance/);
});

test('Discord bridge uses permanent shared-token auth for verified streaming and TTS', () => {
  assert.match(source, /authorization: 'Bearer ' \+ BRIDGE_TOKEN/);
  assert.doesNotMatch(source, /x-talksys-demo/);
  assert.doesNotMatch(source, /discord-voice-smoke-20260918/);
  assert.match(source, /\/api\/turn-stream/);
  assert.match(source, /async function talkStream\(text, onSentence, utteranceId = '', signal\)/);
  assert.match(source, /queueSentence/);
  assert.match(source, /await playMp3\(prefetched\.value,/);
});

test('Discord receive never echoes the callers raw voice and finalizes buffered short utterances', () => {
  assert.doesNotMatch(source, /playRawPcm48|raw echo playback|Readable\.from/);
  assert.match(source, /sendFinalizeIfReady/);
  assert.match(source, /\[stt\] finalize sent/);
  assert.match(source, /finalize-timeout/);
  assert.doesNotMatch(source, /utterance dropped after realtime\+batch STT/);
  assert.match(source, /no transcript after realtime\+batch; speaking recovery prompt/);
  assert.match(source, /speakRecoveryPrompt\('stt-exhausted', sessionEpoch\)/);
  assert.match(source, /opus=.*pcm48=.*pcm16=/);
});

test('Discord realtime STT rate limits fall back to batch Whisper instead of dropping speech', () => {
  assert.match(source, /batchTranscribePcm16/);
  assert.match(source, /\/api\/transcribe/);
  assert.match(source, /content-type': 'audio\/wav'/);
  assert.match(source, /unexpected-response/);
  assert.match(source, /statusCode === 429/);
  assert.match(source, /function registerRealtimeSttFailure\(reason = 'realtime-failed', statusCode = 0\)/);
  assert.match(source, /Math\.min\(300000, baseMs \* \(2 \*\* Math\.max\(0, realtimeSttFailureCount - 1\)\)\)/);
  assert.match(source, /Date\.now\(\) < realtimeSttBackoffUntil/);
  assert.match(source, /\[stt-fallback\] batch success/);
});

test('Discord keeps PCM16 audio for fallback transcription when realtime STT fails', () => {
  assert.match(source, /const pcm16Chunks = \[\]/);
  assert.match(source, /pcm16Chunks\.push\(Buffer\.from\(pcm16\)\)/);
  assert.match(source, /Buffer\.concat\(pcm16Chunks\)/);
  assert.match(source, /pcm16MonoToWav16k/);
  assert.match(source, /writeUInt32LE\(16000, 24\)/);
});

test('Discord plays only non-answer wait cues while common final answer generation runs', () => {
  assert.match(source, /\/api\/search-preface/);
  assert.match(source, /\/api\/fast-reaction/);
  assert.match(source, /async function playWaitCue/);
  assert.match(source, /const waitCuePromise = playWaitCue/);
  assert.match(source, /streamedResult = await talkStream\(text, queueSentence, utteranceId, controller\.signal\)/);
  assert.doesNotMatch(source, /onSpeculative|speculativeText|speculativeAudioPromise/);
  assert.match(source, /falling back to \/api\/turn/);
  assert.match(source, /return \{ answer: await talk\(text, utteranceId, signal\), streamed: false/);
});

test('Discord falls back to the normal turn endpoint when SSE fails before any audio', () => {
  assert.match(source, /runtime failure before audio; falling back to \/api\/turn/);
  assert.match(source, /const answer = await talk\(text, utteranceId, controller\.signal\)/);
  assert.match(source, /queuedSentences === 0/);
  assert.match(source, /!error\?\.partial/);
});

test('Discord stores the complete final answer while speaking at most four streamed sentences', () => {
  assert.match(source, /function voiceSafeText\(text\)/);
  assert.match(source, /sentences\.slice\(0, 4\)/);
  assert.match(source, /queuedSentences >= 4/);
  assert.match(source, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: doneBody\.answer \}\)/);
  assert.match(source, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: body\.answer \}\)/);
});

test('Discord assigns one persistent conversation session id per VC connection', () => {
  assert.match(source, /let discordSessionId = ''/);
  assert.match(source, /discordSessionId = `discord-\$\{channel\.guild\.id\}-\$\{channel\.id\}-\$\{randomUUID\(\)\}`/);
  assert.match(source, /sessionId: discordSessionId \|\| `discord-\$\{randomUUID\(\)\}`/);
  assert.match(source, /\[discord\] conversation session:/);
});

test('Discord prioritizes final first-sentence TTS and generates later sentences during playback', () => {
  assert.match(source, /queuedSentences === 1/);
  assert.match(source, /firstSentenceReadyPromise = timedSynthesize\(safe\)/);
  assert.match(source, /Promise\.resolve\(firstSentenceReadyPromise\)[\s\S]*timedSynthesize\(safe\)/);
  assert.match(source, /playbackChain = playbackChain\.then/);
  assert.match(source, /const prefetched = await audioPromise/);
  assert.match(source, /source=final-answer-first-sentence/);
});

test('Discord logs stage latency for STT, Gemini turn, TTS, and final audio readiness', () => {
  assert.match(source, /\[latency\] batch-stt-http=/);
  assert.match(source, /\[latency\] turn-http=/);
  assert.match(source, /\[latency\] turn-stream=/);
  assert.match(source, /\[latency\] tts-http=/);
  assert.match(source, /\[latency\] first-audio-ready=/);
  assert.match(source, /server-total=/);
  assert.match(source, /ffmpeg-first-output=/);
  assert.match(source, /speech-end-to-playback-start=/);
});

test('Discord voice stages have finite budgets and bounded retries', () => {
  assert.match(source, /const REQUEST_BUDGET_MS = Object\.freeze/);
  assert.match(source, /batchStt: 1800/);
  assert.match(source, /turnStream: 35000/);
  assert.match(source, /turn: 35000/);
  assert.match(source, /tts: 12000/);
  assert.match(source, /function boundedSignal\(parentSignal, timeoutMs\)/);
  assert.match(source, /function fetchWithRetry\(url, init = \{\}, \{ timeoutMs = 15000, retries = 1, label = 'request' \} = \{\}\)/);
  assert.match(source, /retries: 0,\n    label: 'turn'/);
  assert.match(source, /retries: 0,\n    label: 'tts'/);
});

test('Discord pre-caches a recovery voice and speaks it instead of going silent', () => {
  assert.match(source, /const RECOVERY_PROMPT = 'すみません、うまく聞き取れませんでした。もう一度お願いします。'/);
  assert.match(source, /async function warmRecoveryAudio\(\)/);
  assert.match(source, /async function speakRecoveryPrompt\(reason = 'pipeline-failure', sessionEpoch = voiceEpoch\)/);
  assert.match(source, /warmRecoveryAudio\(\)\.catch/);
  assert.match(source, /playedSentenceCount === 0/);
  assert.match(source, /speakRecoveryPrompt\('answer-pipeline-failed', sessionEpoch\)/);
});

test('Discord playback watchdog kills stuck ffmpeg instead of leaking the pipeline', () => {
  assert.match(source, /ffmpeg\.kill\('SIGKILL'\)/);
  assert.match(source, /player\.stop\(true\)/);
  assert.match(source, /playback_timeout/);
});

test('Discord slash join restores the audible connection greeting without making failure fatal', () => {
  assert.match(source, /async function playConnectionGreeting\(\)/);
  assert.match(source, /フォーンズです。接続しました。/);
  assert.match(source, /await playConnectionGreeting\(\)/);
  assert.match(source, /connection greeting failed; voice connection remains active/);
  assert.match(source, /TalkSysを「\$\{channel\.name\}」へ接続しました。/);
});

test('Discord smoke launcher requires only the bot token plus persisted bridge token', () => {
  assert.match(launcher, /DISCORD_TOKEN/);
  assert.doesNotMatch(launcher, /DISCORD_GUILD_ID/);
  assert.doesNotMatch(launcher, /Discord Guild \(Server\) ID/);
  assert.doesNotMatch(launcher, /Read-Host "Discord Voice Channel ID"/);
  assert.match(launcher, /DISCORD_BRIDGE_TOKEN/);
  assert.match(launcher, /Get-TalkSysPersistedSecret 'discord-bridge-token'/);
  assert.match(launcher, /\/talksys joins caller VC/);
  assert.match(launcher, /npm install --no-audit --no-fund/);
  assert.match(launcher, /Node\.js 22\.12/);
});

test('Discord smoke registers only its own slash commands without bulk-overwriting unrelated commands', () => {
  assert.match(source, /guild\.commands\.fetch\(\)/);
  assert.match(source, /guild\.commands\.edit/);
  assert.match(source, /guild\.commands\.create/);
  assert.doesNotMatch(source, /guild\.commands\.set\(/);
  assert.match(source, /name: 'talksys'/);
  assert.match(source, /name: 'leave'/);
  assert.match(source, /client\.guilds\.cache\.values\(\)/);
  assert.doesNotMatch(source, /DISCORD_GUILD_ID/);
  assert.match(source, /voiceStates\.cache\.get\(interaction\.user\.id\)/);
  assert.match(source, /connectToVoiceChannel\(channel, interaction\.user\.id\)/);
  assert.match(source, /waiting for \/talksys/);
});

test('Discord voice session resets conversation state and ignores stale replies after reconnect', () => {
  assert.match(source, /let voiceEpoch = 0/);
  assert.match(source, /resetConversationState/);
  assert.match(source, /voiceEpoch \+= 1/);
  assert.match(source, /sessionEpoch !== voiceEpoch/);
  assert.match(source, /history\.splice\(0, history\.length\)/);
  assert.match(source, /previousInteractionId = ''/);
});

test('Discord allows caller barge-in instead of waiting for long playback to finish', () => {
  assert.match(source, /function interruptActiveAnswer\(reason = 'user-speech'\)/);
  assert.match(source, /activeTurnAbortController/);
  assert.match(source, /controller\?\.abort\(\)/);
  assert.match(source, /player\.stop\(true\)/);
  assert.match(source, /\[barge-in\] interrupted active answer/);
  assert.match(source, /interruptActiveAnswer\('user-speech'\)/);
  assert.match(source, /turnSerial !== activeTurnSerial/);
});

test('Discord slash join pre-arms the invoking user receive stream', () => {
  assert.match(source, /connectToVoiceChannel\(channel, initialUserId = ''\)/);
  assert.match(source, /startReceiverSession\(initialUserId, false\)/);
  assert.match(source, /\[rx\] pre-armed user=/);
  assert.match(source, /connectToVoiceChannel\(channel, interaction\.user\.id\)/);
});

test('Discord receiver sessions self-clear when speaking produces no packets or capture never finalizes', () => {
  assert.match(source, /RECEIVER_PACKET_START_TIMEOUT_MS = 5000/);
  assert.match(source, /RECEIVER_CAPTURE_TIMEOUT_MS = 30000/);
  assert.match(source, /speaking produced no audio packets; resetting receiver/);
  assert.match(source, /capture watchdog forcing finalize/);
  assert.match(source, /existingSession\.markSpeaking\?\.\(\)/);
  assert.match(source, /startReceiverSession\(userId, true\)/);
  assert.match(source, /clearReceiverWatchdogs\(\)/);
});

test('Discord voice connection retries a transient disconnect instead of staying dead', () => {
  assert.match(source, /VoiceConnectionStatus\.Disconnected/);
  assert.match(source, /boundConnection\.rejoin\(\)/);
  assert.match(source, /VOICE_REJOIN_TIMEOUT_MS = 10000/);
  assert.match(source, /voice disconnected; scheduling rejoin/);
  assert.match(source, /voice rejoin recovered/);
  assert.match(source, /voiceRecoveryAttempts < 5/);
});

test('Discord bridge logs unhandled promise failures instead of terminating silently', () => {
  assert.match(source, /process\.on\('unhandledRejection'/);
  assert.match(source, /\[process\] unhandled rejection:/);
});

test('Discord launcher does not mutate npm dependencies on every normal restart', () => {
  assert.match(launcher, /Get-FileHash -Algorithm SHA256/);
  assert.match(launcher, /\.talksys-package-sha256/);
  assert.match(launcher, /Discord dependencies unchanged; skipping npm install/);
  assert.match(launcher, /if \(\$needsInstall\)/);
});

test('Discord bridge secret setup persists the same random token locally with Windows DPAPI', () => {
  assert.match(setupSecret, /RandomNumberGenerator/);
  assert.match(setupSecret, /wrangler secret put DISCORD_BRIDGE_TOKEN/);
  assert.match(setupSecret, /Save-TalkSysPersistedSecret 'discord-bridge-token'/);
  assert.match(secretStore, /ConvertFrom-SecureString/);
  assert.match(secretStore, /ConvertTo-SecureString/);
  assert.match(secretStore, /LOCALAPPDATA/);
  assert.match(launcher, /Get-TalkSysPersistedSecret 'discord-bridge-token'/);
  assert.match(launcher, /setup-bridge-secret\.ps1/);
});

test('Discord voice dependencies use a prism-media-compatible Opus line', () => {
  assert.match(packageJson.dependencies['@discordjs/voice'], /^\^0\.19\./);
  assert.match(packageJson.dependencies['discord.js'], /^\^14\./);
  assert.equal(packageJson.dependencies.opusscript, '^0.0.8');
  assert.match(packageJson.dependencies.ws, /^\^8\./);
  assert.match(launcher, /--legacy-peer-deps/);
});

test('Discord slash interactions are acknowledged before VC lookup or connection work', () => {
  const handlerStart = source.indexOf("client.on('interactionCreate'");
  const ack = source.indexOf("await interaction.deferReply({ ephemeral: true })", handlerStart);
  const voiceLookup = source.indexOf("voiceStates.cache.get", handlerStart);
  const connect = source.indexOf("connectToVoiceChannel(channel", handlerStart);
  assert.ok(handlerStart >= 0);
  assert.ok(ack > handlerStart);
  assert.ok(voiceLookup > ack);
  assert.ok(connect > ack);
  assert.match(source, /\[interaction\] received command=/);
  assert.match(source, /\[interaction\] acked command=/);
});

test('Discord gateway startup fails loudly instead of leaving a dead command surface', () => {
  assert.match(source, /DISCORD_READY_TIMEOUT_MS = 20000/);
  assert.match(source, /Discord Gateway did not reach Ready/);
  assert.match(source, /Discord login failed/);
  assert.match(source, /client\.login\(DISCORD_TOKEN\)\.catch/);
  assert.match(source, /gateway health ready=/);
  assert.match(source, /shard disconnected/);
  assert.match(source, /shard reconnecting/);
  assert.match(source, /shard resumed/);
});
