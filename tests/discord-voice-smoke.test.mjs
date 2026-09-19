import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'));
const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');

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

test('Discord smoke launcher requests only external Discord identifiers and installs locally', () => {
  assert.match(launcher, /DISCORD_TOKEN/);
  assert.match(launcher, /DISCORD_GUILD_ID/);
  assert.match(launcher, /DISCORD_VOICE_CHANNEL_ID/);
  assert.match(launcher, /DISCORD_BRIDGE_TOKEN/);
  assert.match(launcher, /Read-Secret "TalkSys Discord Bridge Token"/);
  assert.match(launcher, /npm install --no-audit --no-fund/);
  assert.match(launcher, /Node\.js 22\.12/);
});

test('Discord voice dependencies are pinned to expected major lines', () => {
  assert.match(packageJson.dependencies['@discordjs/voice'], /^\^0\.19\./);
  assert.match(packageJson.dependencies['discord.js'], /^\^14\./);
  assert.match(packageJson.dependencies.ws, /^\^8\./);
});
