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
const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v78-observability-common-turn-r1';
const RECEIVER_PACKET_START_TIMEOUT_MS = 5000;
const RECEIVER_CAPTURE_TIMEOUT_MS = 30000;
const VOICE_REJOIN_TIMEOUT_MS = 10000;
const DISCORD_READY_TIMEOUT_MS = 20000;
const DISCORD_HEALTH_LOG_MS = 60000;
const RECOVERY_PROMPT = 'すみません、うまく聞き取れませんでした。もう一度お願いします。';
const REQUEST_BUDGET_MS = Object.freeze({
  batchStt: 1800,
  turnStream: 35000,
  turn: 35000,
  tts: 12000,
  metrics: 5000,
  waitCue: 1800,
});

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
let recoveryAudio = null;
let recoveryAudioPromise = null;
let recoverySpeaking = false;
let realtimeSttFailureCount = 0;
let voiceRecoveryTimer = null;
let voiceRecoveryAttempts = 0;
let discordReadyWatchdog = null;
let discordHealthTimer = null;

function resetConversationState() {
  if (voiceRecoveryTimer) {
    clearTimeout(voiceRecoveryTimer);
    voiceRecoveryTimer = null;
  }
  voiceRecoveryAttempts = 0;
  try { activeTurnAbortController?.abort(); } catch {}
  activeTurnAbortController = null;
  activeTurnSerial += 1;
  history.splice(0, history.length);
  previousInteractionId = '';
  answering = false;
  pendingTurns.splice(0, pendingTurns.length);
  discordSessionId = '';
}

function boundedSignal(parentSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

function isTransientHttpStatus(status) {
  return [408, 425, 500, 502, 503, 504].includes(Number(status));
}

async function fetchWithRetry(url, init = {}, { timeoutMs = 15000, retries = 1, label = 'request' } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: boundedSignal(init.signal, timeoutMs),
      });
      if (!isTransientHttpStatus(response.status) || attempt >= retries) return response;
      console.warn(`[${label}] transient http ${response.status}; retry ${attempt + 1}/${retries}`);
      try { await response.arrayBuffer(); } catch {}
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted || attempt >= retries) throw error;
      console.warn(`[${label}] transient failure; retry ${attempt + 1}/${retries}:`, error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw lastError || new Error(`${label}_failed`);
}

function registerRealtimeSttFailure(reason = 'realtime-failed', statusCode = 0) {
  realtimeSttFailureCount = Math.min(6, realtimeSttFailureCount + 1);
  const rateLimited = statusCode === 429 || /429|rate/i.test(String(reason || ''));
  const baseMs = rateLimited ? 60000 : 10000;
  const delayMs = Math.min(300000, baseMs * (2 ** Math.max(0, realtimeSttFailureCount - 1)));
  realtimeSttBackoffUntil = Math.max(realtimeSttBackoffUntil, Date.now() + delayMs);
  console.warn(`[stt] circuit open reason=${reason} failures=${realtimeSttFailureCount} backoff=${delayMs}ms`);
  return delayMs;
}

function registerRealtimeSttHealthy() {
  if (realtimeSttFailureCount > 0 || realtimeSttBackoffUntil > 0) {
    console.log('[stt] circuit closed after successful transcript');
  }
  realtimeSttFailureCount = 0;
  realtimeSttBackoffUntil = 0;
}

function createMono16kResampler() {
  if (!ffmpegPath) throw new Error('ffmpeg_static_missing');
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-i', 'pipe:0',
    '-af', 'aresample=16000',
    '-f', 's16le',
    '-ar', '16000',
    '-ac', '1',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  ffmpeg.stderr.on('data', (d) => { stderr += String(d); });
  ffmpeg.on('error', (error) => console.error('[resample]', error.message));
  ffmpeg.on('close', (code) => {
    if (code && stderr.trim()) console.error('[resample]', stderr.trim());
  });
  return ffmpeg;
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

async function batchTranscribePcm16(pcm, reason = 'fallback', signal) {
  if (!pcm?.length) throw new Error('batch_stt_empty_pcm');
  const started = Date.now();
  const wav = pcm16MonoToWav16k(pcm);
  console.log(`[stt-fallback] batch start reason=${reason} pcm=${pcm.length}B wav=${wav.length}B`);
  const response = await fetchWithRetry(TALKSYS_BASE_URL + '/api/transcribe', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  }, {
    timeoutMs: REQUEST_BUDGET_MS.batchStt,
    retries: 0,
    label: 'stt-fallback',
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
    const response = await fetchWithRetry(TALKSYS_BASE_URL + '/api/voice-metrics', {
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
    }, {
      timeoutMs: REQUEST_BUDGET_MS.metrics,
      retries: 0,
      label: 'metrics',
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

async function fetchWaitCue(text, signal) {
  const endpoints = ['/api/search-preface', '/api/fast-reaction'];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithRetry(TALKSYS_BASE_URL + endpoint, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }, {
        timeoutMs: REQUEST_BUDGET_MS.waitCue,
        retries: 0,
        label: 'wait-cue',
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.shouldSpeak && String(body?.text || '').trim()) {
        return String(body.text).trim();
      }
    } catch (error) {
      if (signal?.aborted) return '';
      console.warn('[wait-cue] unavailable:', error?.message || error);
    }
  }
  return '';
}

async function playWaitCue(text, utteranceId, signal, shouldSkip = () => false) {
  const cueStarted = Date.now();
  const cue = await fetchWaitCue(text, signal);
  if (!cue || shouldSkip() || signal?.aborted) return { played: false, elapsedMs: Date.now() - cueStarted };
  const audio = await synthesize(cue, signal, { utteranceId, purpose: 'wait-cue' });
  if (shouldSkip() || signal?.aborted) return { played: false, elapsedMs: Date.now() - cueStarted };
  await playMp3(audio);
  const elapsedMs = Date.now() - cueStarted;
  console.log(`[wait-cue] played elapsed=${elapsedMs}ms text=${cue}`);
  return { played: true, elapsedMs };
}

async function talk(text, utteranceId = '', signal) {
  const started = Date.now();
  console.log('[turn] user:', text);
  const response = await fetchWithRetry(TALKSYS_BASE_URL + '/api/turn', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      history: history.slice(-12),
      sessionId: discordSessionId || `discord-${randomUUID()}`,
      utteranceId,
      previousInteractionId,
      channel: 'discord',
    }),
  }, {
    timeoutMs: REQUEST_BUDGET_MS.turn,
    retries: 0,
    label: 'turn',
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
    signal: boundedSignal(signal, REQUEST_BUDGET_MS.turnStream),
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
      channel: 'discord',
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

async function synthesize(text, signal, meta = {}) {
  const started = Date.now();
  const response = await fetchWithRetry(TALKSYS_BASE_URL + '/api/voice/synthesize', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + BRIDGE_TOKEN,
    },
    body: JSON.stringify({
      text,
      sessionId: discordSessionId || `discord-${randomUUID()}`,
      utteranceId: String(meta?.utteranceId || ''),
      channel: 'discord',
      purpose: String(meta?.purpose || 'answer'),
    }),
  }, {
    timeoutMs: REQUEST_BUDGET_MS.tts,
    retries: 0,
    label: 'tts',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`tts_http_${response.status}: ${detail.slice(0, 300)}`);
  }
  // The Worker-side TTS APIs currently complete synthesis before returning the body.
  // Use sentence-level pipelining instead of pretending this body is true incremental audio.
  const audio = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || 'unknown';
  const source = response.headers.get('x-talksys-voice-source') || 'unknown';
  const workerMs = Number(response.headers.get('x-talksys-tts-ms') || 0);
  const elapsedMs = Date.now() - started;
  audio.ttsSource = source;
  audio.ttsElapsedMs = elapsedMs;
  audio.ttsWorkerMs = Number.isFinite(workerMs) ? workerMs : 0;
  console.log(`[tts] ${audio.length} bytes type=${type} source=${source}`);
  console.log(`[latency] tts-http=${elapsedMs}ms worker=${audio.ttsWorkerMs || '?'}ms source=${source}`);
  return audio;
}

async function warmRecoveryAudio() {
  if (recoveryAudio?.length) return recoveryAudio;
  if (recoveryAudioPromise) return recoveryAudioPromise;
  recoveryAudioPromise = synthesize(RECOVERY_PROMPT)
    .then((audio) => {
      recoveryAudio = audio;
      console.log(`[recovery] cached ${audio.length} bytes`);
      return audio;
    })
    .finally(() => { recoveryAudioPromise = null; });
  return recoveryAudioPromise;
}

async function speakRecoveryPrompt(reason = 'pipeline-failure', sessionEpoch = voiceEpoch) {
  if (recoverySpeaking || sessionEpoch !== voiceEpoch) return false;
  recoverySpeaking = true;
  try {
    let audio = recoveryAudio;
    if (!audio?.length) audio = await warmRecoveryAudio();
    if (!audio?.length || sessionEpoch !== voiceEpoch) return false;
    player.stop(true);
    await playMp3(audio);
    console.warn(`[recovery] spoken reason=${reason}`);
    return true;
  } catch (error) {
    console.error('[recovery] unavailable:', error?.message || error);
    return false;
  } finally {
    recoverySpeaking = false;
  }
}

async function playMp3(mp3, options = {}) {
  if (!ffmpegPath) throw new Error('ffmpeg_static_missing');
  const ffmpegStarted = Date.now();
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ffmpegError = '';
  let ffmpegSpawnMs = 0;
  ffmpeg.stderr.on('data', (d) => { ffmpegError += String(d); });
  ffmpeg.stdout.once('data', () => {
    ffmpegSpawnMs = Date.now() - ffmpegStarted;
    console.log(`[latency] ffmpeg-first-output=${ffmpegSpawnMs}ms`);
  });
  ffmpeg.on('error', (error) => console.error('[ffmpeg]', error.message));
  ffmpeg.stdin.end(mp3);

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  const playbackStartedPromise = new Promise((resolve) => {
    const onPlaying = () => {
      const playbackStartedAt = Date.now();
      const measuredFfmpegMs = ffmpegSpawnMs || Math.max(0, playbackStartedAt - ffmpegStarted);
      console.log('[tx] playback started');
      try { options?.onPlaybackStart?.({ playbackStartedAt, ffmpegSpawnMs: measuredFfmpegMs }); } catch {}
      resolve({ playbackStartedAt, ffmpegSpawnMs: measuredFfmpegMs });
    };
    player.once(AudioPlayerStatus.Playing, onPlaying);
  });
  player.play(resource);

  const completionPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ffmpeg.kill('SIGKILL'); } catch {}
      player.stop(true);
      reject(new Error('playback_timeout'));
    }, 30000);
    const done = () => { clearTimeout(timeout); cleanup(); resolve(); };
    const fail = (error) => { clearTimeout(timeout); cleanup(); reject(error); };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, done);
      player.off('error', fail);
    };
    player.once(AudioPlayerStatus.Idle, done);
    player.once('error', fail);
  });

  const startedInfo = await playbackStartedPromise;
  await completionPromise;
  if (ffmpegError.trim()) console.log('[ffmpeg]', ffmpegError.trim());
  return startedInfo;
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
  const speechEndedAt = Number(speechMetrics?.speechEndedAt) || pipelineStarted;
  const clientTimings = {
    sttMs: Number(speechMetrics?.sttMs) || 0,
    speechEndToSttFinalMs: Number(speechMetrics?.speechEndToSttFinalMs ?? speechMetrics?.sttMs) || 0,
    batchSttMs: Number(speechMetrics?.batchSttMs) || 0,
    answerStartMs: Math.max(0, pipelineStarted - speechEndedAt),
    primaryMs: 0,
    verifierMs: 0,
    answerGenerationTotalMs: 0,
    firstTtsMs: 0,
    firstAudioReadyMs: 0,
    speechEndToPlaybackStartMs: 0,
    pipelineCompleteMs: 0,
    ffmpegSpawnMs: 0,
    sttMode: speechMetrics?.sttMode || 'unknown',
    sttReused: Boolean(speechMetrics?.sttReused),
    fallback: speechMetrics?.sttMode === 'batch',
    ttsProvider: '',
    error: '',
  };
  answering = true;
  let firstAudioReadyLogged = false;
  let playedSentenceCount = 0;
  let mainAnswerReady = false;

  try {
    console.log(`[stt] final user=${userId}:`, text);
    console.log('[latency] pipeline-start');

    const waitCuePromise = playWaitCue(text, utteranceId, controller.signal, () => mainAnswerReady)
      .catch((error) => {
        if (!controller.signal.aborted) console.warn('[wait-cue] failed:', error?.message || error);
        return { played: false, elapsedMs: 0 };
      });

    let firstTtsRecorded = false;
    let firstSentenceReadyPromise = null;
    let playbackChain = waitCuePromise.then(() => undefined);
    let playbackError = null;
    let queuedSentences = 0;
    let totalPlaybackMs = 0;

    const timedSynthesize = (sentence) => {
      const ttsStarted = Date.now();
      return synthesize(sentence, controller.signal, { utteranceId, purpose: 'answer' })
        .then((value) => ({ value, elapsedMs: Date.now() - ttsStarted }), (error) => ({ error }));
    };

    const queueSentence = (sentence) => {
      if (!sentence || queuedSentences >= 4) return;
      const safe = voiceSafeText(sentence);
      if (!safe) return;
      mainAnswerReady = true;
      queuedSentences += 1;

      // First sentence gets exclusive priority. Later sentences start TTS only
      // after the first audio is ready, then generate in parallel with playback.
      let audioPromise;
      if (queuedSentences === 1) {
        firstSentenceReadyPromise = timedSynthesize(safe);
        audioPromise = firstSentenceReadyPromise;
      } else {
        audioPromise = Promise.resolve(firstSentenceReadyPromise)
          .then(() => timedSynthesize(safe));
      }

      playbackChain = playbackChain.then(async () => {
        const prefetched = await audioPromise;
        if (prefetched?.error) throw prefetched.error;
        if (controller.signal.aborted || turnSerial !== activeTurnSerial || sessionEpoch !== voiceEpoch) return;
        if (!firstTtsRecorded) {
          firstTtsRecorded = true;
          clientTimings.firstTtsMs = prefetched.elapsedMs;
          clientTimings.ttsProvider = String(prefetched.value?.ttsSource || 'unknown');
        }
        if (!firstAudioReadyLogged) {
          firstAudioReadyLogged = true;
          clientTimings.firstAudioReadyMs = Date.now() - pipelineStarted;
          console.log(`[latency] first-audio-ready=${clientTimings.firstAudioReadyMs}ms source=final-answer-first-sentence`);
        }
        const playbackWallStarted = Date.now();
        await playMp3(prefetched.value, {
          onPlaybackStart: ({ playbackStartedAt, ffmpegSpawnMs }) => {
            if (!clientTimings.ffmpegSpawnMs) clientTimings.ffmpegSpawnMs = ffmpegSpawnMs;
            if (!clientTimings.speechEndToPlaybackStartMs && speechEndedAt > 0) {
              clientTimings.speechEndToPlaybackStartMs = Math.max(0, playbackStartedAt - speechEndedAt);
              console.log(`[latency] speech-end-to-playback-start=${clientTimings.speechEndToPlaybackStartMs}ms`);
            }
          },
        });
        playedSentenceCount += 1;
        totalPlaybackMs += Date.now() - playbackWallStarted;
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
      clientTimings.answerGenerationTotalMs = Number(streamedResult?.timings?.totalMs) || clientTimings.turnStreamMs;
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
      mainAnswerReady = true;
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
    clientTimings.error = String(error?.message || error || '').slice(0, 500);
    if (sessionEpoch !== voiceEpoch) return;
    if (controller.signal.aborted || turnSerial !== activeTurnSerial) {
      console.log(`[pipeline] interrupted utterance=${utteranceId}`);
    } else {
      console.error('[pipeline]', error?.stack || error);
      if (playedSentenceCount === 0) {
        await speakRecoveryPrompt('answer-pipeline-failed', sessionEpoch);
      }
    }
  } finally {
    if (!clientTimings.pipelineCompleteMs) clientTimings.pipelineCompleteMs = Date.now() - pipelineStarted;
    console.log(`[latency-summary] utterance=${utteranceId} sttMs=${clientTimings.sttMs} speechEndToSttFinalMs=${clientTimings.speechEndToSttFinalMs} batchSttMs=${clientTimings.batchSttMs} answerStartMs=${clientTimings.answerStartMs} primaryMs=${clientTimings.primaryMs} verifierMs=${clientTimings.verifierMs} answerGenerationTotalMs=${clientTimings.answerGenerationTotalMs} firstTtsMs=${clientTimings.firstTtsMs} firstAudioReadyMs=${clientTimings.firstAudioReadyMs} ffmpegSpawnMs=${clientTimings.ffmpegSpawnMs} speechEndToPlaybackStartMs=${clientTimings.speechEndToPlaybackStartMs} pipelineCompleteMs=${clientTimings.pipelineCompleteMs}`);
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
    if (!transport.claimed) registerRealtimeSttFailure(`prewarm-http-${status || 'unknown'}`, status);
    clearInterval(transport.keepAliveTimer);
    if (realtimeSttSockets.get(userId) === transport) realtimeSttSockets.delete(userId);
  });

  ws.on('error', (error) => {
    if (!transport.claimed) {
      const statusMatch = String(error?.message || '').match(/\b(429)\b/);
      registerRealtimeSttFailure(error?.message || 'prewarm-websocket-error', statusMatch ? 429 : 0);
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

function startReceiverSession(userId, speakingNow = false) {
  if (!connection) return;
  const existingSession = sessions.get(userId);
  if (existingSession) {
    if (speakingNow) existingSession.markSpeaking?.();
    return;
  }
  const sessionEpoch = voiceEpoch;
  console.log('[rx] user=' + userId);

  const opus = connection.receiver.subscribe(userId, {
    // Nova-3 endpointing (350ms) is the primary end-of-utterance signal.
    // This longer Discord silence threshold is only a safety guard.
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1600 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const resampler = createMono16kResampler();
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
  let lastAudioAt = 0;
  let usedBatchStt = false;
  let batchSttMs = 0;
  let packetStartWatchdog = null;
  let captureWatchdog = null;
  let firstPacketSeen = false;

  const clearReceiverWatchdogs = () => {
    if (packetStartWatchdog) clearTimeout(packetStartWatchdog);
    if (captureWatchdog) clearTimeout(captureWatchdog);
    packetStartWatchdog = null;
    captureWatchdog = null;
  };

  const markSpeaking = () => {
    if (inputEnded || completed || firstPacketSeen) return;
    if (packetStartWatchdog) clearTimeout(packetStartWatchdog);
    packetStartWatchdog = setTimeout(() => {
      if (completed || firstPacketSeen) return;
      console.error(`[rx] speaking produced no audio packets; resetting receiver user=${userId}`);
      clearReceiverWatchdogs();
      completed = true;
      detachWsListeners();
      sessions.delete(userId);
      try { opus.destroy(); } catch {}
      try { decoder.destroy(); } catch {}
      destroyReusableSttSocket(userId, 'receiver-no-packets');
    }, RECEIVER_PACKET_START_TIMEOUT_MS);
  };

  const session = { opus, decoder, resampler, ws: null, batchAbortController: null, markSpeaking };
  sessions.set(userId, session);
  if (speakingNow) markSpeaking();

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
    registerRealtimeSttFailure(realtimeFailureReason, statusCode);
    console.warn('[stt] realtime unavailable; using batch STT:', realtimeFailureReason);
    destroyReusableSttSocket(userId, 'realtime-failed');
  };

  const complete = async (reason = 'complete') => {
    if (completed) return;
    completed = true;
    clearTimeout(completionTimer);
    clearTimeout(settleTimer);
    clearReceiverWatchdogs();
    detachWsListeners();
    sessions.delete(userId);
    destroyReusableSttSocket(userId, 'utterance-complete');
    if (!realtimeFailed) prewarmRealtimeSttSocket(userId, sessionEpoch);

    let text = (finalParts.join(' ').trim() || latest).trim();
    const pcm16 = Buffer.concat(pcm16Chunks);
    console.log(`[rx] captured user=${userId} opus=${opusBytes}B pcm48=${pcm48Bytes}B pcm16=${pcm16Bytes}B reason=${reason} sttReuse=${reusedSocket}`);
    if (sessionEpoch !== voiceEpoch) return;

    if (!text && pcm16.length) {
      // Batch fallback is reserved for missing/failed realtime transcription only.
      try {
        usedBatchStt = true;
        const fallbackStarted = Date.now();
        const fallbackController = new AbortController();
        session.batchAbortController = fallbackController;
        text = await batchTranscribePcm16(pcm16, realtimeFailureReason || reason, fallbackController.signal);
        batchSttMs = Date.now() - fallbackStarted;
      } catch (error) {
        console.error('[stt-fallback]', error?.message || error);
      }
    }

    if (sessionEpoch !== voiceEpoch) return;
    const sttCompletedAt = Date.now();
    const speechEndedAt = lastAudioAt || inputEndedAt || sttCompletedAt;
    const speechEndToSttFinalMs = Math.max(0, sttCompletedAt - speechEndedAt);
    const sttMs = speechEndToSttFinalMs;
    if (text) {
      processTranscript(text, userId, sessionEpoch, {
        sttMs,
        speechEndToSttFinalMs,
        batchSttMs,
        sttMode: usedBatchStt ? 'batch' : 'realtime',
        sttReused: reusedSocket,
        speechEndedAt,
        utteranceId: `utt-${randomUUID()}`,
      });
    } else {
      console.error('[stt] no transcript after realtime+batch; speaking recovery prompt');
      await speakRecoveryPrompt('stt-exhausted', sessionEpoch);
    }
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

  const endInput = (reason = 'discord-silence') => {
    if (inputEnded) return;
    inputEnded = true;
    inputEndedAt = Date.now();
    clearReceiverWatchdogs();
    try { opus.destroy(); } catch {}
    try { decoder.destroy(); } catch {}
    try { resampler.stdin.end(); } catch {}

    if (reason === 'speech-final') {
      complete('speech-final');
      return;
    }

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
      registerRealtimeSttHealthy();
      console.log('[stt]', payload?.is_final ? 'final-part:' : 'interim:', text);
      if (payload?.is_final) {
        const previous = finalParts.at(-1);
        if (previous !== text) finalParts.push(text);
      }
    }

    if (payload?.speech_final && text) {
      // Nova-3 endpointing is authoritative on the normal path. Do not wait
      // for Discord's 1600ms silence safety guard or send an extra Finalize.
      if (!inputEnded) endInput('speech-final');
      else complete('speech-final');
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
    if (!firstPacketSeen) {
      firstPacketSeen = true;
      if (packetStartWatchdog) clearTimeout(packetStartWatchdog);
      packetStartWatchdog = null;
      captureWatchdog = setTimeout(() => {
        if (completed || inputEnded) return;
        console.error(`[rx] capture watchdog forcing finalize user=${userId}`);
        endInput();
      }, RECEIVER_CAPTURE_TIMEOUT_MS);
    }
    pcm48Bytes += pcm48.length;
    if (!resampler.stdin.destroyed && !resampler.stdin.writableEnded) {
      resampler.stdin.write(pcm48);
    }
  });

  resampler.stdout.on('data', (pcm16) => {
    pcm16Bytes += pcm16.length;
    if (!pcm16.length) return;
    lastAudioAt = Date.now();
    if (pcm16Chunks.length < 600) pcm16Chunks.push(Buffer.from(pcm16));
    if (transport) transport.lastAudioAt = Date.now();

    if (!realtimeFailed && ws?.readyState === WebSocket.OPEN && !inputEnded) {
      ws.send(pcm16);
    } else if (!realtimeFailed && ws?.readyState === WebSocket.CONNECTING && !inputEnded) {
      pending.push(Buffer.from(pcm16));
      if (pending.length > 250) pending.shift();
    }
  });

  resampler.stdout.on('error', (error) => {
    console.error('[resample]', error.message);
    markRealtimeFailed('resampler-output-error');
    endInput();
  });

  decoder.on('error', (error) => {
    console.error('[decode]', error.message);
    endInput();
  });
  resampler.on('error', (error) => {
    console.error('[resample]', error.message);
    markRealtimeFailed('resampler-process-error');
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
    try { session.batchAbortController?.abort(); } catch {}
    try { session.opus?.destroy(); } catch {}
    try { session.decoder?.destroy(); } catch {}
    try { session.resampler?.stdin?.end(); } catch {}
    try { session.resampler?.kill?.('SIGKILL'); } catch {}
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
    startReceiverSession(userId, true);
  });

  if (initialUserId && initialUserId !== client.user.id) {
    startReceiverSession(initialUserId, false);
    console.log('[rx] pre-armed user=' + initialUserId);
  }

  const boundConnection = connection;
  boundConnection.on('stateChange', (_oldState, newState) => {
    if (boundConnection !== connection) return;
    console.log(`[discord] voice state=${newState.status}`);
    if (newState.status === VoiceConnectionStatus.Ready) {
      voiceRecoveryAttempts = 0;
      if (voiceRecoveryTimer) {
        clearTimeout(voiceRecoveryTimer);
        voiceRecoveryTimer = null;
      }
      boundConnection.subscribe(player);
      return;
    }
    if (newState.status !== VoiceConnectionStatus.Disconnected) return;
    if (voiceRecoveryTimer) return;
    const scheduleRecovery = () => {
      if (boundConnection !== connection || boundConnection.state.status === VoiceConnectionStatus.Destroyed) return;
      const delayMs = Math.min(8000, 500 * (2 ** Math.min(voiceRecoveryAttempts, 4)));
      voiceRecoveryTimer = setTimeout(async () => {
        voiceRecoveryTimer = null;
        if (boundConnection !== connection || boundConnection.state.status === VoiceConnectionStatus.Destroyed) return;
        voiceRecoveryAttempts += 1;
        try {
          const accepted = boundConnection.rejoin();
          if (!accepted) throw new Error('voice_rejoin_rejected');
          await entersState(boundConnection, VoiceConnectionStatus.Ready, VOICE_REJOIN_TIMEOUT_MS);
          if (boundConnection === connection) {
            boundConnection.subscribe(player);
            voiceRecoveryAttempts = 0;
            console.log('[discord] voice rejoin recovered');
          }
        } catch (error) {
          console.error(`[discord] voice rejoin failed attempt=${voiceRecoveryAttempts}:`, error?.message || error);
          if (voiceRecoveryAttempts < 5) scheduleRecovery();
        }
      }, delayMs);
    };
    console.warn('[discord] voice disconnected; scheduling rejoin');
    scheduleRecovery();
  });
  boundConnection.on('error', (error) => console.error('[discord] voice connection error:', error?.message || error));

  console.log('[discord] voice ready:', channel.name);
  console.log('[discord] conversation session:', discordSessionId);
  await playConnectionGreeting();
  warmRecoveryAudio().catch((error) => console.warn('[recovery] warmup failed:', error?.message || error));
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
  if (discordReadyWatchdog) {
    clearTimeout(discordReadyWatchdog);
    discordReadyWatchdog = null;
  }
  if (discordHealthTimer) clearInterval(discordHealthTimer);
  discordHealthTimer = setInterval(() => {
    console.log(`[discord] gateway health ready=${client.isReady()} ping=${client.ws.ping}ms guilds=${client.guilds.cache.size}`);
  }, DISCORD_HEALTH_LOG_MS);
  console.log(`[discord] gateway ready user=${client.user?.tag || client.user?.id || 'unknown'} ping=${client.ws.ping}ms`);
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
  if (!['talksys', 'leave'].includes(interaction.commandName)) return;

  console.log(`[interaction] received command=/${interaction.commandName} guild=${interaction.guild.id} user=${interaction.user.id}`);
  try {
    await interaction.deferReply({ ephemeral: true });
    console.log(`[interaction] acked command=/${interaction.commandName}`);
  } catch (error) {
    console.error(`[interaction] ack failed command=/${interaction.commandName}:`, error?.stack || error);
    return;
  }

  try {
    if (interaction.commandName === 'talksys') {
      const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);
      const channelId = voiceState?.channelId;
      if (!channelId) {
        await interaction.editReply('先にボイスチャンネルへ参加してから /talksys を実行してください。');
        return;
      }

      const channel = await interaction.guild.channels.fetch(channelId);
      await connectToVoiceChannel(channel, interaction.user.id);
      await interaction.editReply(`TalkSysを「${channel.name}」へ接続しました。`);
      return;
    }

    destroyVoiceConnection();
    await interaction.editReply('TalkSysをボイスチャンネルから退出させました。');
  } catch (error) {
    console.error('[command]', error?.stack || error);
    try {
      await interaction.editReply('TalkSysのVC操作に失敗しました。コンソールログを確認してください。');
    } catch (replyError) {
      console.error('[command] failure reply failed:', replyError?.message || replyError);
    }
  }
});

client.on('error', (error) => console.error('[discord]', error));
client.on('warn', (info) => console.warn('[discord] warning:', info));
client.on('shardError', (error, shardId) => console.error(`[discord] shard error id=${shardId}:`, error?.stack || error));
client.on('shardDisconnect', (event, shardId) => console.error(`[discord] shard disconnected id=${shardId} code=${event?.code ?? 'unknown'}`));
client.on('shardReconnecting', (shardId) => console.warn(`[discord] shard reconnecting id=${shardId}`));
client.on('shardResume', (shardId, replayedEvents) => console.log(`[discord] shard resumed id=${shardId} replayed=${replayedEvents}`));
player.on('error', (error) => console.error('[player]', error.message));

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason?.stack || reason);
});

process.on('SIGINT', () => {
  if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
  if (discordHealthTimer) clearInterval(discordHealthTimer);
  destroyVoiceConnection();
  client.destroy();
  process.exit(0);
});

discordReadyWatchdog = setTimeout(() => {
  if (client.isReady()) return;
  console.error(`[fatal] Discord Gateway did not reach Ready within ${DISCORD_READY_TIMEOUT_MS}ms`);
  client.destroy();
  process.exit(2);
}, DISCORD_READY_TIMEOUT_MS);

client.login(DISCORD_TOKEN).catch((error) => {
  if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
  console.error('[fatal] Discord login failed:', error?.stack || error);
  client.destroy();
  process.exit(2);
});
