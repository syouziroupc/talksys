import { spawn } from 'node:child_process';
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
let realtimeSttBackoffUntil = 0;
const pendingTurns = [];

function resetConversationState() {
  history.splice(0, history.length);
  previousInteractionId = '';
  answering = false;
  pendingTurns.splice(0, pendingTurns.length);
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

function pcm16MonoToWav16k(pcm) {
  const input = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const dataLength = input.length - (input.length % 2);
  const out = Buffer.alloc(44 + dataLength);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataLength, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLength, 40);
  input.copy(out, 44, 0, dataLength);
  return out;
}

async function batchTranscribePcm16(pcm, reason = 'fallback') {
  if (!pcm?.length) throw new Error('batch_stt_empty_pcm');
  const wav = pcm16MonoToWav16k(pcm);
  console.log(`[stt-fallback] batch start reason=${reason} pcm=${pcm.length}B wav=${wav.length}B`);
  const response = await fetch(TALKSYS_BASE_URL + '/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok || !body?.text) {
    throw new Error(body?.error || body?.rejected || `batch_stt_http_${response.status}`);
  }
  console.log(`[stt-fallback] batch success model=${body.model || 'unknown'} elapsed=${body.elapsedMs ?? '?'}ms:`, body.text);
  return String(body.text).trim();
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
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      const status = Number(response?.statusCode || 0);
      if (status === 429) realtimeSttBackoffUntil = Date.now() + 60_000;
      try { ws.terminate(); } catch {}
      reject(new Error(`realtime_stt_probe_http_${status || 'unknown'}`));
    });
    ws.once('error', (error) => {
      cleanup();
      if (/\b429\b/.test(String(error?.message || ''))) realtimeSttBackoffUntil = Date.now() + 60_000;
      reject(error);
    });
  });
}

async function searchPreface(text) {
  const started = Date.now();
  const response = await fetch(TALKSYS_BASE_URL + '/api/search-preface', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json().catch(() => ({}));
  console.log(`[latency] search-preface-http=${Date.now() - started}ms`);
  if (!response.ok || !body?.ok) return { shouldSpeak: false, topic: '', text: '' };
  return body;
}

async function talk(text) {
  const started = Date.now();
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
  const elapsed = Date.now() - started;
  console.log('[turn] assistant:', body.answer);
  console.log(`[latency] turn-http=${elapsed}ms server-total=${body?.timings?.totalMs ?? '?'}ms primary=${body?.timings?.primaryMs ?? '?'}ms verifier=${body?.timings?.verifierMs ?? '?'}ms`);
  return body.answer;
}

async function synthesize(text) {
  const started = Date.now();
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
  const type = response.headers.get('content-type') || 'unknown';
  const source = response.headers.get('x-talksys-voice-source') || 'unknown';
  console.log(`[tts] ${audio.length} bytes type=${type} source=${source}`);
  console.log(`[latency] tts-http=${Date.now() - started}ms source=${source}`);
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

async function processTranscript(text, userId, sessionEpoch) {
  if (!text || sessionEpoch !== voiceEpoch) return;
  if (answering) {
    if (pendingTurns.length < 3) {
      pendingTurns.push({ text, userId, sessionEpoch });
      console.log(`[queue] buffered user=${userId}: ${text}`);
    } else {
      console.warn(`[queue] dropped user=${userId}: queue full`);
    }
    return;
  }

  const pipelineStarted = Date.now();
  answering = true;
  let answerReady = false;
  let prefacePlaybackPromise = null;

  try {
    console.log(`[stt] final user=${userId}:`, text);
    console.log('[latency] pipeline-start');

    const turnPromise = talk(text);
    const prefaceTask = (async () => {
      try {
        const preface = await searchPreface(text);
        if (sessionEpoch !== voiceEpoch || answerReady || !preface?.shouldSpeak || !preface?.text) return;
        console.log('[preface]', preface.text);
        const prefaceAudio = await synthesize(preface.text);
        if (sessionEpoch !== voiceEpoch || answerReady) {
          console.log('[preface] skipped because final answer is already ready');
          return;
        }
        prefacePlaybackPromise = playMp3(prefaceAudio);
        await prefacePlaybackPromise;
      } catch (error) {
        if (sessionEpoch === voiceEpoch) console.error('[preface]', error?.message || error);
      }
    })();

    const answer = await turnPromise;
    answerReady = true;
    if (sessionEpoch !== voiceEpoch) return;

    // Final TTS starts immediately when Gemini returns. A slow search-preface
    // synthesis must never block the final answer.
    const finalTtsPromise = synthesize(answer);

    // Only wait for a preface that has already started playing. If its TTS is
    // merely slow, it is skipped by answerReady above.
    if (prefacePlaybackPromise) {
      await prefacePlaybackPromise.catch(() => {});
    }

    const audio = await finalTtsPromise;
    if (sessionEpoch !== voiceEpoch) return;
    console.log(`[latency] final-audio-ready=${Date.now() - pipelineStarted}ms`);
    await playMp3(audio);
    console.log(`[latency] pipeline-complete=${Date.now() - pipelineStarted}ms`);

    prefaceTask.catch(() => {});
  } catch (error) {
    if (sessionEpoch !== voiceEpoch) return;
    console.error('[pipeline]', error?.stack || error);
  } finally {
    if (sessionEpoch === voiceEpoch) {
      answering = false;
      const next = pendingTurns.shift();
      if (next && next.sessionEpoch === voiceEpoch) {
        setTimeout(() => processTranscript(next.text, next.userId, next.sessionEpoch), 0);
      }
    }
  }
}

function startReceiverSession(userId) {
  if (!connection || sessions.has(userId)) return;
  const sessionEpoch = voiceEpoch;
  console.log('[rx] user=' + userId);

  const opus = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 550 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const pending = [];
  const finalParts = [];
  const pcm16Chunks = [];
  let latest = '';
  let inputEnded = false;
  let completed = false;
  let finalizeSent = false;
  let realtimeFailed = Date.now() < realtimeSttBackoffUntil;
  let realtimeFailureReason = realtimeFailed ? 'rate-limit-backoff' : '';
  let opusBytes = 0;
  let pcm48Bytes = 0;
  let pcm16Bytes = 0;
  let completionTimer;
  let settleTimer;
  let ws = null;

  const session = { opus, decoder, ws: null };
  sessions.set(userId, session);

  const markRealtimeFailed = (reason, statusCode = 0) => {
    if (realtimeFailed) return;
    realtimeFailed = true;
    realtimeFailureReason = reason || 'realtime-failed';
    if (statusCode === 429 || /429|rate/i.test(realtimeFailureReason)) {
      realtimeSttBackoffUntil = Date.now() + 60_000;
      console.warn('[stt] realtime 429; batch STT forced for 60s');
    } else {
      console.warn('[stt] realtime unavailable; using batch STT:', realtimeFailureReason);
    }
    try { ws?.terminate(); } catch {}
  };

  const complete = async (reason = 'complete') => {
    if (completed) return;
    completed = true;
    clearTimeout(completionTimer);
    clearTimeout(settleTimer);
    try { ws?.close(1000, 'utterance-complete'); } catch {}
    sessions.delete(userId);

    let text = (finalParts.join(' ').trim() || latest).trim();
    const pcm16 = Buffer.concat(pcm16Chunks);
    console.log(`[rx] captured user=${userId} opus=${opusBytes}B pcm48=${pcm48Bytes}B pcm16=${pcm16Bytes}B reason=${reason}`);
    if (sessionEpoch !== voiceEpoch) return;

    if (!text && pcm16.length && (realtimeFailed || reason === 'finalize-timeout' || reason === 'websocket-close')) {
      try {
        text = await batchTranscribePcm16(pcm16, realtimeFailureReason || reason);
      } catch (error) {
        console.error('[stt-fallback]', error?.message || error);
      }
    }

    if (sessionEpoch !== voiceEpoch) return;
    if (text) processTranscript(text, userId, sessionEpoch);
    else console.warn('[stt] no transcript; utterance dropped after realtime+batch STT');
  };

  const sendFinalizeIfReady = () => {
    if (!inputEnded || realtimeFailed || finalizeSent || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'Finalize' }));
      finalizeSent = true;
      console.log('[stt] finalize sent');
      completionTimer = setTimeout(() => complete('finalize-timeout'), 3000);
    } catch (error) {
      console.error('[stt] finalize failed:', error.message);
      markRealtimeFailed('finalize-error');
      complete('finalize-error');
    }
  };

  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    try { opus.destroy(); } catch {}
    try { decoder.destroy(); } catch {}

    if (realtimeFailed || !ws) {
      complete('batch-fallback');
      return;
    }

    sendFinalizeIfReady();
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      markRealtimeFailed('websocket-closed-before-finalize');
      complete('websocket-closed-before-finalize');
    }
  };

  if (!realtimeFailed) {
    ws = new WebSocket(STT_WS_URL);
    session.ws = ws;

    ws.on('open', () => {
      console.log('[stt] websocket open');
      for (const frame of pending.splice(0)) ws.send(frame);
      sendFinalizeIfReady();
    });

    ws.on('message', (data) => {
      let payload;
      try { payload = JSON.parse(String(data)); } catch { return; }
      const text = transcriptFrom(payload);
      if (text) {
        latest = text;
        console.log('[stt]', payload?.is_final ? 'final-part:' : 'interim:', text);
        if (payload?.is_final) {
          const previous = finalParts.at(-1);
          if (previous !== text) finalParts.push(text);
        }
      }

      if (payload?.speech_final && text) {
        if (!inputEnded) endInput();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => complete('speech-final'), 100);
      } else if (inputEnded && payload?.is_final && text) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => complete('final-result'), 180);
      }
    });

    ws.on('unexpected-response', (_request, response) => {
      const status = Number(response?.statusCode || 0);
      console.error('[stt] websocket unexpected response:', status);
      markRealtimeFailed(`http_${status || 'unknown'}`, status);
      if (inputEnded) complete('unexpected-response');
    });

    ws.on('error', (error) => {
      console.error('[stt] websocket error:', error.message);
      const statusMatch = String(error?.message || '').match(/\b(429)\b/);
      markRealtimeFailed(error?.message || 'websocket-error', statusMatch ? 429 : 0);
      if (inputEnded) complete('websocket-error');
    });

    ws.on('close', (code, reason) => {
      console.log('[stt] websocket close', code, String(reason || ''));
      if (!completed && !realtimeFailed) {
        markRealtimeFailed(`websocket-close-${code}`);
        if (inputEnded) complete('websocket-close');
      }
    });
  } else {
    console.warn(`[stt] realtime backoff active ${Math.max(0, realtimeSttBackoffUntil - Date.now())}ms; batch STT only`);
  }

  decoder.on('data', (pcm48) => {
    pcm48Bytes += pcm48.length;
    const pcm16 = mono16kFromStereo48k(pcm48);
    pcm16Bytes += pcm16.length;
    if (!pcm16.length) return;
    if (pcm16Chunks.length < 600) pcm16Chunks.push(Buffer.from(pcm16));

    if (!realtimeFailed && ws?.readyState === WebSocket.OPEN && !inputEnded) {
      ws.send(pcm16);
    } else if (!realtimeFailed && ws?.readyState === WebSocket.CONNECTING && !inputEnded) {
      pending.push(pcm16);
      if (pending.length > 250) pending.shift();
    }
  });

  decoder.on('error', (error) => {
    console.error('[decode]', error.message);
    endInput();
  });

  opus.on('data', (chunk) => { opusBytes += chunk.length; });
  opus.on('error', (error) => {
    console.error('[opus]', error.message);
    endInput();
  });
  opus.on('end', endInput);
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

async function connectToVoiceChannel(channel, initialUserId = '') {
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

  if (initialUserId && initialUserId !== client.user.id) {
    startReceiverSession(initialUserId);
    console.log('[rx] pre-armed user=' + initialUserId);
  }

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
      await connectToVoiceChannel(channel, interaction.user.id);

      try {
        const readyAudio = await synthesize('フォーンズです。接続しました。');
        await playMp3(readyAudio);
        await interaction.editReply(`TalkSysを「${channel.name}」へ接続しました。フォーンズ音声も正常です。`);
      } catch (error) {
        console.error('[tts-preflight]', error?.stack || error);
        await interaction.editReply(`TalkSysを「${channel.name}」へ接続しましたが、フォーンズ音声の初期テストに失敗しました。`);
      }
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
