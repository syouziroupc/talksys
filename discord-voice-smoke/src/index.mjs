import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import ffmpegPath from 'ffmpeg-static';
import WebSocket from 'ws';

const required = ['DISCORD_TOKEN', 'DISCORD_BRIDGE_TOKEN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[fatal] missing ${key}`);
    process.exit(1);
  }
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TALKSYS_BASE_URL = (process.env.TALKSYS_BASE_URL || 'https://talksys.syouziroupc.workers.dev').replace(/\/$/, '');
const BRIDGE_TOKEN = process.env.DISCORD_BRIDGE_TOKEN;
const STT_WS_URL = TALKSYS_BASE_URL.replace(/^http/i, 'ws') + '/api/realtime-stt';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
const sessions = new Map();
const history = [];
let previousInteractionId = '';
let connection;
let answering = false;
let voiceEpoch = 0;

function resetConversationState() {
  history.splice(0, history.length);
  previousInteractionId = '';
  answering = false;
}

function mono16kFromStereo48k(chunk) {
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const frames = Math.floor(input.length / 4);
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.allocUnsafe(outFrames * 2);
  let oi = 0;
  for (let frame = 0; frame + 2 < frames; frame += 3) {
    let sum = 0;
    for (let k = 0; k < 3; k += 1) {
      const base = (frame + k) * 4;
      const l = input.readInt16LE(base);
      const r = input.readInt16LE(base + 2);
      sum += (l + r) / 2;
    }
    const sample = Math.max(-32768, Math.min(32767, Math.round(sum / 3)));
    out.writeInt16LE(sample, oi);
    oi += 2;
  }
  return out.subarray(0, oi);
}

function transcriptFrom(payload) {
  return String(payload?.channel?.alternatives?.[0]?.transcript || payload?.transcript || '').trim();
}

async function probeRealtimeStt() {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(STT_WS_URL);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error('realtime_stt_probe_timeout'));
    }, 8000);
    const cleanup = () => clearTimeout(timer);
    ws.once('open', () => {
      cleanup();
      console.log('[preflight] realtime STT websocket open');
      try { ws.close(1000, 'preflight'); } catch {}
      resolve();
    });
    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function talk(text) {
  console.log('[turn] user:', text);
  const response = await fetch(TALKSYS_BASE_URL + '/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      history: history.slice(-12),
      previousInteractionId,
      channel: 'discord-voice-smoke',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok || !body?.answer) {
    throw new Error(body?.detail || body?.error || `turn_http_${response.status}`);
  }
  if (body.interactionId) previousInteractionId = body.interactionId;
  history.push({ role: 'user', content: text }, { role: 'assistant', content: body.answer });
  if (history.length > 24) history.splice(0, history.length - 24);
  console.log('[turn] assistant:', body.answer);
  return body.answer;
}

async function synthesize(text) {
  const response = await fetch(TALKSYS_BASE_URL + '/api/voice/synthesize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + BRIDGE_TOKEN,
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`tts_http_${response.status}: ${detail.slice(0, 300)}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  console.log('[tts]', audio.length, 'bytes');
  return audio;
}

async function playMp3(mp3) {
  if (!ffmpegPath) throw new Error('ffmpeg_static_missing');
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (d) => { ffmpegError += String(d); });
  ffmpeg.on('error', (error) => console.error('[ffmpeg]', error.message));
  ffmpeg.stdin.end(mp3);

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  player.play(resource);
  console.log('[tx] playback started');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('playback_timeout')), 30000);
    const done = () => { clearTimeout(timeout); cleanup(); resolve(); };
    const fail = (error) => { clearTimeout(timeout); cleanup(); reject(error); };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, done);
      player.off('error', fail);
    };
    player.once(AudioPlayerStatus.Idle, done);
    player.once('error', fail);
  });
  if (ffmpegError.trim()) console.log('[ffmpeg]', ffmpegError.trim());
}

async function playRawPcm48(pcm) {
  if (!pcm?.length) return;
  const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
  player.play(resource);
  console.log('[tx] raw echo playback started');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('echo_playback_timeout')), 15000);
    const done = () => { clearTimeout(timeout); cleanup(); resolve(); };
    const fail = (error) => { clearTimeout(timeout); cleanup(); reject(error); };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, done);
      player.off('error', fail);
    };
    player.once(AudioPlayerStatus.Idle, done);
    player.once('error', fail);
  });
}

async function processTranscript(text, userId, rawPcm48, sessionEpoch) {
  if (!text || answering || sessionEpoch !== voiceEpoch) return;
  answering = true;
  try {
    console.log(`[stt] final user=${userId}:`, text);
    const answer = await talk(text);
    if (sessionEpoch !== voiceEpoch) return;
    const audio = await synthesize(answer);
    if (sessionEpoch !== voiceEpoch) return;
    await playMp3(audio);
  } catch (error) {
    if (sessionEpoch !== voiceEpoch) return;
    console.error('[pipeline]', error?.stack || error);
    if (rawPcm48?.length) {
      try { await playRawPcm48(rawPcm48); }
      catch (echoError) { console.error('[echo]', echoError?.stack || echoError); }
    }
  } finally {
    if (sessionEpoch === voiceEpoch) answering = false;
  }
}

function startReceiverSession(userId) {
  if (!connection || sessions.has(userId) || answering) return;
  const sessionEpoch = voiceEpoch;
  console.log('[rx] user=' + userId);

  const opus = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const ws = new WebSocket(STT_WS_URL);
  const pending = [];
  let latest = '';
  let finalText = '';
  let ended = false;
  const rawPcm48Chunks = [];
  let opusBytes = 0;
  let pcm48Bytes = 0;
  let pcm16Bytes = 0;
  let finishTimer;

  const session = { opus, decoder, ws };
  sessions.set(userId, session);

  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(finishTimer);
    try { opus.destroy(); } catch {}
    try { decoder.destroy(); } catch {}
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Finalize' }));
    } catch {}
    setTimeout(() => {
      const text = (finalText || latest).trim();
      try { ws.close(1000, 'utterance-complete'); } catch {}
      sessions.delete(userId);
      const rawPcm48 = Buffer.concat(rawPcm48Chunks);
      console.log(`[rx] captured user=${userId} opus=${opusBytes}B pcm48=${pcm48Bytes}B pcm16=${pcm16Bytes}B`);
      if (sessionEpoch !== voiceEpoch) return;
      if (text) processTranscript(text, userId, rawPcm48, sessionEpoch);
      else {
        console.log('[stt] no transcript; echoing captured PCM to prove Discord receive path');
        if (rawPcm48.length) {
          playRawPcm48(rawPcm48).catch((error) => console.error('[echo]', error?.stack || error));
        }
      }
    }, 900);
  };

  ws.on('open', () => {
    console.log('[stt] websocket open');
    for (const frame of pending.splice(0)) ws.send(frame);
  });

  ws.on('message', (data) => {
    let payload;
    try { payload = JSON.parse(String(data)); } catch { return; }
    const text = transcriptFrom(payload);
    if (text) {
      latest = text;
      console.log('[stt]', payload?.is_final ? 'final-part:' : 'interim:', text);
      if (payload?.is_final) finalText = text;
    }
    if (payload?.speech_final && text) {
      finalText = text;
      finishTimer = setTimeout(finish, 80);
    }
  });

  ws.on('error', (error) => {
    console.error('[stt] websocket error:', error.message);
    finish();
  });

  ws.on('close', (code, reason) => {
    console.log('[stt] websocket close', code, String(reason || ''));
  });

  decoder.on('data', (pcm48) => {
    pcm48Bytes += pcm48.length;
    if (rawPcm48Chunks.length < 500) rawPcm48Chunks.push(Buffer.from(pcm48));
    const pcm16 = mono16kFromStereo48k(pcm48);
    pcm16Bytes += pcm16.length;
    if (!pcm16.length) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(pcm16);
    else if (ws.readyState === WebSocket.CONNECTING) {
      pending.push(pcm16);
      if (pending.length > 150) pending.shift();
    }
  });

  decoder.on('error', (error) => {
    console.error('[decode]', error.message);
    finish();
  });

  opus.on('data', (chunk) => { opusBytes += chunk.length; });
  opus.on('error', (error) => {
    console.error('[opus]', error.message);
    finish();
  });
  opus.on('end', finish);
  opus.pipe(decoder);
}

function destroyVoiceConnection() {
  voiceEpoch += 1;
  resetConversationState();
  for (const session of sessions.values()) {
    try { session.opus?.destroy(); } catch {}
    try { session.decoder?.destroy(); } catch {}
    try { session.ws?.close(1000, 'voice-disconnect'); } catch {}
  }
  sessions.clear();
  player.stop(true);
  try { connection?.destroy(); } catch {}
  connection = undefined;
}

async function connectToVoiceChannel(channel) {
  if (!channel || !channel.isVoiceBased()) throw new Error('target channel is not voice based');
  destroyVoiceConnection();

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  connection.subscribe(player);

  await entersState(connection, VoiceConnectionStatus.Ready, 15000);
  connection.receiver.speaking.on('start', (userId) => {
    if (userId === client.user.id) return;
    startReceiverSession(userId);
  });

  console.log('[discord] voice ready:', channel.name);
  return channel;
}

const TALKSYS_COMMANDS = [
  {
    name: 'talksys',
    description: 'TalkSysを現在参加中のVCへ呼び出します',
  },
  {
    name: 'leave',
    description: 'TalkSysをVCから退出させます',
  },
];

async function ensureTalkSysCommands(guild) {
  const existing = await guild.commands.fetch();
  for (const data of TALKSYS_COMMANDS) {
    const command = existing.find((item) => item.name === data.name);
    if (command) await guild.commands.edit(command.id, data);
    else await guild.commands.create(data);
  }
}

client.once('ready', async () => {
  try {
    const guilds = [...client.guilds.cache.values()];
    if (!guilds.length) throw new Error('Discord Botがサーバーに参加していません');

    for (const guild of guilds) {
      await ensureTalkSysCommands(guild);
      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /leave`);
    }
    console.log('[discord] TalkSys realtime STT:', STT_WS_URL);
    console.log('[discord] output mode: TalkSys TTS (permanent shared token)');

    try {
      await probeRealtimeStt();
    } catch (error) {
      console.error('[preflight] realtime STT websocket failed:', error?.message || error);
    }

    console.log('[discord] waiting for /talksys from a user in a voice channel');
  } catch (error) {
    console.error('[fatal]', error?.stack || error);
    process.exitCode = 1;
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  try {
    if (interaction.commandName === 'talksys') {
      const voiceState = interaction.guild?.voiceStates.cache.get(interaction.user.id);
      const channelId = voiceState?.channelId;
      if (!channelId) {
        await interaction.reply({ content: '先にボイスチャンネルへ参加してから /talksys を実行してください。', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const channel = await interaction.guild.channels.fetch(channelId);
      await connectToVoiceChannel(channel);
      await interaction.editReply(`TalkSysを「${channel.name}」へ接続しました。`);
      return;
    }

    if (interaction.commandName === 'leave') {
      destroyVoiceConnection();
      await interaction.reply({ content: 'TalkSysをボイスチャンネルから退出させました。', ephemeral: true });
    }
  } catch (error) {
    console.error('[command]', error?.stack || error);
    const message = 'TalkSysのVC操作に失敗しました。コンソールログを確認してください。';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, ephemeral: true });
    } catch {}
  }
});

client.on('error', (error) => console.error('[discord]', error));
player.on('error', (error) => console.error('[player]', error.message));

process.on('SIGINT', () => {
  destroyVoiceConnection();
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
