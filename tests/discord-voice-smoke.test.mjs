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

test('Discord bridge uses permanent shared-token TTS auth and no expired demo bypass', () => {
  assert.match(source, /authorization: 'Bearer ' \+ BRIDGE_TOKEN/);
  assert.doesNotMatch(source, /x-talksys-demo/);
  assert.doesNotMatch(source, /discord-voice-smoke-20260918/);
  assert.match(source, /const spokenAnswer = voiceSafeText\(answer\)/);
  assert.match(source, /const chunks = voiceChunks\(spokenAnswer\)/);
  assert.match(source, /let audio = await synthesize\(chunks\[0\] \|\| spokenAnswer\)/);
  assert.match(source, /await playMp3\(audio\)/);
});

test('Discord receive never echoes the callers raw voice and finalizes buffered short utterances', () => {
  assert.doesNotMatch(source, /playRawPcm48|raw echo playback|Readable\.from/);
  assert.match(source, /sendFinalizeIfReady/);
  assert.match(source, /\[stt\] finalize sent/);
  assert.match(source, /finalize-timeout/);
  assert.match(source, /utterance dropped after realtime\+batch STT/);
  assert.match(source, /opus=.*pcm48=.*pcm16=/);
});

test('Discord realtime STT rate limits fall back to batch Whisper instead of dropping speech', () => {
  assert.match(source, /batchTranscribePcm16/);
  assert.match(source, /\/api\/transcribe/);
  assert.match(source, /content-type': 'audio\/wav'/);
  assert.match(source, /unexpected-response/);
  assert.match(source, /statusCode === 429/);
  assert.match(source, /realtimeSttBackoffUntil = Date\.now\(\) \+ 60_000/);
  assert.match(source, /batch STT forced for 60s/);
  assert.match(source, /\[stt-fallback\] batch success/);
});

test('Discord keeps PCM16 audio for fallback transcription when realtime STT fails', () => {
  assert.match(source, /const pcm16Chunks = \[\]/);
  assert.match(source, /pcm16Chunks\.push\(Buffer\.from\(pcm16\)\)/);
  assert.match(source, /Buffer\.concat\(pcm16Chunks\)/);
  assert.match(source, /pcm16MonoToWav16k/);
  assert.match(source, /writeUInt32LE\(16000, 24\)/);
});

test('Discord runtime omits search-preface work and keeps the core voice path only', () => {
  assert.doesNotMatch(source, /\/api\/search-preface/);
  assert.doesNotMatch(source, /searchPreface/);
  assert.doesNotMatch(source, /prefaceTask|prefacePlaybackPromise|answerReady/);
  assert.match(source, /const answer = await talk\(text\)/);
  assert.match(source, /const spokenAnswer = voiceSafeText\(answer\)/);
  assert.match(source, /const chunks = voiceChunks\(spokenAnswer\)/);
  assert.match(source, /const nextAudio = index \+ 1 < chunks\.length/);
});

test('Discord spoken output is compacted before server TTS without changing stored answer history', () => {
  assert.match(source, /function voiceSafeText\(text\)/);
  assert.match(source, /sentences\.slice\(0, 4\)/);
  assert.match(source, /spoken answer compacted chars=/);
  assert.match(source, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: body\.answer \}\)/);
});

test('Discord assigns one persistent conversation session id per VC connection', () => {
  assert.match(source, /let discordSessionId = ''/);
  assert.match(source, /discordSessionId = `discord-\$\{channel\.guild\.id\}-\$\{channel\.id\}-\$\{randomUUID\(\)\}`/);
  assert.match(source, /sessionId: discordSessionId \|\| `discord-\$\{randomUUID\(\)\}`/);
  assert.match(source, /\[discord\] conversation session:/);
});

test('Discord pipelines later sentence TTS generation while the current sentence is playing', () => {
  assert.match(source, /function voiceChunks\(text\)/);
  assert.match(source, /const nextAudio = index \+ 1 < chunks\.length/);
  assert.match(source, /await playMp3\(audio\)/);
  assert.match(source, /const prefetched = await nextAudio/);
  assert.match(source, /if \(prefetched\.error\) throw prefetched\.error/);
});

test('Discord logs stage latency for STT, Gemini turn, TTS, and final audio readiness', () => {
  assert.match(source, /\[latency\] batch-stt-http=/);
  assert.match(source, /\[latency\] turn-http=/);
  assert.match(source, /\[latency\] tts-http=/);
  assert.match(source, /\[latency\] first-audio-ready=/);
  assert.match(source, /server-total=/);
});

test('Discord slash join does not spend TTS time before first user turn', () => {
  assert.doesNotMatch(source, /フォーンズです。接続しました。/);
  assert.doesNotMatch(source, /\[tts-preflight\]/);
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

test('Discord receiver remains active while Fones is answering and queues user turns', () => {
  assert.doesNotMatch(source, /sessions\.has\(userId\) \|\| answering/);
  assert.match(source, /const pendingTurns = \[\]/);
  assert.match(source, /\[queue\] buffered user=/);
  assert.match(source, /pendingTurns\.shift\(\)/);
});

test('Discord slash join pre-arms the invoking user receive stream', () => {
  assert.match(source, /connectToVoiceChannel\(channel, initialUserId = ''\)/);
  assert.match(source, /startReceiverSession\(initialUserId\)/);
  assert.match(source, /\[rx\] pre-armed user=/);
  assert.match(source, /connectToVoiceChannel\(channel, interaction\.user\.id\)/);
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
