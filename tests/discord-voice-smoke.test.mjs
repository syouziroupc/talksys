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

test('Discord smoke has a realtime STT websocket preflight', () => {
  assert.match(source, /probeRealtimeStt/);
  assert.match(source, /\[preflight\] realtime STT websocket open/);
  assert.match(source, /realtime_stt_probe_timeout/);
});

test('Discord bridge uses permanent shared-token TTS auth and no expired demo bypass', () => {
  assert.match(source, /authorization: 'Bearer ' \+ BRIDGE_TOKEN/);
  assert.doesNotMatch(source, /x-talksys-demo/);
  assert.doesNotMatch(source, /discord-voice-smoke-20260918/);
  assert.match(source, /const audio = await synthesize\(answer\)/);
  assert.match(source, /await playMp3\(audio\)/);
});

test('raw echo and receive-byte diagnostics distinguish Discord receive from STT failure', () => {
  assert.match(source, /Readable\.from\(\[pcm\]\)/);
  assert.match(source, /\[stt\] no transcript/);
  assert.match(source, /opus=.*pcm48=.*pcm16=/);
  assert.match(source, /playRawPcm48\(rawPcm48\)/);
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
  assert.match(source, /connectToVoiceChannel\(channel\)/);
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

test('Discord voice dependencies are pinned to expected major lines', () => {
  assert.match(packageJson.dependencies['@discordjs/voice'], /^\^0\.19\./);
  assert.match(packageJson.dependencies['discord.js'], /^\^14\./);
  assert.match(packageJson.dependencies.ws, /^\^8\./);
});
