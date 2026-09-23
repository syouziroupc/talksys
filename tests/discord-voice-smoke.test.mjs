import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'));
const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
const setupSecret = fs.readFileSync(new URL('../discord-voice-smoke/setup-bridge-secret.ps1', import.meta.url), 'utf8');
const secretStore = fs.readFileSync(new URL('../discord-voice-smoke/secret-store.ps1', import.meta.url), 'utf8');

test('Discord bridge is only input adapter, common HTTP STT/turn, and output adapter', () => {
  assert.match(source, /createWebCompatibleResampler/);
  assert.match(source, /WebCompatibleCapture/);
  assert.match(source, /\/api\/transcribe/);
  assert.match(source, /\/api\/turn/);
  assert.match(source, /\/api\/voice\/synthesize/);
  assert.doesNotMatch(source, /\/api\/realtime-stt|\/api\/turn-stream|WebSocket|speech_final|batchTranscribePcm16|talkStream|type:\s*['"]Finalize['"]/);
  assert.doesNotMatch(source, /speechSynthesis|SpeechSynthesisUtterance/);
});

test('Discord Whisper transcription is the normal path, not a fallback', () => {
  assert.match(source, /async function transcribeCapturedUtterance/);
  assert.match(source, /stt: 30000/);
  assert.match(source, /content-type': 'audio\/wav'/);
  assert.match(source, /confirmedTranscript = String\(body\.text\)\.trim\(\)/);
  assert.match(source, /sttMode: 'whisper-batch'/);
  assert.match(source, /fallback: false/);
  assert.doesNotMatch(source, /batchTranscribePcm16|fallbackController|realtimeSttFailure|realtimeSttBackoff|realtimeSttSockets/i);
});

test('Discord capture mirrors web segmentation while keeping 1600 ms only as transport safety', () => {
  assert.match(source, /WEB_VOICE_CAPTURE_POLICY/);
  assert.match(source, /WebCompatibleCapture/);
  assert.match(source, /EndBehaviorType\.AfterSilence, duration: 1600/);
  assert.match(source, /capture\.shouldFinalize\(Date\.now\(\)\)/);
  assert.match(source, /web-compatible-silence/);
  assert.match(source, /highpass=f=\$\{WEB_VOICE_CAPTURE_POLICY\.highpassHz\},aresample=\$\{WEB_VOICE_CAPTURE_POLICY\.targetRate\}/);
  assert.match(source, /queueMicrotask\(\(\) => \{[\s\S]*startReceiverSession\(userId, false\)/);
});

test('confirmed Whisper text is exactly the text sent to common TalkSys turn', () => {
  assert.match(source, /await processConfirmedTranscript\(\{/);
  assert.match(source, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal\)/);
  assert.match(source, /geminiInputText: confirmedTranscript/);
  assert.match(source, /history: previous/);
  assert.match(source, /previousInteractionId/);
  assert.match(source, /searchTrace/);
});

test('wait cue is non-answer audio and cannot remain playing when final answer is ready', () => {
  assert.match(source, /function startWaitCue/);
  assert.match(source, /\/api\/search-preface/);
  assert.match(source, /activeWaitCue = startWaitCue\(confirmedTranscript/);
  assert.match(source, /activeWaitCue\?\.stop\('final-answer-ready'\)/);
  assert.match(source, /player\.stop\(true\)/);
  assert.doesNotMatch(source, /waitCuePromise|await activeWaitCue\.done/);
});

test('Discord assigns one persistent conversation session id per VC connection', () => {
  assert.match(source, /let discordSessionId = ''/);
  assert.match(source, /discordSessionId = `discord-\$\{channel\.guild\.id\}-\$\{channel\.id\}-\$\{randomUUID\(\)\}`/);
  assert.match(source, /\[discord\] conversation session:/);
});

test('Discord logs all requested end-to-end stages', () => {
  for (const key of [
    'discordReceiveStartAt','firstPcmAt','utteranceEndAt','wavReadyAt',
    'transcribeStartAt','whisperCompleteAt','turnStartAt','finalAnswerAt',
    'ttsStartAt','ttsEndAt','playbackStartAt','pipelineCompleteAt',
    'speechEndToSttFinalMs','primaryMs','verifierMs','answerGenerationTotalMs',
    'ffmpegSpawnMs','speechEndToPlaybackStartMs',
  ]) assert.match(source, new RegExp(key));
  assert.match(source, /ffmpeg-first-output=/);
  assert.match(source, /\[latency-summary\]/);
});

test('Discord pre-caches recovery voice and speaks it on STT or answer failure', () => {
  assert.match(source, /const RECOVERY_PROMPT = 'すみません、うまく聞き取れませんでした。もう一度お願いします。'/);
  assert.match(source, /async function warmRecoveryAudio/);
  assert.match(source, /speakRecoveryPrompt\('stt-failed'/);
  assert.match(source, /speakRecoveryPrompt\('answer-pipeline-failed'/);
});

test('Discord playback watchdog kills stuck ffmpeg instead of leaking the pipeline', () => {
  assert.match(source, /ffmpeg\.kill\('SIGKILL'\)/);
  assert.match(source, /playback_timeout/);
});

test('Discord slash join restores the audible connection greeting', () => {
  assert.match(source, /async function playConnectionGreeting/);
  assert.match(source, /フォーンズです。接続しました。/);
  assert.match(source, /await playConnectionGreeting\(\)/);
});

test('Discord slash commands are updated without bulk-overwriting unrelated commands', () => {
  assert.match(source, /guild\.commands\.fetch\(\)/);
  assert.match(source, /guild\.commands\.edit/);
  assert.match(source, /guild\.commands\.create/);
  assert.doesNotMatch(source, /guild\.commands\.set\(/);
  assert.match(source, /name: 'talksys'/);
  assert.match(source, /name: 'leave'/);
});

test('Discord allows caller barge-in and cancels answer and wait audio', () => {
  assert.match(source, /function interruptActiveAnswer\(reason = 'user-speech'\)/);
  assert.match(source, /activeTurnAbortController/);
  assert.match(source, /activeWaitCue\?\.stop/);
  assert.match(source, /player\.stop\(true\)/);
  assert.match(source, /interruptActiveAnswer\('user-speech'\)/);
});

test('Discord voice connection retries transient disconnects', () => {
  assert.match(source, /VoiceConnectionStatus\.Disconnected/);
  assert.match(source, /boundConnection\.rejoin\(\)/);
  assert.match(source, /VOICE_REJOIN_TIMEOUT_MS = 10000/);
  assert.match(source, /voiceRecoveryAttempts < 5/);
});

test('Discord gateway startup fails loudly instead of leaving a dead command surface', () => {
  assert.match(source, /DISCORD_READY_TIMEOUT_MS = 20000/);
  assert.match(source, /Discord Gateway did not reach Ready/);
  assert.match(source, /Discord login failed/);
  assert.match(source, /gateway health ready=/);
});

test('Discord launcher persists bridge secret and avoids reinstalling unchanged dependencies', () => {
  assert.match(launcher, /DISCORD_TOKEN/);
  assert.match(launcher, /DISCORD_BRIDGE_TOKEN/);
  assert.match(launcher, /Get-TalkSysPersistedSecret 'discord-bridge-token'/);
  assert.match(launcher, /Get-FileHash -Algorithm SHA256/);
  assert.match(launcher, /Discord dependencies unchanged; skipping npm install/);
  assert.match(setupSecret, /wrangler secret put DISCORD_BRIDGE_TOKEN/);
  assert.match(secretStore, /ConvertFrom-SecureString/);
});

test('Discord dependency set no longer carries realtime STT websocket client', () => {
  assert.match(packageJson.dependencies['@discordjs/voice'], /^\^0\.19\./);
  assert.match(packageJson.dependencies['discord.js'], /^\^14\./);
  assert.equal(packageJson.dependencies.opusscript, '^0.0.8');
  assert.equal(packageJson.dependencies.ws, undefined);
});
