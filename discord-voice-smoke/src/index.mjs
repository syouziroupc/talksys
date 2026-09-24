import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
import { WEB_VOICE_CAPTURE_POLICY, pcm16Level } from '../../src/voice-capture-policy.js';
import { fastReaction, sameUtterance, classifyVoiceTurn, isIgnorableSttFailure } from '../../src/voice-fast-reaction.js';

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
const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v100-resolved-stt-order-r1';
const MAX_HISTORY = 14;
const RECEIVER_PACKET_START_TIMEOUT_MS = 5000;
const VOICE_REJOIN_TIMEOUT_MS = 10000;
const DISCORD_READY_TIMEOUT_MS = 20000;
const DISCORD_HEALTH_LOG_MS = 60000;
const RECOVERY_PROMPT = 'すみません、うまく聞き取れませんでした。もう一度お願いします。';
const BOT_ECHO_WINDOW_MS = 20000;
const RECENT_USER_TURN_WINDOW_MS = 2500;
const BOT_OVERLAP_SHORT_TEXT_MAX = 12;
const DISCORD_SEGMENT_SILENCE_MS = WEB_VOICE_CAPTURE_POLICY.silenceMs;
const STT_LOW_CONFIDENCE_THRESHOLD = 0.88;
const BARGE_IN_CONFIRM_MS = 150;
const BARGE_IN_RELAX_FACTOR = 0.85;
const BARGE_IN_RMS_THRESHOLD = WEB_VOICE_CAPTURE_POLICY.startRmsMin * BARGE_IN_RELAX_FACTOR;
const BARGE_IN_PEAK_THRESHOLD = WEB_VOICE_CAPTURE_POLICY.peakGateMin * BARGE_IN_RELAX_FACTOR;
const STT_GLOSSARY = Object.freeze([
  { canonical: 'TalkSys', aliases: ['トークシス','トークシステム','Talk Sys','TalkSis','TalkSIS'], always: true },
  { canonical: 'Discord', aliases: ['ディスコード','ディスコート','デスコード','Discored'], always: true },
  { canonical: 'Gemini', aliases: ['ジェミニ','ゼミニ','Gemeni','Geminy'], always: true },
  { canonical: 'Whisper', aliases: ['ウィスパー','ウイスパー','Wisper','Whispher'], always: true },
  { canonical: 'Cloudflare', aliases: ['クラウドフレア','Cloud Flare'], always: false },
  { canonical: 'GitHub', aliases: ['ギットハブ','Github','Git Hub'], always: false },
  { canonical: 'OpenAI', aliases: ['オープンAI','Open AI'], always: false },
]);
const REQUEST_BUDGET_MS = Object.freeze({
  stt: 30000,
  turn: 35000,
  tts: 12000,
  waitCue: 1800,
  fastReaction: 1800,
  metrics: 5000,
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
const sessions = new Map();
const history = [];
let searchTrace = null;
let previousInteractionId = '';
let connection;
let answering = false;
let activeUserText = '';
let activeUserUtteranceId = '';
let voiceEpoch = 0;
let voiceUtteranceSerial = 0;
const latestResolvedVoiceByUser = new Map();
let discordSessionId = '';
const pendingTurns = [];
let activeTurnAbortController = null;
let activeTurnSerial = 0;
let activeWaitCue = null;
let activeFastReaction = null;
let preAnswerCueSerial = 0;
const fastReactionAudioCache = new Map();
const realtimeHelpers = new Map();
const recentBotSpeech = [];
const recentAcceptedUserTurns = [];
let runtimeLogChannel = null;
let runtimeLogMessage = null;
let runtimeLogFlushTimer = null;
const runtimeLogLines = [];
let activeBotPlaybackRecord = null;
let lastBotPlaybackEndedAt = 0;
let lastUserSpeechAt = 0;
let lastUserPcmAt = 0;
let recoveryAudio = null;
let recoveryAudioPromise = null;
let recoverySpeaking = false;
let voiceRecoveryTimer = null;
let voiceRecoveryAttempts = 0;
let discordReadyWatchdog = null;
let discordHealthTimer = null;
let windowsTtsQueue = Promise.resolve();

function resetConversationState() {
  if (voiceRecoveryTimer) {
    clearTimeout(voiceRecoveryTimer);
    voiceRecoveryTimer = null;
  }
  voiceRecoveryAttempts = 0;
  try { activeTurnAbortController?.abort(); } catch {}
  try { activeWaitCue?.stop?.('reset'); } catch {}
  try { activeFastReaction?.stop?.('reset'); } catch {}
  activeTurnAbortController = null;
  activeWaitCue = null;
  activeFastReaction = null;
  preAnswerCueSerial += 1;
  recentBotSpeech.splice(0, recentBotSpeech.length);
  recentAcceptedUserTurns.splice(0, recentAcceptedUserTurns.length);
  activeBotPlaybackRecord = null;
  lastBotPlaybackEndedAt = 0;
  lastUserSpeechAt = 0;
  lastUserPcmAt = 0;
  activeTurnSerial += 1;
  history.splice(0, history.length);
  searchTrace = null;
  previousInteractionId = '';
  answering = false;
  activeUserText = '';
  activeUserUtteranceId = '';
  pendingTurns.splice(0, pendingTurns.length);
  latestResolvedVoiceByUser.clear();
  discordSessionId = '';
}

function pruneRecentBotSpeech(now = Date.now()) {
  while (recentBotSpeech.length && now - (recentBotSpeech[0]?.startedAt || 0) > BOT_ECHO_WINDOW_MS) {
    recentBotSpeech.shift();
  }
}

function rememberBotSpeech(text, purpose = '', startedAt = Date.now()) {
  const value = String(text || '').trim();
  if (!value) return null;
  pruneRecentBotSpeech(startedAt);
  const record = { text: value, purpose, startedAt, endedAt: 0 };
  recentBotSpeech.push(record);
  return record;
}

function finishBotSpeech(record, endedAt = Date.now()) {
  if (record) record.endedAt = endedAt;
}

function looksLikeRecentBotEcho(text, timeline = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const now = Date.now();
  pruneRecentBotSpeech(now);
  const captureStart = Number(timeline.discordReceiveStartAt || timeline.firstPcmAt || 0);
  const captureEnd = Number(timeline.utteranceEndAt || now);
  for (let i = recentBotSpeech.length - 1; i >= 0; i -= 1) {
    const record = recentBotSpeech[i];
    const playbackStart = Number(record.startedAt || 0);
    const playbackEnd = Number(record.endedAt || now);
    const overlaps = captureStart > 0
      ? captureStart <= playbackEnd + 3500 && captureEnd >= playbackStart - 250
      : now - playbackStart <= BOT_ECHO_WINDOW_MS;
    if (overlaps && sameUtterance(value, record.text)) return record;
  }
  return null;
}

function pruneRecentAcceptedUserTurns(now = Date.now()) {
  while (recentAcceptedUserTurns.length && now - (recentAcceptedUserTurns[0]?.endedAt || 0) > RECENT_USER_TURN_WINDOW_MS) {
    recentAcceptedUserTurns.shift();
  }
}

function rememberAcceptedUserTurn(text, userId, timeline = {}) {
  const value = String(text || '').trim();
  if (!value) return;
  const endedAt = Number(timeline.utteranceEndAt || Date.now());
  const startedAt = Number(timeline.discordReceiveStartAt || timeline.firstPcmAt || endedAt);
  pruneRecentAcceptedUserTurns(endedAt);
  recentAcceptedUserTurns.push({ text: value, userId: String(userId || ''), startedAt, endedAt });
  if (recentAcceptedUserTurns.length > 8) recentAcceptedUserTurns.splice(0, recentAcceptedUserTurns.length - 8);
}

function looksLikeRecentUserDuplicate(text, userId, timeline = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const now = Date.now();
  const startedAt = Number(timeline.discordReceiveStartAt || timeline.firstPcmAt || now);
  const endedAt = Number(timeline.utteranceEndAt || now);
  pruneRecentAcceptedUserTurns(now);
  for (let i = recentAcceptedUserTurns.length - 1; i >= 0; i -= 1) {
    const prior = recentAcceptedUserTurns[i];
    if (String(prior.userId || '') !== String(userId || '')) continue;
    const adjacent = startedAt <= Number(prior.endedAt || 0) + RECENT_USER_TURN_WINDOW_MS
      && endedAt >= Number(prior.startedAt || 0) - 250;
    if (adjacent && sameUtterance(value, prior.text)) return prior;
  }
  return null;
}


function normalizeSttToken(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s。、，,.！？!?「」『』（）()・ー~〜_-]/g, '');
}
function escapeSttRegExp(value = '') {
  return String(value || '').replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
}
function glossaryContextSupports(entry, recentHistory = []) {
  if (entry?.always) return true;
  const context = recentHistory.slice(-8).map((item) => String(item?.content || '')).join(' ');
  const haystack = normalizeSttToken(context);
  return Boolean(haystack) && [entry.canonical, ...(entry.aliases || [])]
    .some((term) => haystack.includes(normalizeSttToken(term)));
}
function lowConfidenceEvidenceForAlias(alias, captureMetrics = {}) {
  const wanted = normalizeSttToken(alias);
  const words = Array.isArray(captureMetrics?.realtimeWords) ? captureMetrics.realtimeWords : [];
  const localLow = words.some((item) => {
    const confidence = Number(item?.confidence);
    if (!Number.isFinite(confidence) || confidence >= STT_LOW_CONFIDENCE_THRESHOLD) return false;
    const heard = normalizeSttToken(item?.word || '');
    return Boolean(heard && wanted && (heard.includes(wanted) || wanted.includes(heard)));
  });
  if (localLow) return 'nova-word-low-confidence';
  const rawConfidence = captureMetrics?.realtimeConfidence;
  const confidence = Number(rawConfidence);
  const realtime = String(captureMetrics?.realtimeTranscript || '').trim();
  const utteranceLow = rawConfidence !== null && rawConfidence !== undefined
    && Number.isFinite(confidence) && confidence < STT_LOW_CONFIDENCE_THRESHOLD;
  const disagreement = Boolean(realtime) && !sameUtterance(String(captureMetrics?.rawTranscript || ''), realtime);
  return utteranceLow && disagreement ? 'nova-utterance-low-confidence-disagreement' : '';
}
function correctLowConfidenceTranscript(rawTranscript, captureMetrics = {}, recentHistory = []) {
  const raw = String(rawTranscript || '').trim();
  if (!raw) return { rawTranscript: '', correctedTranscript: '', correctionReason: '' };
  const metrics = { ...captureMetrics, rawTranscript: raw };
  let corrected = raw;
  const reasons = [];
  for (const entry of STT_GLOSSARY) {
    if (!glossaryContextSupports(entry, recentHistory)) continue;
    for (const alias of [...(entry.aliases || [])].sort((a,b)=>String(b).length-String(a).length)) {
      const evidence = lowConfidenceEvidenceForAlias(alias, metrics);
      if (!evidence) continue;
      corrected = corrected.replace(new RegExp(escapeSttRegExp(alias), 'giu'), (match) => {
        if (match === entry.canonical || /[0-9０-９¥￥$€£]/u.test(match)) return match;
        reasons.push(entry.canonical + ':' + evidence);
        return entry.canonical;
      });
    }
  }
  return { rawTranscript: raw, correctedTranscript: corrected, correctionReason: [...new Set(reasons)].join(';') };
}
function maybeTriggerConfirmedBargeIn(active, transcript = '') {
  if (!active?.bargeInArmed || active.bargeInTriggered || !active.startedDuringBotPlayback) return false;
  const value = String(transcript || active.latestRealtimeTranscript || '').trim();
  if (!value) return false;
  if (looksLikeRecentBotEcho(value, { ...(active.timeline || {}), utteranceEndAt: Date.now() })) {
    active.bargeInEchoBlocked = true;
    mirrorRuntimeLog('BARGE', 'self-voice blocked: ' + value);
    return false;
  }
  if (!activeBotPlaybackRecord && player.state.status !== AudioPlayerStatus.Playing) return false;
  active.bargeInTriggered = true;
  const origin = Number(active.timeline?.firstPcmAt || active.timeline?.discordReceiveStartAt || Date.now());
  const triggerMs = Math.max(0, Date.now() - origin);
  if (active.timeline) active.timeline.bargeInTriggerMs = triggerMs;
  interruptActiveAnswer('confirmed-user-barge-in');
  mirrorRuntimeLog('BARGE', 'trigger=' + triggerMs + 'ms confirm=' + BARGE_IN_CONFIRM_MS + 'ms');
  return true;
}
function updateBargeInVoiceGate(active, pcm16) {
  if (!active?.startedDuringBotPlayback || active.bargeInTriggered || !pcm16?.length) return;
  const level = pcm16Level(pcm16);
  const durationMs = (pcm16.length / 2 / WEB_VOICE_CAPTURE_POLICY.targetRate) * 1000;
  const voiced = level.rms >= BARGE_IN_RMS_THRESHOLD && level.peak >= BARGE_IN_PEAK_THRESHOLD;
  active.bargeInVoicedMs = voiced ? Number(active.bargeInVoicedMs || 0) + durationMs : 0;
  if (!active.bargeInArmed && active.bargeInVoicedMs >= BARGE_IN_CONFIRM_MS) {
    active.bargeInArmed = true;
    active.bargeInArmedAt = Date.now();
    maybeTriggerConfirmedBargeIn(active);
  }
}

function shouldDropUncorroboratedBotOverlap(text, captureMetrics = {}, policy = {}) {
  if (!captureMetrics?.overlappedBotPlayback || policy?.action === 'interrupt') return false;
  const confirmed = String(text || '').trim();
  if (!confirmed || confirmed.length > BOT_OVERLAP_SHORT_TEXT_MAX) return false;
  if (/^(?:違う|ちがう|いや|そうじゃない|それ違う|訂正)/.test(confirmed)) return false;
  const realtime = String(captureMetrics?.realtimeTranscript || '').trim();
  return Boolean(realtime) && !sameUtterance(confirmed, realtime);
}

function runtimeLogText() {
  const body = runtimeLogLines.slice(-18).join('\n');
  return `**TalkSys Discord runtime** · ${DISCORD_BRIDGE_REVISION}\n\`\`\`text\n${body.slice(-1750)}\n\`\`\``;
}

function scheduleRuntimeLogFlush() {
  if (!runtimeLogChannel || runtimeLogFlushTimer) return;
  runtimeLogFlushTimer = setTimeout(async () => {
    runtimeLogFlushTimer = null;
    if (!runtimeLogChannel) return;
    try {
      if (runtimeLogMessage) await runtimeLogMessage.edit(runtimeLogText());
      else runtimeLogMessage = await runtimeLogChannel.send(runtimeLogText());
    } catch (error) {
      console.warn('[discord-log] mirror failed:', error?.message || error);
    }
  }, 700);
}

function mirrorRuntimeLog(kind, message) {
  const value = String(message || '').replace(/`/g, 'ˋ').replace(/\s+/g, ' ').trim().slice(0, 260);
  if (!value) return;
  const stamp = new Date().toISOString().slice(11, 19);
  runtimeLogLines.push(`${stamp} [${kind}] ${value}`);
  if (runtimeLogLines.length > 60) runtimeLogLines.splice(0, runtimeLogLines.length - 60);
  scheduleRuntimeLogFlush();
}

async function attachRuntimeLogChannel(channel) {
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;
  runtimeLogChannel = channel;
  runtimeLogMessage = null;
  mirrorRuntimeLog('LOG', 'Discord live log attached');
  mirrorRuntimeLog('BOOT', `bridge=${DISCORD_BRIDGE_REVISION}`);
  mirrorRuntimeLog('BOOT', `TalkSys=${TALKSYS_BASE_URL}`);
  mirrorRuntimeLog('BOOT', `ttsPrimary=${process.platform === 'win32' ? 'windows-system-speech' : 'cloudflare-melotts'}`);
  scheduleRuntimeLogFlush();
  return true;
}

function realtimeSttUrl() {
  const url = new URL(TALKSYS_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/realtime-stt';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function fetchFastReaction(text, signal) {
  const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/fast-reaction', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }, {
    timeoutMs: REQUEST_BUDGET_MS.fastReaction,
    label: 'fast-reaction',
  });
  return response.json().catch(() => ({}));
}

async function cachedReactionAudio(text, signal) {
  const key = String(text || '').trim();
  if (!key) return null;
  if (fastReactionAudioCache.has(key)) return fastReactionAudioCache.get(key);
  const synthesized = await synthesize(key, signal, { purpose: 'fast-reaction' });
  fastReactionAudioCache.set(key, synthesized.audio);
  return synthesized.audio;
}

async function warmFastReactionAudio() {
  const samples = ['こんにちは', 'ありがとう', '今日の天気を教えて', 'これを調べて', '何時？', 'この内容について詳しく相談したいです'];
  const texts = [...new Set(samples.map((sample) => fastReaction(sample)).filter((r) => r?.shouldSpeak && r?.text).map((r) => r.text))];
  await Promise.allSettled(texts.map((text) => cachedReactionAudio(text)));
  mirrorRuntimeLog('READY', `fast-reaction cache=${fastReactionAudioCache.size}`);
}

function playWebFastReaction(reaction, utteranceId, sessionEpoch, timeline, realtimeTranscript = '') {
  if (!reaction?.shouldSpeak || !String(reaction?.text || '').trim()) return null;
  try { activeFastReaction?.stop?.('replaced'); } catch {}
  try { activeWaitCue?.stop?.('fast-reaction-won'); } catch {}
  activeWaitCue = null;
  const cueSerial = ++preAnswerCueSerial;
  let stopped = false;
  let playing = false;
  const controller = new AbortController();
  let handle = null;
  timeline.fastReactionRequestedAt = Date.now();
  timeline.realtimeTranscript = String(realtimeTranscript || '');

  const done = (async () => {
    try {
      const text = String(reaction.text).trim();
      const audio = await cachedReactionAudio(text, controller.signal);
      if (!audio?.length || stopped || sessionEpoch !== voiceEpoch || cueSerial !== preAnswerCueSerial) return false;
      playing = true;
      mirrorRuntimeLog('REACTION', `${reaction.kind || 'unknown'}: ${text}`);
      await playMp3(audio, {
        spokenText: text,
        purpose: 'fast-reaction',
        onPlaybackStart: ({ playbackStartedAt }) => {
          timeline.fastReactionPlaybackAt = playbackStartedAt;
          const reactionMs = Math.max(0, playbackStartedAt - (timeline.utteranceEndAt || playbackStartedAt));
          console.log(`[latency] fast-reaction=${reactionMs}ms utterance=${utteranceId}`);
          mirrorRuntimeLog('LATENCY', `fast-reaction=${reactionMs}ms ${utteranceId}`);
        },
      });
      return true;
    } catch (error) {
      if (!stopped && error?.name !== 'AbortError') console.warn('[fast-reaction]', error?.message || error);
      return false;
    } finally {
      playing = false;
      if (activeFastReaction === handle) activeFastReaction = null;
    }
  })();

  handle = {
    utteranceId,
    done,
    stop(reason = 'answer-ready') {
      if (stopped) return;
      stopped = true;
      try { controller.abort(reason); } catch {}
      if (playing) player.stop(true);
    },
  };
  activeFastReaction = handle;
  return handle;
}

function triggerWebFastReaction(helper, text) {
  const active = helper?.active;
  const value = String(text || '').trim();
  if (!active || active.reactionIssued || !value || active.sessionEpoch !== voiceEpoch) return;
  active.latestRealtimeTranscript = value;
  if (active.startedDuringBotPlayback) {
    console.log(`[fast-reaction] deferred bot-overlap utterance=${active.utteranceId}`);
    return;
  }
  active.reactionIssued = true;
  const seq = ++helper.reactionSeq;
  setTimeout(async () => {
    if (helper.reactionSeq !== seq || helper.active !== active || active.sessionEpoch !== voiceEpoch) return;
    try {
      const reaction = await fetchFastReaction(value);
      if (helper.reactionSeq !== seq || helper.active !== active || active.sessionEpoch !== voiceEpoch) return;
      active.reaction = reaction;
      if (reaction?.shouldSpeak) playWebFastReaction(reaction, active.utteranceId, active.sessionEpoch, active.timeline, value);
    } catch (error) {
      console.warn('[fast-reaction] endpoint failed:', error?.message || error);
    }
  }, 90);
}

function handleRealtimeMessage(helper, data) {
  let payload;
  try { payload = JSON.parse(String(data)); } catch { return; }
  const type = String(payload?.type || payload?.event || '');
  const alternative = payload?.channel?.alternatives?.[0] || {};
  const transcript = String(alternative?.transcript || payload?.transcript || '').trim();
  const confidenceValue = Number(alternative?.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : null;
  const realtimeWords = (Array.isArray(alternative?.words) ? alternative.words : [])
    .map((item) => ({ word: String(item?.word || item?.punctuated_word || '').trim(), confidence: Number(item?.confidence) }))
    .filter((item) => item.word && Number.isFinite(item.confidence));
  if (/SpeechStarted/i.test(type)) {
    helper.finalParts = [];
    helper.interim = '';
    return;
  }
  if (transcript) {
    helper.interim = transcript;
    if (helper.active) {
      helper.active.latestRealtimeTranscript = transcript;
      if (confidence !== null) helper.active.latestRealtimeConfidence = confidence;
      if (realtimeWords.length) helper.active.realtimeWords = realtimeWords;
      maybeTriggerConfirmedBargeIn(helper.active, transcript);
    }
  }
  if (/Results/i.test(type)) {
    if (payload?.is_final && transcript && !helper.finalParts.includes(transcript)) helper.finalParts.push(transcript);
    if (payload?.speech_final) {
      const text = [...helper.finalParts, (!payload?.is_final && transcript ? transcript : '')].filter(Boolean).join(' ').trim() || transcript;
      if (text) triggerWebFastReaction(helper, text);
      helper.finalParts = [];
      helper.interim = '';
    }
    return;
  }
  if (/UtteranceEnd/i.test(type)) {
    const text = helper.finalParts.join(' ').trim() || helper.interim;
    if (text) triggerWebFastReaction(helper, text);
    helper.finalParts = [];
    helper.interim = '';
  }
}

function ensureRealtimeHelper(userId) {
  let helper = realtimeHelpers.get(userId);
  if (helper && helper.ws && (helper.ws.readyState === WebSocket.OPEN || helper.ws.readyState === WebSocket.CONNECTING)) return helper;
  helper = {
    userId,
    ws: null,
    ready: false,
    buffered: [],
    bufferedBytes: 0,
    finalParts: [],
    interim: '',
    reactionSeq: 0,
    active: null,
  };
  realtimeHelpers.set(userId, helper);
  try {
    const ws = new WebSocket(realtimeSttUrl());
    helper.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      helper.ready = true;
      mirrorRuntimeLog('RT-STT', `ready user=${userId}`);
      for (const chunk of helper.buffered) {
        try { ws.send(chunk); } catch {}
      }
      helper.buffered = [];
      helper.bufferedBytes = 0;
    };
    ws.onmessage = (event) => handleRealtimeMessage(helper, event.data);
    ws.onerror = () => {
      helper.ready = false;
      mirrorRuntimeLog('RT-STT', `error user=${userId}; Whisper continues`);
    };
    ws.onclose = () => {
      helper.ready = false;
      helper.ws = null;
      if (realtimeHelpers.get(userId) === helper) realtimeHelpers.delete(userId);
    };
  } catch (error) {
    mirrorRuntimeLog('RT-STT', `open failed: ${error?.message || error}`);
  }
  return helper;
}

function beginRealtimeUtterance(userId, meta) {
  const helper = ensureRealtimeHelper(userId);
  helper.finalParts = [];
  helper.interim = '';
  helper.reactionSeq += 1;
  helper.active = {
    ...meta,
    reactionIssued: false,
    reaction: null,
    latestRealtimeTranscript: '',
    latestRealtimeConfidence: null,
    realtimeWords: [],
    bargeInVoicedMs: 0,
    bargeInArmed: false,
    bargeInArmedAt: 0,
    bargeInTriggered: false,
    bargeInEchoBlocked: false,
  };
  return helper;
}

function sendRealtimePcm(helper, pcm16) {
  if (!helper || !pcm16?.length) return;
  const chunk = Buffer.from(pcm16);
  if (helper.ws?.readyState === WebSocket.OPEN) {
    try { helper.ws.send(chunk); } catch {}
    return;
  }
  if (helper.bufferedBytes < 96000) {
    helper.buffered.push(chunk);
    helper.bufferedBytes += chunk.length;
  }
}

function closeRealtimeHelpers() {
  for (const helper of realtimeHelpers.values()) {
    helper.reactionSeq += 1;
    helper.active = null;
    try { helper.ws?.close(1000, 'voice-disconnect'); } catch {}
  }
  realtimeHelpers.clear();
}

function isStaleVoiceResult(userId, sessionEpoch, utteranceSerial) {
  if (sessionEpoch !== voiceEpoch) return true;
  const latest = latestResolvedVoiceByUser.get(userId);
  return Boolean(latest
    && latest.sessionEpoch === sessionEpoch
    && Number(utteranceSerial) < Number(latest.serial));
}

function markVoiceResultResolved(userId, sessionEpoch, utteranceId, utteranceSerial) {
  if (sessionEpoch !== voiceEpoch) return false;
  const serial = Number(utteranceSerial) || 0;
  const latest = latestResolvedVoiceByUser.get(userId);
  if (latest?.sessionEpoch === sessionEpoch && serial < Number(latest.serial)) return false;
  latestResolvedVoiceByUser.set(userId, { sessionEpoch, utteranceId, serial });
  return true;
}

function releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller = null, reason = 'drop' }) {
  try { controller?.abort?.(reason); } catch {}

  const helper = realtimeHelpers.get(userId);
  if (helper?.active?.utteranceId === utteranceId) {
    helper.reactionSeq += 1;
    helper.active = null;
    helper.finalParts = [];
    helper.interim = '';
  }

  let cueReleased = false;
  if (activeFastReaction?.utteranceId === utteranceId) {
    try { activeFastReaction.stop?.(reason); } catch {}
    activeFastReaction = null;
    cueReleased = true;
  }
  if (activeWaitCue?.utteranceId === utteranceId) {
    try { activeWaitCue.stop?.(reason); } catch {}
    activeWaitCue = null;
    cueReleased = true;
  }
  if (cueReleased) preAnswerCueSerial += 1;

  if (sessionEpoch === voiceEpoch && connection && !sessions.has(userId)) {
    queueMicrotask(() => {
      if (sessionEpoch === voiceEpoch && connection && !sessions.has(userId)) {
        startReceiverSession(userId, false);
      }
    });
  }
}

function boundedSignal(parentSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

async function fetchWithBudget(url, init = {}, { timeoutMs = 15000, label = 'request' } = {}) {
  const response = await fetch(url, {
    ...init,
    signal: boundedSignal(init.signal, timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`${label}_http_${response.status}: ${detail.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return response;
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
  out.writeUInt32LE(WEB_VOICE_CAPTURE_POLICY.targetRate, 24);
  out.writeUInt32LE(WEB_VOICE_CAPTURE_POLICY.targetRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLength, 40);
  input.copy(out, 44, 0, dataLength);
  return out;
}

function createWebCompatibleResampler() {
  if (!ffmpegPath) throw new Error('ffmpeg_static_missing');
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-i', 'pipe:0',
    '-af', `highpass=f=${WEB_VOICE_CAPTURE_POLICY.highpassHz},aresample=${WEB_VOICE_CAPTURE_POLICY.targetRate}`,
    '-f', 's16le',
    '-ar', String(WEB_VOICE_CAPTURE_POLICY.targetRate),
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

async function transcribeCapturedUtterance(pcm, utteranceId, timeline, signal) {
  if (!pcm?.length) throw new Error('captured_pcm_empty');
  const wav = pcm16MonoToWav16k(pcm);
  timeline.wavReadyAt = Date.now();
  timeline.transcribeStartAt = Date.now();
  console.log(`[stt] confirmed Whisper start utterance=${utteranceId} pcm=${pcm.length}B wav=${wav.length}B`);
  mirrorRuntimeLog('STT', `Whisper start ${utteranceId} pcm=${pcm.length}B`);

  const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/transcribe', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'audio/wav',
      'x-talksys-session': discordSessionId || 'discord-unknown',
      'x-talksys-utterance': utteranceId,
      'x-talksys-channel': 'discord',
    },
    body: wav,
  }, {
    timeoutMs: REQUEST_BUDGET_MS.stt,
    label: 'stt',
  });

  const body = await response.json().catch(() => ({}));
  timeline.whisperCompleteAt = Date.now();
  if (!body?.ok || !body?.text) {
    throw new Error(body?.error || body?.rejected || 'stt_empty_transcript');
  }
  const confirmedTranscript = String(body.text).trim();
  console.log(`[stt] confirmed model=${body.model || 'unknown'} elapsed=${timeline.whisperCompleteAt - timeline.transcribeStartAt}ms: ${confirmedTranscript}`);
  mirrorRuntimeLog('STT', `Whisper ${timeline.whisperCompleteAt - timeline.transcribeStartAt}ms: ${confirmedTranscript}`);
  return {
    confirmedTranscript,
    fastReaction: body?.fastReaction || null,
    model: body?.model || '',
    serverElapsedMs: Number(body?.elapsedMs) || 0,
    signal: body?.signal || null,
  };
}

async function postVoiceMetrics({ text, utteranceId, timings, timeline, realtimeTranscript = '', confirmedTranscript = '', rawTranscript = '', correctedTranscript = '', correctionReason = '', bargeInTriggerMs = 0, geminiInputText = '', error = '' }) {
  try {
    const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/voice-metrics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        text,
        sessionId: discordSessionId || `discord-${randomUUID()}`,
        utteranceId,
        channel: 'discord',
        timings,
        timeline,
        realtimeTranscript,
        confirmedTranscript,
        rawTranscript: rawTranscript || confirmedTranscript,
        correctedTranscript: correctedTranscript || confirmedTranscript,
        correctionReason,
        bargeInTriggerMs: Number(bargeInTriggerMs) || Number(timeline?.bargeInTriggerMs) || 0,
        geminiInputText,
        transcriptMatch: realtimeTranscript ? realtimeTranscript === confirmedTranscript : null,
        error,
      }),
    }, {
      timeoutMs: REQUEST_BUDGET_MS.metrics,
      label: 'metrics',
    });
    await response.arrayBuffer().catch(() => {});
    console.log('[metrics] voice latency persisted');
    return true;
  } catch (errorValue) {
    console.warn('[metrics] voice metrics failed:', errorValue?.message || errorValue);
    return false;
  }
}

async function fetchSearchPreface(text, signal) {
  try {
    const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/search-preface', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }, {
      timeoutMs: REQUEST_BUDGET_MS.waitCue,
      label: 'wait-cue',
    });
    const body = await response.json().catch(() => ({}));
    if (body?.shouldSpeak && String(body?.text || '').trim()) return String(body.text).trim();
  } catch (error) {
    if (!signal?.aborted) console.warn('[wait-cue] preface unavailable:', error?.message || error);
  }
  return '';
}

function startWaitCue(text, utteranceId, parentSignal, fastReaction = null) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const cueSerial = ++preAnswerCueSerial;
  let playing = false;
  let stopped = false;

  const done = (async () => {
    try {
      let cue = '';
      if (fastReaction?.shouldSpeak && String(fastReaction?.text || '').trim()) {
        cue = String(fastReaction.text).trim();
      } else {
        cue = await fetchSearchPreface(text, signal);
      }
      if (!cue || signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;
      const synthesized = await synthesize(cue, signal, { utteranceId, purpose: 'wait-cue' });
      if (signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;
      playing = true;
      await playMp3(synthesized.audio, { spokenText: cue, purpose: 'wait-cue' });
      return true;
    } catch (error) {
      if (!signal.aborted && !stopped) console.warn('[wait-cue] failed:', error?.message || error);
      return false;
    } finally {
      playing = false;
    }
  })();

  return {
    utteranceId,
    done,
    stop(reason = 'answer-ready') {
      if (stopped) return;
      stopped = true;
      try { controller.abort(reason); } catch {}
      if (playing) player.stop(true);
    },
  };
}

async function talk(text, utteranceId = '', signal) {
  const started = Date.now();
  console.log('[turn] user:', text);
  mirrorRuntimeLog('TURN', `user: ${text}`);
  const previous = history.slice(-MAX_HISTORY);
  const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/turn', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      history: previous,
      searchTrace,
      sessionId: discordSessionId || `discord-${randomUUID()}`,
      utteranceId,
      previousInteractionId,
      channel: 'discord',
    }),
  }, {
    timeoutMs: REQUEST_BUDGET_MS.turn,
    label: 'turn',
  });
  const body = await response.json().catch(() => ({}));
  if (!body?.ok || !body?.answer) {
    throw new Error(body?.detail || body?.error || 'turn_empty_answer');
  }
  if (body.interactionId) previousInteractionId = body.interactionId;
  if (body.search) {
    searchTrace = {
      resolvedQuestion: body.resolvedQuestion || text,
      queries: Array.isArray(body.queries) ? body.queries.slice(0, 6) : [],
      sources: Array.isArray(body.sources) ? body.sources.slice(0, 8) : [],
    };
  }
  history.push({ role: 'user', content: text }, { role: 'assistant', content: body.answer });
  if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY * 2);
  const elapsed = Date.now() - started;
  console.log('[turn] assistant:', body.answer);
  console.log(`[latency] turn-http=${elapsed}ms server-total=${body?.timings?.totalMs ?? '?'}ms primary=${body?.timings?.primaryMs ?? '?'}ms verifier=${body?.timings?.verifierMs ?? '?'}ms`);
  mirrorRuntimeLog('TURN', `total=${elapsed}ms primary=${body?.timings?.primaryMs ?? '?'} verifier=${body?.timings?.verifierMs ?? '?'}`);
  return body;
}

async function synthesizeWindowsJapaneseTtsUnlocked(text, signal) {
  if (process.platform !== 'win32') throw new Error('windows_tts_unavailable_non_windows');
  const spoken = String(text || '').trim();
  if (!spoken) throw new Error('windows_tts_empty_text');

  const tempFile = (process.env.TEMP || process.env.TMP || '.')
    + '\\talksys-tts-' + randomUUID() + '.wav';

  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TALKSYS_TTS_TEXT_B64))",
    "$out=$env:TALKSYS_TTS_OUT",
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$ja=@($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' })",
    "$pick=$null",
    "$best=-1",
    "foreach($v in $ja){$n=[string]$v.VoiceInfo.Name;$score=0;if($n -match 'Google.*(日本語|Japanese)'){$score=1000}elseif($n -match 'Nanami'){$score=820}elseif($n -match 'Haruka|Sayaka|Ichiro|Keita'){$score=760}elseif($n -match 'Microsoft'){$score=650}elseif($n -match 'Ayumi'){$score=420};if($score -gt $best){$best=$score;$pick=$v}}",
    "if($pick -ne $null){$s.SelectVoice([string]$pick.VoiceInfo.Name);[Console]::Error.WriteLine(('voice=' + [string]$pick.VoiceInfo.Name))}",
    "$s.SetOutputToWaveFile($out)",
    "$s.Speak($text)",
    "$s.Dispose()",
    "if(-not (Test-Path $out)){throw 'windows_tts_missing_output'}",
    "$len=(Get-Item $out).Length",
    "if($len -lt 44){throw ('windows_tts_empty_audio len=' + $len)}"
  ].join('; ');

  const started = Date.now();
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], {
    env: {
      ...process.env,
      TALKSYS_TTS_TEXT_B64: Buffer.from(spoken, 'utf8').toString('base64'),
      TALKSYS_TTS_OUT: tempFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch {}
  }, 15000);

  let abortHandler = null;
  if (signal) {
    abortHandler = () => {
      try { child.kill(); } catch {}
    };
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (signal?.aborted) throw signal.reason || new Error('aborted');

    let audio = Buffer.alloc(0);
    try {
      audio = await fs.promises.readFile(tempFile);
    } catch {}

    if (code !== 0 || audio.length < 44) {
      throw new Error(`windows_tts_failed code=${code} timedOut=${timedOut} bytes=${audio.length} detail=${stderr.trim().slice(0, 240)}`);
    }

    return {
      audio,
      source: 'windows-system-speech',
      elapsedMs: Date.now() - started,
      workerMs: 0,
    };
  } finally {
    clearTimeout(timeout);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    fs.promises.unlink(tempFile).catch(() => {});
  }
}

async function synthesizeWindowsJapaneseTts(text, signal) {
  const task = windowsTtsQueue
    .catch(() => {})
    .then(() => synthesizeWindowsJapaneseTtsUnlocked(text, signal));
  windowsTtsQueue = task.catch(() => {});
  return task;
}

async function synthesizeCloudflareTts(text, signal, meta = {}) {
  const started = Date.now();
  const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/voice/synthesize', {
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
    label: 'tts',
  });
  const audio = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || 'unknown';
  const source = response.headers.get('x-talksys-voice-source') || 'unknown';
  const workerMs = Number(response.headers.get('x-talksys-tts-ms') || 0);
  const elapsedMs = Date.now() - started;
  console.log(`[tts] ${audio.length} bytes type=${type} source=${source}`);
  console.log(`[latency] tts-http=${elapsedMs}ms worker=${workerMs || '?'}ms source=${source}`);
  mirrorRuntimeLog('TTS', `${elapsedMs}ms source=${source}`);
  return { audio, source, elapsedMs, workerMs };
}

async function synthesize(text, signal, meta = {}) {
  if (process.platform === 'win32') {
    try {
      const local = await synthesizeWindowsJapaneseTts(text, signal);
      console.log(`[tts] ${local.audio.length} bytes source=${local.source}`);
      console.log(`[latency] tts-local=${local.elapsedMs}ms source=${local.source}`);
      mirrorRuntimeLog('TTS', `${local.elapsedMs}ms source=${local.source}`);
      return local;
    } catch (localError) {
      const detail = String(localError?.message || localError || '');
      console.warn('[tts] Windows System.Speech failed; trying Cloudflare MeloTTS:', detail);
      mirrorRuntimeLog('TTS-ERROR', `Windows local failed: ${detail.slice(0, 180)}`);
      mirrorRuntimeLog('TTS', 'Windows local failed -> Cloudflare recovery');
    }
  }
  return synthesizeCloudflareTts(text, signal, meta);
}

async function warmRecoveryAudio() {
  if (recoveryAudio?.length) return recoveryAudio;
  if (recoveryAudioPromise) return recoveryAudioPromise;
  recoveryAudioPromise = synthesize(RECOVERY_PROMPT)
    .then((result) => {
      recoveryAudio = result.audio;
      console.log(`[recovery] cached ${recoveryAudio.length} bytes`);
      return recoveryAudio;
    })
    .finally(() => { recoveryAudioPromise = null; });
  return recoveryAudioPromise;
}

async function speakRecoveryPrompt(reason = 'pipeline-failure', sessionEpoch = voiceEpoch, failedUtteranceEndAt = 0) {
  if (recoverySpeaking || sessionEpoch !== voiceEpoch) return false;
  if (failedUtteranceEndAt > 0 && (lastUserSpeechAt > failedUtteranceEndAt || lastUserPcmAt > failedUtteranceEndAt)) {
    console.warn(`[recovery] suppressed because a new user utterance started reason=${reason}`);
    return false;
  }
  recoverySpeaking = true;
  try {
    let audio = recoveryAudio;
    if (!audio?.length) audio = await warmRecoveryAudio();
    if (!audio?.length || sessionEpoch !== voiceEpoch) return false;
    player.stop(true);
    await playMp3(audio, { spokenText: RECOVERY_PROMPT, purpose: 'recovery' });
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
  let botSpeechRecord = null;
  ffmpeg.stderr.on('data', (d) => { ffmpegError += String(d); });
  ffmpeg.stdout.once('data', () => {
    ffmpegSpawnMs = Date.now() - ffmpegStarted;
    console.log(`[latency] ffmpeg-first-output=${ffmpegSpawnMs}ms`);
  });
  ffmpeg.on('error', (error) => console.error('[ffmpeg]', error.message));
  ffmpeg.stdin.end(mp3);

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  const playbackStartedPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      player.off(AudioPlayerStatus.Playing, onPlaying);
      try { ffmpeg.kill('SIGKILL'); } catch {}
      reject(new Error('playback_start_timeout'));
    }, 5000);
    const onPlaying = () => {
      clearTimeout(timeout);
      const playbackStartedAt = Date.now();
      if (options?.spokenText) {
        botSpeechRecord = rememberBotSpeech(options.spokenText, options?.purpose || '', playbackStartedAt);
        activeBotPlaybackRecord = botSpeechRecord;
      }
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
    const done = () => { clearTimeout(timeout); finishBotSpeech(botSpeechRecord); if (botSpeechRecord) lastBotPlaybackEndedAt = Date.now(); if (activeBotPlaybackRecord === botSpeechRecord) activeBotPlaybackRecord = null; cleanup(); resolve(); };
    const fail = (error) => { clearTimeout(timeout); finishBotSpeech(botSpeechRecord); if (botSpeechRecord) lastBotPlaybackEndedAt = Date.now(); if (activeBotPlaybackRecord === botSpeechRecord) activeBotPlaybackRecord = null; cleanup(); reject(error); };
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

async function processConfirmedTranscript({ confirmedTranscript, rawTranscript = '', correctedTranscript = '', correctionReason = '', fastReaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta }) {
  if (!confirmedTranscript || sessionEpoch !== voiceEpoch) return;

  const recentDuplicate = looksLikeRecentUserDuplicate(confirmedTranscript, userId, timeline);
  if (recentDuplicate) {
    console.warn(`[dedupe] suppressed adjacent completed duplicate utterance=${utteranceId}: ${confirmedTranscript}`);
    mirrorRuntimeLog('DEDUPE', `adjacent completed duplicate: ${confirmedTranscript}`);
    return;
  }

  if (answering && activeUserText && sameUtterance(confirmedTranscript, activeUserText)) {
    console.warn(`[dedupe] suppressed duplicate in-flight utterance=${utteranceId} active=${activeUserUtteranceId}: ${confirmedTranscript}`);
    mirrorRuntimeLog('DEDUPE', `in-flight duplicate: ${confirmedTranscript}`);
    return;
  }
  if (pendingTurns.some((item) => sameUtterance(item?.confirmedTranscript || '', confirmedTranscript))) {
    console.warn(`[dedupe] suppressed duplicate queued utterance=${utteranceId}: ${confirmedTranscript}`);
    mirrorRuntimeLog('DEDUPE', `queued duplicate: ${confirmedTranscript}`);
    return;
  }

  const policy = classifyVoiceTurn(confirmedTranscript, { answerInFlight: answering || player.state.status === AudioPlayerStatus.Playing });
  if (policy.action === 'drop') {
    console.log(`[turn-policy] dropped reason=${policy.reason}: ${confirmedTranscript}`);
    mirrorRuntimeLog('DROP', `${policy.reason}: ${confirmedTranscript}`);
    releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, reason: `turn-policy-${policy.reason}` });
    return;
  }
  if (policy.action === 'interrupt') {
    interruptActiveAnswer('explicit-user-stop');
    pendingTurns.splice(0, pendingTurns.length);
    mirrorRuntimeLog('INTERRUPT', `explicit stop: ${confirmedTranscript}`);
    return;
  }
  if (shouldDropUncorroboratedBotOverlap(confirmedTranscript, captureMetrics, policy)) {
    console.warn(`[turn-policy] dropped reason=bot-overlap-unconfirmed whisper="${confirmedTranscript}" realtime="${String(captureMetrics?.realtimeTranscript || '')}"`);
    mirrorRuntimeLog('DROP', `bot-overlap-unconfirmed: ${confirmedTranscript}`);
    releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, reason: 'bot-overlap-unconfirmed' });
    return;
  }
  if (answering) {
    const nextTurn = { confirmedTranscript, rawTranscript, correctedTranscript, correctionReason, fastReaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta };
    if (pendingTurns.length === 0) pendingTurns.push(nextTurn);
    else pendingTurns[0] = nextTurn;
    console.log(`[queue] buffered latest user=${userId}: ${confirmedTranscript}`);
    mirrorRuntimeLog('QUEUE', `latest only: ${confirmedTranscript}`);
    return;
  }

  answering = true;
  activeUserText = confirmedTranscript;
  activeUserUtteranceId = utteranceId;
  rememberAcceptedUserTurn(confirmedTranscript, userId, timeline);
  const pipelineStarted = Date.now();
  const turnSerial = ++activeTurnSerial;
  const controller = new AbortController();
  try { activeTurnAbortController?.abort(); } catch {}
  activeTurnAbortController = controller;

  const timings = {
    sttMode: 'web-whisper',
    captureMs: Math.max(0, (timeline.utteranceEndAt || 0) - (timeline.discordReceiveStartAt || timeline.firstPcmAt || 0)),
    sttMs: Math.max(0, (timeline.whisperCompleteAt || 0) - (timeline.transcribeStartAt || 0)),
    speechEndToSttFinalMs: Math.max(0, (timeline.whisperCompleteAt || 0) - (timeline.utteranceEndAt || 0)),
    fastReactionMs: Math.max(0, (timeline.fastReactionPlaybackAt || 0) - (timeline.utteranceEndAt || 0)),
    answerStartMs: 0,
    primaryMs: 0,
    verifierMs: 0,
    answerGenerationTotalMs: 0,
    firstTtsMs: 0,
    firstAudioReadyMs: 0,
    speechEndToPlaybackStartMs: 0,
    pipelineCompleteMs: 0,
    ffmpegSpawnMs: 0,
    playbackMs: 0,
    ttsProvider: '',
  };

  let pipelineError = '';
  try {
    timeline.turnStartAt = Date.now();
    timings.answerStartMs = Math.max(0, timeline.turnStartAt - (timeline.utteranceEndAt || timeline.turnStartAt));

    if (!timeline.fastReactionRequestedAt) {
      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, fastReaction);
    }
    const turn = await talk(confirmedTranscript, utteranceId, controller.signal);
    timeline.finalAnswerAt = Date.now();
    timings.primaryMs = Number(turn?.timings?.primaryMs) || 0;
    timings.verifierMs = Number(turn?.timings?.verifierMs) || 0;
    timings.answerGenerationTotalMs = Number(turn?.timings?.totalMs) || Math.max(0, timeline.finalAnswerAt - timeline.turnStartAt);

    // v84: ordinary user speech no longer invalidates an answer that is already being generated.
    // Only classifyVoiceTurn(...)=interrupt can abort it.

    // Waiting audio is never part of the answer dependency chain.
    preAnswerCueSerial += 1;
    activeWaitCue?.stop('final-answer-ready');
    activeWaitCue = null;
    activeFastReaction?.stop?.('final-answer-ready');
    activeFastReaction = null;
    player.stop(true);

    timeline.ttsStartAt = Date.now();
    const tts = await synthesize(turn.answer, controller.signal, { utteranceId, purpose: 'answer' });
    timeline.ttsEndAt = Date.now();
    timings.firstTtsMs = tts.elapsedMs;
    timings.firstAudioReadyMs = Math.max(0, timeline.ttsEndAt - pipelineStarted);
    timings.ttsProvider = tts.source;

    const playbackWallStarted = Date.now();
    await playMp3(tts.audio, {
      spokenText: turn.answer,
      purpose: 'answer',
      onPlaybackStart: ({ playbackStartedAt, ffmpegSpawnMs }) => {
        timeline.playbackStartAt = playbackStartedAt;
        timings.ffmpegSpawnMs = ffmpegSpawnMs;
        timings.speechEndToPlaybackStartMs = Math.max(0, playbackStartedAt - (timeline.utteranceEndAt || playbackStartedAt));
      },
    });
    timings.playbackMs = Date.now() - playbackWallStarted;
  } catch (error) {
    pipelineError = String(error?.message || error || '').slice(0, 500);
    if (controller.signal.aborted || turnSerial !== activeTurnSerial) {
      console.log(`[pipeline] interrupted utterance=${utteranceId}`);
    } else {
      console.error('[pipeline]', error?.stack || error);
      mirrorRuntimeLog('ERROR', `pipeline: ${pipelineError}`);
      await speakRecoveryPrompt('answer-pipeline-failed', sessionEpoch, timeline.utteranceEndAt || 0);
    }
  } finally {
    activeWaitCue?.stop?.('pipeline-complete');
    activeWaitCue = null;
    activeFastReaction?.stop?.('pipeline-complete');
    activeFastReaction = null;
    timeline.pipelineCompleteAt = Date.now();
    timings.pipelineCompleteMs = Math.max(0, timeline.pipelineCompleteAt - pipelineStarted);
    console.log(`[latency-summary] utterance=${utteranceId} captureMs=${timings.captureMs} sttMs=${timings.sttMs} speechEndToSttFinalMs=${timings.speechEndToSttFinalMs} fastReactionMs=${timings.fastReactionMs} primaryMs=${timings.primaryMs} verifierMs=${timings.verifierMs} answerGenerationTotalMs=${timings.answerGenerationTotalMs} firstTtsMs=${timings.firstTtsMs} ffmpegSpawnMs=${timings.ffmpegSpawnMs} speechEndToPlaybackStartMs=${timings.speechEndToPlaybackStartMs} pipelineCompleteMs=${timings.pipelineCompleteMs}`);
    mirrorRuntimeLog('LATENCY', `stt=${timings.sttMs}ms gemini=${timings.answerGenerationTotalMs}ms verify=${timings.verifierMs}ms tts=${timings.firstTtsMs}ms playStart=${timings.speechEndToPlaybackStartMs}ms total=${timings.pipelineCompleteMs}ms`);
    postVoiceMetrics({
      text: confirmedTranscript,
      utteranceId,
      timings,
      timeline,
      realtimeTranscript: String(captureMetrics?.realtimeTranscript || ''),
      confirmedTranscript,
      rawTranscript: rawTranscript || confirmedTranscript,
      correctedTranscript: correctedTranscript || confirmedTranscript,
      correctionReason,
      bargeInTriggerMs: Number(timeline?.bargeInTriggerMs) || 0,
      geminiInputText: confirmedTranscript,
      error: pipelineError,
    }).catch(() => {});
    if (activeTurnAbortController === controller) activeTurnAbortController = null;
    if (turnSerial === activeTurnSerial && sessionEpoch === voiceEpoch) {
      answering = false;
      activeUserText = '';
      activeUserUtteranceId = '';
      const next = pendingTurns.shift();
      if (next && next.sessionEpoch === voiceEpoch) {
        setTimeout(() => processConfirmedTranscript(next), 0);
      }
    }
  }
}

async function handleCapturedUtterance({ pcm, userId, sessionEpoch, utteranceId, utteranceSerial, timeline, captureMetrics }) {
  if (sessionEpoch !== voiceEpoch) return;
  if (!pcm?.length) {
    console.log(`[capture] rejected empty utterance=${utteranceId}`);
    return;
  }

  const controller = new AbortController();
  try {
    const stt = await transcribeCapturedUtterance(pcm, utteranceId, timeline, controller.signal);
    if (isStaleVoiceResult(userId, sessionEpoch, utteranceSerial)) {
      mirrorRuntimeLog('STT-STALE', `ignored resolved-order ${utteranceId} serial=${utteranceSerial}`);
      releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'stale-stt-result' });
      return;
    }
    markVoiceResultResolved(userId, sessionEpoch, utteranceId, utteranceSerial);
    let rawTranscript = stt.confirmedTranscript;
    const correction = correctLowConfidenceTranscript(rawTranscript, captureMetrics, history);
    let correctedTranscript = correction.correctedTranscript || rawTranscript;
    let correctionReason = correction.correctionReason || '';
    if (correctionReason) mirrorRuntimeLog('STT-CORRECT', correctionReason + ': "' + rawTranscript + '" -> "' + correctedTranscript + '"');
    const echoRecord = looksLikeRecentBotEcho(rawTranscript, timeline);
    if (echoRecord) {
      console.warn(`[echo-guard] suppressed bot echo utterance=${utteranceId} purpose=${echoRecord.purpose}: ${stt.confirmedTranscript}`);
      mirrorRuntimeLog('ECHO', `suppressed ${echoRecord.purpose}: ${stt.confirmedTranscript}`);
      activeFastReaction?.stop?.('echo-suppressed');
      activeFastReaction = null;
      timeline.pipelineCompleteAt = Date.now();
      postVoiceMetrics({
        text: stt.confirmedTranscript,
        utteranceId,
        timings: {
          sttMode: 'web-whisper',
          captureMs: Math.max(0, (timeline.utteranceEndAt || 0) - (timeline.discordReceiveStartAt || timeline.firstPcmAt || 0)),
          sttMs: Math.max(0, (timeline.whisperCompleteAt || 0) - (timeline.transcribeStartAt || 0)),
          speechEndToSttFinalMs: Math.max(0, (timeline.whisperCompleteAt || 0) - (timeline.utteranceEndAt || 0)),
          fastReactionMs: Math.max(0, (timeline.fastReactionPlaybackAt || 0) - (timeline.utteranceEndAt || 0)),
          pipelineCompleteMs: Math.max(0, timeline.pipelineCompleteAt - (timeline.discordReceiveStartAt || timeline.pipelineCompleteAt)),
          echoSuppressed: true,
        },
        timeline,
        realtimeTranscript: String(captureMetrics?.realtimeTranscript || ''),
        confirmedTranscript: correctedTranscript,
        rawTranscript,
        correctedTranscript,
        correctionReason,
        bargeInTriggerMs: Number(timeline?.bargeInTriggerMs) || 0,
        geminiInputText: '',
        error: '',
      }).catch(() => {});
      return;
    }
    await processConfirmedTranscript({
      confirmedTranscript: correctedTranscript,
      rawTranscript,
      correctedTranscript,
      correctionReason,
      fastReaction: stt.fastReaction,
      userId,
      sessionEpoch,
      utteranceId,
      utteranceSerial,
      timeline,
      captureMetrics,
      sttMeta: stt,
    });
  } catch (error) {
    const message = String(error?.message || error || '').slice(0, 500);
    if (isStaleVoiceResult(userId, sessionEpoch, utteranceSerial)) {
      mirrorRuntimeLog('STT-STALE', `ignored older error ${utteranceId} serial=${utteranceSerial}`);
      releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'stale-stt-error' });
      return;
    }
    console.error('[stt]', message);
    mirrorRuntimeLog('ERROR', `STT: ${message}`);
    if (activeFastReaction?.utteranceId === utteranceId) {
      activeFastReaction.stop?.('stt-failed');
      activeFastReaction = null;
    }
    if (/hallucination-guard|hallucinated transcript rejected/i.test(message)) {
      mirrorRuntimeLog('DROP', `known hallucination: ${utteranceId}`);
      releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'hallucination-guard' });
      return;
    }
    if (isIgnorableSttFailure(message)) {
      const realtimeRescue = String(captureMetrics?.realtimeTranscript || '').trim();
      const rescuePolicy = classifyVoiceTurn(realtimeRescue, {
        answerInFlight: answering || player.state.status === AudioPlayerStatus.Playing,
      });
      if (realtimeRescue && rescuePolicy.action === 'answer') {
        if (!markVoiceResultResolved(userId, sessionEpoch, utteranceId, utteranceSerial)) {
          mirrorRuntimeLog('STT-STALE', `realtime rescue superseded ${utteranceId} serial=${utteranceSerial}`);
          releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'stale-realtime-rescue' });
          return;
        }
        mirrorRuntimeLog('STT-RESCUE', `Whisper failed -> realtime: ${realtimeRescue}`);
        await processConfirmedTranscript({
          confirmedTranscript: realtimeRescue,
          rawTranscript: realtimeRescue,
          correctedTranscript: realtimeRescue,
          correctionReason: 'realtime-rescue-after-whisper-failure',
          fastReaction: fastReaction(realtimeRescue),
          userId,
          sessionEpoch,
          utteranceId,
          timeline,
          captureMetrics,
          sttMeta: { model: 'realtime-rescue', whisperError: message },
        });
        return;
      }
      mirrorRuntimeLog('DROP', `ignorable STT failure without usable realtime text: ${message}`);
      releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'empty-or-silent-stt' });
      timeline.pipelineCompleteAt = Date.now();
      postVoiceMetrics({
        text: '',
        utteranceId,
        timings: {
          sttMode: 'web-whisper',
          captureMs: Math.max(0, (timeline.utteranceEndAt || 0) - (timeline.discordReceiveStartAt || timeline.firstPcmAt || 0)),
          sttMs: Math.max(0, Date.now() - (timeline.transcribeStartAt || Date.now())),
          speechEndToSttFinalMs: Math.max(0, Date.now() - (timeline.utteranceEndAt || Date.now())),
          pipelineCompleteMs: Math.max(0, timeline.pipelineCompleteAt - (timeline.discordReceiveStartAt || timeline.pipelineCompleteAt)),
          error: message,
        },
        timeline,
        realtimeTranscript: String(captureMetrics?.realtimeTranscript || ''),
        confirmedTranscript: '',
        geminiInputText: '',
        error: message,
      }).catch(() => {});
      return;
    }
    timeline.pipelineCompleteAt = Date.now();
    postVoiceMetrics({
      text: '',
      utteranceId,
      timings: {
        sttMode: 'web-whisper',
        captureMs: Math.max(0, (timeline.utteranceEndAt || 0) - (timeline.discordReceiveStartAt || timeline.firstPcmAt || 0)),
        sttMs: Math.max(0, Date.now() - (timeline.transcribeStartAt || Date.now())),
        speechEndToSttFinalMs: Math.max(0, Date.now() - (timeline.utteranceEndAt || Date.now())),
        pipelineCompleteMs: Math.max(0, timeline.pipelineCompleteAt - (timeline.discordReceiveStartAt || timeline.pipelineCompleteAt)),
        error: message,
      },
      timeline,
      realtimeTranscript: String(captureMetrics?.realtimeTranscript || ''),
      confirmedTranscript: '',
      geminiInputText: '',
      error: message,
    }).catch(() => {});
    await speakRecoveryPrompt('stt-failed', sessionEpoch, timeline.utteranceEndAt || 0);
  }
}

function interruptActiveAnswer(reason = 'user-speech') {
  if (!answering && !activeFastReaction && player.state.status !== AudioPlayerStatus.Playing) return false;
  activeTurnSerial += 1;
  const controller = activeTurnAbortController;
  activeTurnAbortController = null;
  try { controller?.abort(); } catch {}
  try { activeWaitCue?.stop?.(reason); } catch {}
  try { activeFastReaction?.stop?.(reason); } catch {}
  activeWaitCue = null;
  activeFastReaction = null;
  player.stop(true);
  answering = false;
  activeUserText = '';
  activeUserUtteranceId = '';
  pendingTurns.splice(0, pendingTurns.length);
  console.log(`[barge-in] interrupted active answer reason=${reason}`);
  return true;
}

function startReceiverSession(userId, speakingNow = false, options = {}) {
  if (!connection) return;
  const existing = sessions.get(userId);
  if (existing) {
    if (speakingNow) existing.markSpeaking(Boolean(options?.startedDuringBotPlayback));
    return;
  }

  const sessionEpoch = voiceEpoch;
  const utteranceId = `utt-${randomUUID()}`;
  const timeline = {
    utteranceId,
    discordReceiveStartAt: 0,
    firstPcmAt: 0,
    utteranceEndAt: 0,
    fastReactionRequestedAt: 0,
    fastReactionPlaybackAt: 0,
    realtimeTranscript: '',
    wavReadyAt: 0,
    transcribeStartAt: 0,
    whisperCompleteAt: 0,
    turnStartAt: 0,
    finalAnswerAt: 0,
    ttsStartAt: 0,
    ttsEndAt: 0,
    playbackStartAt: 0,
    pipelineCompleteAt: 0,
    bargeInTriggerMs: 0,
  };

  // Discord already gates outgoing voice by speaking state. Do not apply the
  // browser RMS/SNR rejection gate again or normal Discord speech can be lost.
  // We only normalize the transport audio to the same Web STT input format.
  const opus = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1600 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const resampler = createWebCompatibleResampler();
  const pcm16Chunks = [];

  let completed = false;
  let speakingMarked = false;
  let packetStartWatchdog = null;
  let finalizeTimer = null;
  let pcm16Bytes = 0;
  let lastPcmAt = 0;
  let utteranceSerial = 0;
  let realtimeHelper = null;

  const ensureUtteranceSerial = () => {
    if (!utteranceSerial) {
      utteranceSerial = ++voiceUtteranceSerial;
    }
    return utteranceSerial;
  };
  let overlappedBotPlayback = Boolean(options?.startedDuringBotPlayback);

  const clearTimers = () => {
    if (packetStartWatchdog) clearTimeout(packetStartWatchdog);
    if (finalizeTimer) clearInterval(finalizeTimer);
    packetStartWatchdog = null;
    finalizeTimer = null;
  };

  const markSpeaking = (startedDuringBotPlayback = false) => {
    if (completed) return;
    speakingMarked = true;
    ensureUtteranceSerial();
    if (startedDuringBotPlayback) overlappedBotPlayback = true;
    if (!realtimeHelper || realtimeHelper.active?.utteranceId !== utteranceId) {
      realtimeHelper = beginRealtimeUtterance(userId, {
        utteranceId,
        utteranceSerial,
        sessionEpoch,
        timeline,
        startedDuringBotPlayback: overlappedBotPlayback,
      });
    }
    lastUserSpeechAt = Date.now();
    if (!timeline.discordReceiveStartAt) timeline.discordReceiveStartAt = lastUserSpeechAt;
    if (packetStartWatchdog) clearTimeout(packetStartWatchdog);
    packetStartWatchdog = setTimeout(() => {
      if (completed || pcm16Bytes > 0) return;
      console.error(`[capture] speaking produced no PCM user=${userId}`);
      finalize('no-pcm').catch(() => {});
    }, RECEIVER_PACKET_START_TIMEOUT_MS);
  };

  const cleanup = () => {
    clearTimers();
    sessions.delete(userId);
    try { opus.destroy(); } catch {}
    try { decoder.destroy(); } catch {}
    try { resampler.stdin.end(); } catch {}
    setTimeout(() => {
      try { if (!resampler.killed) resampler.kill('SIGKILL'); } catch {}
    }, 250);
  };

  const finalize = async (reason = 'discord-silence') => {
    if (completed) return;
    completed = true;
    const endedAt = Date.now();
    const pcm = pcm16Chunks.length ? Buffer.concat(pcm16Chunks) : Buffer.alloc(0);
    if (pcm.length && !utteranceSerial) ensureUtteranceSerial();
    const durationMs = pcm.length / 2 / WEB_VOICE_CAPTURE_POLICY.targetRate * 1000;
    timeline.utteranceEndAt = endedAt;
    cleanup();

    queueMicrotask(() => {
      if (sessionEpoch === voiceEpoch && connection) startReceiverSession(userId, false);
    });

    const realtimeActive = realtimeHelper?.active?.utteranceId === utteranceId ? realtimeHelper.active : null;
    const realtimeTranscript = realtimeActive ? String(realtimeActive.latestRealtimeTranscript || '') : '';
    const realtimeConfidence = realtimeActive && Number.isFinite(Number(realtimeActive.latestRealtimeConfidence))
      ? Number(realtimeActive.latestRealtimeConfidence) : null;
    const realtimeWords = realtimeActive && Array.isArray(realtimeActive.realtimeWords) ? realtimeActive.realtimeWords.slice(0,120) : [];
    if (realtimeActive) realtimeHelper.active = null;
    timeline.realtimeTranscript = realtimeTranscript;
    const captureMetrics = {
      durationMs: Math.round(durationMs),
      rawPcmBytes: pcm16Bytes,
      acceptedPcmBytes: pcm.length,
      speechDetected: pcm.length > 0,
      transportGated: true,
      browserVadBypassed: true,
      overlappedBotPlayback,
      realtimeTranscript,
      realtimeConfidence,
      realtimeWords,
      bargeInTriggerMs: Number(timeline.bargeInTriggerMs) || 0,
    };
    console.log(`[capture] finalized utterance=${utteranceId} reason=${reason} duration=${captureMetrics.durationMs}ms pcm=${pcm.length}B transport-gated=true botOverlap=${overlappedBotPlayback}`);
    mirrorRuntimeLog('CAPTURE', `${captureMetrics.durationMs}ms ${reason} realtime="${realtimeTranscript || '-'}"`);
    await handleCapturedUtterance({
      pcm,
      userId,
      sessionEpoch,
      utteranceId,
      timeline,
      captureMetrics,
    });
  };

  const session = { opus, decoder, resampler, markSpeaking, finalize };
  sessions.set(userId, session);
  if (speakingNow) markSpeaking(Boolean(options?.startedDuringBotPlayback));

  finalizeTimer = setInterval(() => {
    if (completed || !lastPcmAt || pcm16Bytes === 0) return;
    if (Date.now() - lastPcmAt >= DISCORD_SEGMENT_SILENCE_MS) {
      finalize('discord-pcm-silence').catch(() => {});
    }
  }, 25);

  decoder.on('data', (pcm48) => {
    if (!resampler.stdin.destroyed && !resampler.stdin.writableEnded) resampler.stdin.write(pcm48);
  });

  resampler.stdout.on('data', (pcm16) => {
    if (!pcm16?.length || completed) return;
    const at = Date.now();
    lastUserPcmAt = at;
    if (!timeline.firstPcmAt) timeline.firstPcmAt = at;
    if (!timeline.discordReceiveStartAt) timeline.discordReceiveStartAt = at;
    lastPcmAt = at;
    pcm16Bytes += pcm16.length;
    pcm16Chunks.push(Buffer.from(pcm16));
    if (!utteranceSerial) ensureUtteranceSerial();
    if (!realtimeHelper || !realtimeHelper.ws || realtimeHelper.ws.readyState >= WebSocket.CLOSING) {
      realtimeHelper = beginRealtimeUtterance(userId, {
        utteranceId,
        utteranceSerial,
        sessionEpoch,
        timeline,
        startedDuringBotPlayback: overlappedBotPlayback,
      });
    }
    sendRealtimePcm(realtimeHelper, pcm16);
    if (realtimeHelper?.active?.utteranceId === utteranceId) updateBargeInVoiceGate(realtimeHelper.active, pcm16);
  });

  resampler.stdout.on('error', (error) => {
    console.error('[resample]', error.message);
    finalize('resampler-output-error').catch(() => {});
  });
  resampler.on('error', (error) => {
    console.error('[resample]', error.message);
    finalize('resampler-process-error').catch(() => {});
  });
  decoder.on('error', (error) => {
    console.error('[decode]', error.message);
    finalize('decoder-error').catch(() => {});
  });
  opus.on('error', (error) => {
    console.error('[opus]', error.message);
    finalize('opus-error').catch(() => {});
  });
  opus.on('end', () => finalize('discord-transport-end').catch(() => {}));
  opus.pipe(decoder);

  if (!speakingMarked) console.log(`[capture] prearmed user=${userId}`);
}

function destroyVoiceConnection() {
  voiceEpoch += 1;
  resetConversationState();
  for (const session of sessions.values()) {
    try { session.opus?.destroy(); } catch {}
    try { session.decoder?.destroy(); } catch {}
    try { session.resampler?.stdin?.end(); } catch {}
    try { session.resampler?.kill?.('SIGKILL'); } catch {}
  }
  sessions.clear();
  closeRealtimeHelpers();
  player.stop(true);
  try { connection?.destroy(); } catch {}
  connection = undefined;
}

async function playConnectionGreeting() {
  try {
    const result = await synthesize('フォーンズです。接続しました。');
    await playMp3(result.audio, { spokenText: 'フォーンズです。接続しました。', purpose: 'greeting' });
    console.log('[greeting] connection greeting played');
    return true;
  } catch (error) {
    console.error('[greeting] connection greeting unavailable:', error?.message || error);
    mirrorRuntimeLog('TTS', `greeting unavailable: ${String(error?.message || error).slice(0, 180)}`);
    return false;
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
    const botAudiblySpeaking = Boolean(activeBotPlaybackRecord) || player.state.status === AudioPlayerStatus.Playing;
    const startedDuringBotPlayback = botAudiblySpeaking || (Date.now() - lastBotPlaybackEndedAt < 1200);

    // v84: Discord speaking-start is capture-only. It must not cancel an answer.
    // The confirmed transcript is classified later by the shared turn policy.
    if (!botAudiblySpeaking && activeFastReaction) {
      try { activeFastReaction.stop?.('user-continued-speaking'); } catch {}
      activeFastReaction = null;
    }

    startReceiverSession(userId, true, { startedDuringBotPlayback });
  });

  if (initialUserId && initialUserId !== client.user.id) {
    ensureRealtimeHelper(initialUserId);
    startReceiverSession(initialUserId, false);
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
    if (newState.status !== VoiceConnectionStatus.Disconnected || voiceRecoveryTimer) return;

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
  mirrorRuntimeLog('SESSION', discordSessionId);
  console.log('[discord] input architecture: Discord speaking gate -> Opus -> PCM16 Web STT format -> /api/transcribe');
  console.log('[discord] final STT: Whisper Large v3 Turbo via /api/transcribe');
  console.log('[discord] fast reaction: Web-compatible Nova helper -> /api/fast-reaction (non-authoritative)');
  mirrorRuntimeLog('VOICE', `ready channel=${channel.name}`);
  mirrorRuntimeLog('ARCH', 'Nova helper is reaction-only; Whisper remains authoritative');
  console.log('[discord] bridge revision:', DISCORD_BRIDGE_REVISION);
  await playConnectionGreeting();
  if (process.platform !== 'win32') {
    warmFastReactionAudio().catch((error) => console.warn('[fast-reaction] warmup failed:', error?.message || error));
    warmRecoveryAudio().catch((error) => console.warn('[recovery] warmup failed:', error?.message || error));
  } else {
    // Windows fast-reaction phrases are prepared before Discord login.
    // Never enqueue background TTS after joining a call: it can sit in front
    // of the real answer on windowsTtsQueue and increase perceived latency.
    mirrorRuntimeLog('READY', `Windows fast-reaction cache=${fastReactionAudioCache.size}`);
  }
  return channel;
}

const TALKSYS_COMMANDS = [
  { name: 'talksys', description: 'TalkSysを現在参加中のVCへ呼び出します' },
  { name: 'logs', description: 'TalkSysの起動・通話ライブログをこのチャンネルに表示します' },
  { name: 'leave', description: 'TalkSysをVCから退出させます' },
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
    if (runtimeLogChannel) mirrorRuntimeLog('HEALTH', `gateway=${client.isReady()} ping=${client.ws.ping}ms sessions=${sessions.size}`);
  }, DISCORD_HEALTH_LOG_MS);

  console.log(`[discord] bridge revision=${DISCORD_BRIDGE_REVISION}`);
  console.log(`[discord] gateway ready user=${client.user?.tag || client.user?.id || 'unknown'} ping=${client.ws.ping}ms`);
  mirrorRuntimeLog('VERSION', DISCORD_BRIDGE_REVISION);
  mirrorRuntimeLog('GATEWAY', `ready ping=${client.ws.ping}ms guilds=${client.guilds.cache.size}`);
  try {
    const guilds = [...client.guilds.cache.values()];
    if (!guilds.length) throw new Error('Discord Botがサーバーに参加していません');
    for (const guild of guilds) {
      await ensureTalkSysCommands(guild);
      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /logs /leave`);
    }
    warmFastReactionAudio().catch((error) => console.warn('[fast-reaction] gateway warmup failed:', error?.message || error));
    warmRecoveryAudio().catch((error) => console.warn('[recovery] gateway warmup failed:', error?.message || error));
    console.log('[discord] waiting for /talksys from a user in a voice channel');
  } catch (error) {
    console.error('[fatal]', error?.stack || error);
    process.exitCode = 1;
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  if (!['talksys', 'logs', 'leave'].includes(interaction.commandName)) return;

  console.log(`[interaction] received command=/${interaction.commandName} guild=${interaction.guild.id} user=${interaction.user.id}`);
  try {
    await interaction.deferReply({ ephemeral: true });
    console.log(`[interaction] acked command=/${interaction.commandName}`);
  } catch (error) {
    console.error(`[interaction] ack failed command=/${interaction.commandName}:`, error?.stack || error);
    return;
  }

  try {
    if (interaction.commandName === 'logs') {
      const attached = await attachRuntimeLogChannel(interaction.channel);
      await interaction.editReply(attached
        ? 'TalkSysのライブログをこのチャンネルに表示します。'
        : 'このチャンネルにはライブログを表示できません。');
      return;
    }

    if (interaction.commandName === 'talksys') {
      await attachRuntimeLogChannel(interaction.channel);
      mirrorRuntimeLog('CMD', `/talksys by ${interaction.user.tag || interaction.user.id}`);
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

    mirrorRuntimeLog('CMD', '/leave');
    destroyVoiceConnection();
    await interaction.editReply('TalkSysをボイスチャンネルから退出させました。');
  } catch (error) {
    console.error('[command]', error?.stack || error);
    try {
      await interaction.editReply(`TalkSysのVC操作に失敗しました: ${String(error?.message || error).slice(0, 180)}`);
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
player.on('error', (error) => { console.error('[player]', error.message); mirrorRuntimeLog('ERROR', `player: ${error.message}`); });

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason?.stack || reason);
  mirrorRuntimeLog('ERROR', `unhandled: ${reason?.message || reason}`);
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

mirrorRuntimeLog('BOOT', `process start node=${process.version}`);
mirrorRuntimeLog('BOOT', `bridge=${DISCORD_BRIDGE_REVISION}`);
// Prepare only the small, fixed backchannel set before the bot becomes
// available. This moves System.Speech cost to process startup and keeps the
// runtime answer queue clear. Recovery TTS remains lazy on Windows.
if (process.platform === 'win32') {
  try {
    await warmFastReactionAudio();
    console.log(`[boot] fast-reaction cache ready=${fastReactionAudioCache.size}`);
  } catch (error) {
    console.warn('[boot] fast-reaction warmup failed:', error?.message || error);
  }
}

client.login(DISCORD_TOKEN).catch((error) => {
  if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
  console.error('[fatal] Discord login failed:', error?.stack || error);
  client.destroy();
  process.exit(2);
});
