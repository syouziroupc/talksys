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

const required = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_VOICE_CHANNEL_ID', 'DISCORD_BRIDGE_TOKEN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[fatal] missing ${key}`);
    process.exit(1);
  }
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
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

async function processTranscript(text, userId, rawPcm48) {
  if (!text || answering) return;
  answering = true;
  try {
    console.log(`[stt] final user=${userId}:`, text);
    const answer = await talk(text);
    const audio = await synthesize(answer);
    await playMp3(audio);
  } catch (error) {
    console.error('[pipeline]', error?.stack || error);
    if (rawPcm48?.length) {
      try { await playRawPcm48(rawPcm48); }
      catch (echoError) { console.error('[echo]', echoError?.stack || echoError); }
    }
  } finally {
    answering = false;
  }
}

function startReceiverSession(userId) {
  if (!connection || sessions.has(userId) || answering) return;
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
      if (text) processTranscript(text, userId, rawPcm48);
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

client.once('ready', async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
    if (!channel || !channel.isVoiceBased()) throw new Error('VOICE_CHANNEL_ID is not a voice channel');

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.subscribe(player);

    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    console.log('[discord] voice ready:', channel.name);
    console.log('[discord] TalkSys realtime STT:', STT_WS_URL);
    console.log('[discord] output mode: TalkSys TTS (permanent shared token)');
    try {
      await probeRealtimeStt();
    } catch (error) {
      console.error('[preflight] realtime STT websocket failed:', error?.message || error);
    }

    connection.receiver.speaking.on('start', (userId) => {
      if (userId === client.user.id) return;
      startReceiverSession(userId);
    });
  } catch (error) {
    console.error('[fatal]', error?.stack || error);
    process.exitCode = 1;
  }
});

client.on('error', (error) => console.error('[discord]', error));
player.on('error', (error) => console.error('[player]', error.message));

process.on('SIGINT', () => {
  try { connection?.destroy(); } catch {}
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
