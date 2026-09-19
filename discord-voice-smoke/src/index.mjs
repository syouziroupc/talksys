import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v71-prewarm-bargein-r1';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
const sessions = new Map();
const realtimeSttSockets = new Map();
const history = [];
let previousInteractionId = '';
let connection;
let answering = false;
let voiceEpoch = 0;
let realtimeSttBackoffUntil = 0;
let discordSessionId = '';
const pendingTurns = [];
let activeTurnAbortController = null;
let activeTurnSerial = 0;

function resetConversationState() {
  try { activeTurnAbortController?.abort(); } catch {}
  activeTurnAbortController = null;
  activeTurnSerial += 1;
  history.splice(0, history.length);
  previousInteractionId = '';
  answering = false;
  pendingTurns.splice(0, pendingTurns.length);
  discordSessionId = '';
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

function voiceSafeText(text) {
  let value = String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\n)\s*(?:#{1,6}|[-+*•]|\d+[.)、])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = value.match(/[^。！？!?]+[。！？!?]?/g) || [value];
  return sentences.slice(0, 4).join('').trim() || value;
}
function voiceChunks(text) {
  const value = voiceSafeText(text);
  const sentences = value.match(/[^。！？!?]+[。！？!?]?/g) || [value];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean).slice(0, 4);
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
  const started = Date.now();
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
  console.log(`[latency] batch-stt-http=${Date.now() - started}ms server=${body.elapsedMs ?? '?'}ms`);
  return String(body.text).trim();
}

async function postVoiceMetrics(text, timings = {}, utteranceId = '') {
  try {
    const response = await fetch(TALKSYS_BASE_URL + '/api/voice-metrics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        text,
        sessionId: discordSessionId || `discord-${randomUUID()}`,
        utteranceId,
        timings,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(`[metrics] voice metrics rejected status=${response.status} ${detail.slice(0, 160)}`);
      return false;
    }
    console.log('[metrics] voice latency persisted');
    return true;
  } catch (error) {
    console.warn('[metrics] voice metrics failed:', error?.message || error);
    return false;
  }
}

async function talk(text, utteranceId = '', signal) {
  const started = Date.now();
  console.log('[turn] user:', text);
  const response = await fetch(TALKSYS_BASE_URL + '/api/turn', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      history: history.slice(-12),
      sessionId: discordSessionId || `discord-${randomUUID()}`,
      utteranceId,
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

async function talkStream(text, onSentence, utteranceId = '', signal) {
  const started = Date.now();
  console.log('[turn-stream] user:', text);
  const response = await fetch(TALKSYS_BASE_URL + '/api/turn-stream', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + BRIDGE_TOKEN,
    },
    body: JSON.stringify({
      text,
      history: history.slice(-12),
      sessionId: discordSessionId || `discord-${randomUUID()}`,
      utteranceId,
      previousInteractionId,
      channel: 'discord-voice-smoke',
    }),
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !/text\/event-stream/i.test(type) || !response.body) {
    const detail = await response.text().catch(() => '');
    console.warn(`[turn-stream] unavailable status=${response.status}; falling back to /api/turn ${detail.slice(0, 160)}`);
    return { answer: await talk(text, utteranceId, signal), streamed: false, sentenceCount: 0, clientElapsedMs: Date.now() - started, timings: {} };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneBody = null;
  let sentenceCount = 0;

  const consumeBlock = (block) => {
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    let event = null;
    try { event = JSON.parse(data); } catch { return; }
    if (event?.type === 'sentence' && event?.text) {
      sentenceCount += 1;
      onSentence(String(event.text));
      return;
    }
    if (event?.type === 'done' && event?.ok && event?.answer) {
      doneBody = event;
      return;
    }
    if (event?.type === 'error') {
      const error = new Error(event?.error || 'turn_stream_failed');
      error.partial = Boolean(event?.partial || sentenceCount > 0);
      throw error;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done }).replace(/\r/g, '');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consumeBlock(block);
    }
    if (done) break;
  }

  if (!doneBody?.answer) {
    if (sentenceCount === 0) {
      console.warn('[turn-stream] ended without done event; falling back to /api/turn');
      return { answer: await talk(text, utteranceId, signal), streamed: false, sentenceCount: 0, clientElapsedMs: Date.now() - started, timings: {} };
    }
    const error = new Error('turn_stream_ended_after_partial_output');
    error.partial = true;
    throw error;
  }

  if (doneBody.interactionId) previousInteractionId = doneBody.interactionId;
  history.push({ role: 'user', content: text }, { role: 'assistant', content: doneBody.answer });
  if (history.length > 24) history.splice(0, history.length - 24);
  const elapsed = Date.now() - started;
  console.log('[turn-stream] assistant:', doneBody.answer);
  console.log(`[latency] turn-stream=${elapsed}ms server-total=${doneBody?.timings?.totalMs ?? '?'}ms primary=${doneBody?.timings?.primaryMs ?? '?'}ms verifier=${doneBody?.timings?.verifierMs ?? '?'}ms sentences=${sentenceCount}`);
  return { answer: doneBody.answer, streamed: sentenceCount > 0, sentenceCount, clientElapsedMs: elapsed, timings: doneBody?.timings || {} };
}

async function synthesize(text, signal) {
  const started = Date.now();
  const response = await fetch(TALKSYS_BASE_URL + '/api/voice/synthesize', {
    method: 'POST',
    signal,
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

async function processTranscript(text, userId, sessionEpoch, speechMetrics = {}) {
  if (!text || sessionEpoch !== voiceEpoch) return;
  if (answering) {
    if (pendingTurns.length < 3) {
      pendingTurns.push({ text, userId, sessionEpoch, speechMetrics });
      console.log(`[queue] buffered user=${userId}: ${text}`);
    } else {
      console.warn(`[queue] dropped user=${userId}: queue full`);
    }
    return;
  }

  const pipelineStarted = Date.now();
  const utteranceId = String(speechMetrics?.utteranceId || `utt-${randomUUID()}`);
  const turnSerial = ++activeTurnSerial;
  const controller = new AbortController();
  try { activeTurnAbortController?.abort(); } catch {}
  activeTurnAbortController = controller;
  const clientTimings = {
    sttMs: Number(speechMetrics?.sttMs) || 0,
    sttMode: speechMetrics?.sttMode || 'unknown',
    sttReused: Boolean(speechMetrics?.sttReused),
  };
  answering = true;
  try {
    console.log(`[stt] final user=${userId}:`, text);
    console.log('[latency] pipeline-start');

    let firstAudioReadyLogged = false;
    let firstTtsRecorded = false;
    let playbackChain = Promise.resolve();
    let playbackError = null;
    let queuedSentences = 0;
    let totalPlaybackMs = 0;

    const queueSentence = (sentence) => {
      if (!sentence || queuedSentences >= 4) return;
      queuedSentences += 1;
      const ttsStarted = Date.now();
      const audioPromise = synthesize(sentence, controller.signal)
        .then((value) => ({ value, elapsedMs: Date.now() - ttsStarted }), (error) => ({ error }));
      playbackChain = playbackChain.then(async () => {
        const prefetched = await audioPromise;
        if (prefetched.error) throw prefetched.error;
        if (controller.signal.aborted || turnSerial !== activeTurnSerial || sessionEpoch !== voiceEpoch) return;
        if (!firstTtsRecorded) {
          firstTtsRecorded = true;
          clientTimings.firstTtsMs = prefetched.elapsedMs;
        }
        if (!firstAudioReadyLogged) {
          firstAudioReadyLogged = true;
          clientTimings.firstAudioReadyMs = Date.now() - pipelineStarted;
          console.log(`[latency] first-audio-ready=${clientTimings.firstAudioReadyMs}ms source=verifier-stream`);
        }
        const playbackStarted = Date.now();
        await playMp3(prefetched.value);
        totalPlaybackMs += Date.now() - playbackStarted;
      });
      playbackChain.catch((error) => { playbackError ||= error; });
    };

    let streamedResult;
    let streamError = null;
    try {
      streamedResult = await talkStream(text, queueSentence, utteranceId, controller.signal);
      clientTimings.turnStreamMs = Number(streamedResult?.clientElapsedMs) || 0;
      clientTimings.serverTotalMs = Number(streamedResult?.timings?.totalMs) || 0;
      clientTimings.primaryMs = Number(streamedResult?.timings?.primaryMs) || 0;
      clientTimings.verifierMs = Number(streamedResult?.timings?.verifierMs) || 0;
      clientTimings.streamed = Boolean(streamedResult?.streamed);
    } catch (error) {
      streamError = error;
      if (!controller.signal.aborted && !error?.partial && queuedSentences === 0) {
        console.warn('[turn-stream] runtime failure before audio; falling back to /api/turn:', error?.message || error);
        try {
          const answer = await talk(text, utteranceId, controller.signal);
          streamedResult = {
            answer,
            streamed: false,
            sentenceCount: 0,
            clientElapsedMs: Date.now() - pipelineStarted,
            timings: {},
          };
          streamError = null;
        } catch (fallbackError) {
          streamError = fallbackError;
        }
      }
    }

    if (!streamError && streamedResult && !streamedResult.streamed) {
      const spokenAnswer = voiceSafeText(streamedResult.answer);
      const chunks = voiceChunks(spokenAnswer);
      for (const chunk of chunks) queueSentence(chunk);
    }

    await playbackChain.catch((error) => { playbackError ||= error; });
    clientTimings.playbackMs = totalPlaybackMs;
    clientTimings.pipelineCompleteMs = Date.now() - pipelineStarted;
    if (sessionEpoch !== voiceEpoch) return;
    if (streamError) throw streamError;
    if (playbackError) throw playbackError;
    console.log(`[latency] pipeline-complete=${clientTimings.pipelineCompleteMs}ms streamed=${Boolean(streamedResult?.streamed)} sentences=${queuedSentences}`);
  } catch (error) {
    if (sessionEpoch !== voiceEpoch) return;
    if (controller.signal.aborted || turnSerial !== activeTurnSerial) {
      console.log(`[pipeline] interrupted utterance=${utteranceId}`);
    } else {
      console.error('[pipeline]', error?.stack || error);
    }
  } finally {
    if (!clientTimings.pipelineCompleteMs) clientTimings.pipelineCompleteMs = Date.now() - pipelineStarted;
    postVoiceMetrics(text, clientTimings, utteranceId).catch(() => {});
    if (activeTurnAbortController === controller) activeTurnAbortController = null;
    if (turnSerial === activeTurnSerial && sessionEpoch === voiceEpoch) {
      answering = false;
      const next = pendingTurns.shift();
      if (next && next.sessionEpoch === voiceEpoch) {
        setTimeout(() => processTranscript(next.text, next.userId, next.sessionEpoch, next.speechMetrics), 0);
      }
    }
  }
}

function interruptActiveAnswer(reason = 'user-speech') {
  if (!answering && player.state.status !== AudioPlayerStatus.Playing) return false;
  activeTurnSerial += 1;
  const controller = activeTurnAbortController;
  activeTurnAbortController = null;
  try { controller?.abort(); } catch {}
  player.stop(true);
  answering = false;
  pendingTurns.splice(0, pendingTurns.length);
  console.log(`[barge-in] interrupted active answer reason=${reason}`);
  return true;
}

function destroyReusableSttSocket(userId, reason = 'reset') {
  const transport = realtimeSttSockets.get(userId);
  if (!transport) return;
  realtimeSttSockets.delete(userId);
  clearInterval(transport.keepAliveTimer);
  try {
    if (transport.ws?.readyState === WebSocket.OPEN) transport.ws.close(1000, reason);
    else transport.ws?.terminate();
  } catch {}
}

function createRealtimeSttTransport(userId, sessionEpoch, claimed = true) {
  const ws = new WebSocket(STT_WS_URL);
  const transport = {
    ws,
    epoch: sessionEpoch,
    lastAudioAt: 0,
    openedAt: 0,
    keepAliveTimer: null,
    claimed,
  };
  realtimeSttSockets.set(userId, transport);

  ws.on('open', () => {
    transport.openedAt = Date.now();
    console.log(`[stt] websocket open user=${userId} mode=${transport.claimed ? 'active' : 'prewarm'}`);
    clearInterval(transport.keepAliveTimer);
    transport.keepAliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - transport.lastAudioAt < 3000) return;
      try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
    }, 4000);
  });

  ws.on('unexpected-response', (_request, response) => {
    const status = Number(response?.statusCode || 0);
    if (status === 429) {
      realtimeSttBackoffUntil = Date.now() + 60_000;
      console.warn('[stt] websocket 429; batch STT forced for 60s');
    }
    clearInterval(transport.keepAliveTimer);
    if (realtimeSttSockets.get(userId) === transport) realtimeSttSockets.delete(userId);
  });

  ws.on('error', (error) => {
    if (/\b429\b/.test(String(error?.message || ''))) {
      realtimeSttBackoffUntil = Date.now() + 60_000;
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(transport.keepAliveTimer);
    if (realtimeSttSockets.get(userId) === transport) realtimeSttSockets.delete(userId);
    console.log('[stt] websocket close', code, String(reason || ''), 'user=' + userId);
  });

  return transport;
}

function acquireRealtimeSttSocket(userId, sessionEpoch) {
  const existing = realtimeSttSockets.get(userId);
  if (existing && existing.epoch === sessionEpoch && !existing.claimed
    && (existing.ws?.readyState === WebSocket.OPEN || existing.ws?.readyState === WebSocket.CONNECTING)) {
    existing.claimed = true;
    console.log(`[stt] websocket prewarm claimed user=${userId} state=${existing.ws.readyState}`);
    return { transport: existing, reused: true };
  }
  if (existing) destroyReusableSttSocket(userId, 'fresh-utterance');

  return { transport: createRealtimeSttTransport(userId, sessionEpoch, true), reused: false };
}

function prewarmRealtimeSttSocket(userId, sessionEpoch) {
  if (sessionEpoch !== voiceEpoch || Date.now() < realtimeSttBackoffUntil) return false;
  const existing = realtimeSttSockets.get(userId);
  if (existing) {
    if (existing.epoch === sessionEpoch && !existing.claimed
      && (existing.ws?.readyState === WebSocket.OPEN || existing.ws?.readyState === WebSocket.CONNECTING)) return true;
    if (existing.claimed) return false;
    destroyReusableSttSocket(userId, 'stale-prewarm');
  }
  createRealtimeSttTransport(userId, sessionEpoch, false);
  console.log(`[stt] websocket prewarm user=${userId}`);
  return true;
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
  let transport = null;
  let reusedSocket = false;
  let inputEndedAt = 0;
  let usedBatchStt = false;

  const session = { opus, decoder, ws: null };
  sessions.set(userId, session);

  const detachWsListeners = () => {
    if (!ws) return;
    ws.off('open', onWsOpen);
    ws.off('message', onWsMessage);
    ws.off('unexpected-response', onWsUnexpectedResponse);
    ws.off('error', onWsError);
    ws.off('close', onWsClose);
  };

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
    destroyReusableSttSocket(userId, 'realtime-failed');
  };

  const complete = async (reason = 'complete') => {
    if (completed) return;
    completed = true;
    clearTimeout(completionTimer);
    clearTimeout(settleTimer);
    detachWsListeners();
    sessions.delete(userId);
    destroyReusableSttSocket(userId, 'utterance-complete');
    if (!realtimeFailed) prewarmRealtimeSttSocket(userId, sessionEpoch);

    let text = (finalParts.join(' ').trim() || latest).trim();
    const pcm16 = Buffer.concat(pcm16Chunks);
    console.log(`[rx] captured user=${userId} opus=${opusBytes}B pcm48=${pcm48Bytes}B pcm16=${pcm16Bytes}B reason=${reason} sttReuse=${reusedSocket}`);
    if (sessionEpoch !== voiceEpoch) return;

    if (!text && pcm16.length && (realtimeFailed || reason === 'finalize-timeout' || reason === 'websocket-close')) {
      try {
        usedBatchStt = true;
        text = await batchTranscribePcm16(pcm16, realtimeFailureReason || reason);
      } catch (error) {
        console.error('[stt-fallback]', error?.message || error);
      }
    }

    if (sessionEpoch !== voiceEpoch) return;
    const sttMs = inputEndedAt ? Math.max(0, Date.now() - inputEndedAt) : 0;
    if (text) processTranscript(text, userId, sessionEpoch, {
      sttMs,
      sttMode: usedBatchStt ? 'batch' : 'realtime',
      sttReused: reusedSocket,
      utteranceId: `utt-${randomUUID()}`,
    });
    else console.warn('[stt] no transcript; utterance dropped after realtime+batch STT');
  };

  const sendFinalizeIfReady = () => {
    if (!inputEnded || realtimeFailed || finalizeSent || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'Finalize' }));
      finalizeSent = true;
      console.log('[stt] finalize sent');
      completionTimer = setTimeout(() => {
        markRealtimeFailed('finalize-timeout');
        complete('finalize-timeout');
      }, 1500);
    } catch (error) {
      console.error('[stt] finalize failed:', error.message);
      markRealtimeFailed('finalize-error');
      complete('finalize-error');
    }
  };

  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    inputEndedAt = Date.now();
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

  function onWsOpen() {
    console.log(`[stt] utterance websocket ready user=${userId} reused=${reusedSocket}`);
    for (const frame of pending.splice(0)) ws.send(frame);
    sendFinalizeIfReady();
  }

  function onWsMessage(data) {
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
    } else if (inputEnded && payload?.from_finalize) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => complete('from-finalize'), 80);
    } else if (inputEnded && payload?.is_final && text) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => complete('final-result'), 180);
    }
  }

  function onWsUnexpectedResponse(_request, response) {
    const status = Number(response?.statusCode || 0);
    console.error('[stt] websocket unexpected response:', status);
    markRealtimeFailed(`http_${status || 'unknown'}`, status);
    if (inputEnded) complete('unexpected-response');
  }

  function onWsError(error) {
    console.error('[stt] websocket error:', error.message);
    const statusMatch = String(error?.message || '').match(/\b(429)\b/);
    markRealtimeFailed(error?.message || 'websocket-error', statusMatch ? 429 : 0);
    if (inputEnded) complete('websocket-error');
  }

  function onWsClose(code, reason) {
    if (completed) return;
    console.log('[stt] websocket close', code, String(reason || ''));
    if (!realtimeFailed) markRealtimeFailed(`websocket-close-${code}`);
    if (inputEnded) complete('websocket-close');
  }

  if (!realtimeFailed) {
    const acquired = acquireRealtimeSttSocket(userId, sessionEpoch);
    transport = acquired.transport;
    reusedSocket = acquired.reused;
    ws = transport.ws;
    session.ws = ws;

    ws.on('open', onWsOpen);
    ws.on('message', onWsMessage);
    ws.on('unexpected-response', onWsUnexpectedResponse);
    ws.on('error', onWsError);
    ws.on('close', onWsClose);

    if (ws.readyState === WebSocket.OPEN) {
      queueMicrotask(onWsOpen);
    }
  } else {
    console.warn(`[stt] realtime backoff active ${Math.max(0, realtimeSttBackoffUntil - Date.now())}ms; batch STT only`);
  }

  decoder.on('data', (pcm48) => {
    pcm48Bytes += pcm48.length;
    const pcm16 = mono16kFromStereo48k(pcm48);
    pcm16Bytes += pcm16.length;
    if (!pcm16.length) return;
    if (pcm16Chunks.length < 600) pcm16Chunks.push(Buffer.from(pcm16));
    if (transport) transport.lastAudioAt = Date.now();

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
  }
  sessions.clear();
  for (const userId of [...realtimeSttSockets.keys()]) {
    destroyReusableSttSocket(userId, 'voice-disconnect');
  }
  player.stop(true);
  try { connection?.destroy(); } catch {}
  connection = undefined;
}

async function playConnectionGreeting() {
  try {
    const audio = await synthesize('フォーンズです。接続しました。');
    await playMp3(audio);
    console.log('[greeting] connection greeting played');
  } catch (error) {
    console.warn('[greeting] connection greeting failed; voice connection remains active:', error?.message || error);
  }
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
  discordSessionId = `discord-${channel.guild.id}-${channel.id}-${randomUUID()}`;
  connection.receiver.speaking.on('start', (userId) => {
    if (userId === client.user.id) return;
    interruptActiveAnswer('user-speech');
    startReceiverSession(userId);
  });

  if (initialUserId && initialUserId !== client.user.id) {
    startReceiverSession(initialUserId);
    console.log('[rx] pre-armed user=' + initialUserId);
  }

  console.log('[discord] voice ready:', channel.name);
  console.log('[discord] conversation session:', discordSessionId);
  await playConnectionGreeting();
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
    console.log('[discord] bridge revision:', DISCORD_BRIDGE_REVISION);
    console.log('[discord] output mode: TalkSys TTS (permanent shared token)');

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
