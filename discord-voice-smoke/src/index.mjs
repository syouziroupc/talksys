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
import { sameUtterance, classifyVoiceTurn, isIgnorableSttFailure } from '../../src/voice-fast-reaction.js';

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
const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v114-no-stale-owner-r1';
const WEB_UNIFIED_MODE = process.env.TALKSYS_WEB_UNIFIED !== '0';
const MAX_HISTORY = 14;
const RECEIVER_PACKET_START_TIMEOUT_MS = 5000;
const VOICE_REJOIN_TIMEOUT_MS = 10000;
const DISCORD_READY_TIMEOUT_MS = 120000;
const DISCORD_HEALTH_LOG_MS = 60000;
const BRIDGE_HEARTBEAT_MS = 5000;
const BRIDGE_HEARTBEAT_FILE = process.env.TALKSYS_BRIDGE_HEARTBEAT_FILE || '';
const BRIDGE_SHUTDOWN_FILE = process.env.TALKSYS_BRIDGE_SHUTDOWN_FILE || '';
const BRIDGE_SHUTDOWN_POLL_MS = 500;
const DISCORD_REST_DEADLINE_MS = 8000;
const REALTIME_WS_MAX_BUFFERED_BYTES = 256 * 1024;
const REALTIME_PREOPEN_MAX_BYTES = 96 * 1024;
const REALTIME_WS_CONNECT_TIMEOUT_MS = 5000;
const WINDOWS_TTS_HARD_TIMEOUT_MS = 15000;
const WINDOWS_TTS_QUEUE_WAIT_MS = 1500;
const PLAYBACK_START_TIMEOUT_MS = 5000;
const PLAYBACK_STALL_TIMEOUT_MS = 10000;
const HEARTBEAT_WRITE_TIMEOUT_MS = 1500;
const RUNTIME_LOG_WRITE_TIMEOUT_MS = 4000;
const TTS_FILE_READ_TIMEOUT_MS = 2000;
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
const managedChildProcesses = new Map();
let activeTurnAbortController = null;
let activeTurnSerial = 0;
let activeWaitCue = null;
let activeFastReaction = null;
let preAnswerCueSerial = 0;
let waitCueSerial = 0;
const fastReactionAudioCache = new Map();
const realtimeHelpers = new Map();
const recentBotSpeech = [];
const recentAcceptedUserTurns = [];
let runtimeLogChannel = null;
let runtimeLogMessage = null;
let runtimeLogFlushTimer = null;
let runtimeLogFlushInFlight = false;
let runtimeLogDirty = false;
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
let bridgeHeartbeatTimer = null;
let bridgeShutdownPollTimer = null;
let bridgeShutdownPollInFlight = false;
let bridgeShuttingDown = false;
const pipelineStages = new Map();
let activePipelineStage = 'idle';
let activePipelineStageAt = 0;
let activePipelineUtteranceId = '';
let activePipelineStageBlocking = false;
let activePipelineStageDeadlineMs = 0;
let heartbeatWriteInFlight = false;
let windowsTtsQueue = Promise.resolve();
let audioPlaybackSerial = 0;

const PIPELINE_STAGE_POLICY = Object.freeze({
  stt: { blocking: true, stallMs: 5000, deadlineMs: REQUEST_BUDGET_MS.stt + 5000 },
  'stt-complete': { blocking: true, stallMs: 5000, deadlineMs: 10000 },
  turn: { blocking: true, stallMs: 5000, deadlineMs: REQUEST_BUDGET_MS.turn + 5000 },
  'turn-complete': { blocking: true, stallMs: 5000, deadlineMs: 10000 },
  tts: { blocking: true, stallMs: 5000, deadlineMs: REQUEST_BUDGET_MS.tts + 5000 },
  'tts-complete': { blocking: true, stallMs: 5000, deadlineMs: 10000 },
  'playback-starting': { blocking: true, stallMs: 5000, deadlineMs: 10000 },
  'playback-active': { blocking: false, stallMs: 0, deadlineMs: 0 },
  'playback-complete': { blocking: false, stallMs: 0, deadlineMs: 0 },
});

function refreshPipelineStageSummary(reason = 'idle') {
  if (!pipelineStages.size) {
    activePipelineStage = reason;
    activePipelineStageAt = 0;
    activePipelineUtteranceId = '';
    activePipelineStageBlocking = false;
    activePipelineStageDeadlineMs = 0;
    return;
  }

  const records = [...pipelineStages.values()];
  const blocking = records.filter((item) => item.blocking).sort((a, b) => a.at - b.at);
  const selected = blocking[0] || records.sort((a, b) => b.at - a.at)[0];
  activePipelineStage = selected.stage;
  activePipelineStageAt = selected.at;
  activePipelineUtteranceId = selected.utteranceId;
  activePipelineStageBlocking = selected.blocking;
  activePipelineStageDeadlineMs = selected.deadlineMs;
}

function clearPipelineStage(utteranceId = '', reason = 'idle') {
  const key = String(utteranceId || '');
  if (!key) {
    for (const record of pipelineStages.values()) {
      if (record.stallTimer) clearTimeout(record.stallTimer);
    }
    pipelineStages.clear();
    refreshPipelineStageSummary(reason);
    return;
  }

  const record = pipelineStages.get(key);
  if (record?.stallTimer) clearTimeout(record.stallTimer);
  pipelineStages.delete(key);
  refreshPipelineStageSummary(reason);
}

function setPipelineStage(stage, utteranceId = '', overrides = {}) {
  const key = String(utteranceId || '__bridge__');
  const prior = pipelineStages.get(key);
  if (prior?.stallTimer) clearTimeout(prior.stallTimer);

  const policy = PIPELINE_STAGE_POLICY[String(stage || '')] || {};
  const record = {
    utteranceId: String(utteranceId || ''),
    stage: String(stage || 'unknown'),
    at: Date.now(),
    blocking: overrides.blocking ?? policy.blocking ?? true,
    stallMs: Number(overrides.stallMs ?? policy.stallMs ?? 5000),
    deadlineMs: Number(overrides.deadlineMs ?? policy.deadlineMs ?? 30000),
    stallTimer: null,
  };

  if (record.stallMs > 0) {
    record.stallTimer = setTimeout(() => {
      if (pipelineStages.get(key) !== record) return;
      const age = Date.now() - record.at;
      mirrorRuntimeLog('STALL', `u=${shortUtteranceId(record.utteranceId)} stage=${record.stage} age=${age}ms player=${player.state.status}`);
      console.warn(`[stall] utterance=${record.utteranceId || '-'} stage=${record.stage} age=${age}ms player=${player.state.status}`);
    }, record.stallMs);
  }

  pipelineStages.set(key, record);
  refreshPipelineStageSummary();
  mirrorRuntimeLog('STAGE', `u=${shortUtteranceId(record.utteranceId)} ${record.stage} blocking=${record.blocking ? 1 : 0}`);
}

function writeBridgeHeartbeat() {
  if (!BRIDGE_HEARTBEAT_FILE || heartbeatWriteInFlight) return;
  const payload = JSON.stringify({
    pid: process.pid,
    at: Date.now(),
    revision: DISCORD_BRIDGE_REVISION,
    stage: activePipelineStage,
    stageAt: activePipelineStageAt,
    stageBlocking: activePipelineStageBlocking,
    stageDeadlineMs: activePipelineStageDeadlineMs,
    stageCount: pipelineStages.size,
    utteranceId: activePipelineUtteranceId,
    player: player.state.status,
    answering,
  });
  heartbeatWriteInFlight = true;
  fs.promises.writeFile(BRIDGE_HEARTBEAT_FILE, payload, {
    signal: AbortSignal.timeout(HEARTBEAT_WRITE_TIMEOUT_MS),
  })
    .catch((error) => {
      console.warn('[heartbeat] write failed:', error?.message || error);
    })
    .finally(() => {
      heartbeatWriteInFlight = false;
    });
}

function installedPackageVersion(relativePath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
    return String(pkg?.version || 'unknown');
  } catch {
    return 'unknown';
  }
}

const RUNTIME_VERSIONS = Object.freeze({
  node: process.version,
  discordJs: installedPackageVersion('../node_modules/discord.js/package.json'),
  discordVoice: installedPackageVersion('../node_modules/@discordjs/voice/package.json'),
  prismMedia: installedPackageVersion('../node_modules/prism-media/package.json'),
  opusScript: installedPackageVersion('../node_modules/opusscript/package.json'),
});

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
  waitCueSerial += 1;
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
  clearPipelineStage('', 'idle');
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

function isClearlySilentCapture(captureMetrics = {}) {
  if (String(captureMetrics?.realtimeTranscript || '').trim()) return false;
  const maxRms = Number(captureMetrics?.maxRms) || 0;
  const maxPeak = Number(captureMetrics?.maxPeak) || 0;
  const rmsFloor = WEB_VOICE_CAPTURE_POLICY.startRmsMin * 0.55;
  const peakFloor = WEB_VOICE_CAPTURE_POLICY.peakGateMin * 0.65;
  return maxRms < rmsFloor && maxPeak < peakFloor;
}

function runtimeLogText() {
  const body = runtimeLogLines.slice(-18).join('\n');
  return `**TalkSys Discord runtime** · ${DISCORD_BRIDGE_REVISION}\n\`\`\`text\n${body.slice(-1750)}\n\`\`\``;
}

function scheduleRuntimeLogFlush() {
  if (!runtimeLogChannel) return;
  runtimeLogDirty = true;
  if (runtimeLogFlushTimer || runtimeLogFlushInFlight) return;

  runtimeLogFlushTimer = setTimeout(async () => {
    runtimeLogFlushTimer = null;
    if (!runtimeLogChannel || runtimeLogFlushInFlight) return;

    runtimeLogFlushInFlight = true;
    runtimeLogDirty = false;
    const channel = runtimeLogChannel;
    const message = runtimeLogMessage;
    let timeout = null;
    try {
      const operation = message
        ? message.edit(runtimeLogText())
        : channel.send(runtimeLogText());
      const result = await Promise.race([
        operation,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('runtime_log_write_timeout')), RUNTIME_LOG_WRITE_TIMEOUT_MS);
        }),
      ]);
      if (!message && result) runtimeLogMessage = result;
    } catch (error) {
      console.warn('[discord-log] mirror failed:', error?.message || error);
      if (String(error?.message || '').includes('runtime_log_write_timeout')) {
        // Diagnostics must never accumulate unresolved Discord REST writes
        // or compete with the voice pipeline.
        runtimeLogChannel = null;
        runtimeLogMessage = null;
        runtimeLogDirty = false;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      runtimeLogFlushInFlight = false;
      if (runtimeLogChannel && runtimeLogDirty) scheduleRuntimeLogFlush();
    }
  }, 700);
}

function shortUtteranceId(value = '') {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.startsWith('utt-') ? text.slice(4, 12) : text.slice(0, 8);
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
  mirrorRuntimeLog('BOOT', `webUnified=${WEB_UNIFIED_MODE}`);
  mirrorRuntimeLog('BOOT', `TalkSys=${TALKSYS_BASE_URL}`);
  mirrorRuntimeLog('BOOT', `runtime node=${RUNTIME_VERSIONS.node} discord.js=${RUNTIME_VERSIONS.discordJs} voice=${RUNTIME_VERSIONS.discordVoice} prism=${RUNTIME_VERSIONS.prismMedia} opus=${RUNTIME_VERSIONS.opusScript}`);
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
  // Keep warmup transport-only: reaction wording/eligibility remains authoritative on /api/fast-reaction.
  // Known audio may be cached only after the Worker has actually returned that reaction.
  mirrorRuntimeLog('READY', `fast-reaction cache=${fastReactionAudioCache.size} worker-authoritative`);
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
        signal: controller.signal,
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

function triggerEndOfUtteranceReaction(helper, text) {
  const active = helper?.active;
  const value = String(text || '').trim();
  if (!active || !value || active.sessionEpoch !== voiceEpoch) return false;
  if (active.startedDuringBotPlayback) return false;
  if (active.reactionIssued) return false;

  // Web parity: Discord never makes a local semantic decision about backchannels.
  // The shared Worker /api/fast-reaction endpoint is authoritative.
  triggerWebFastReaction(helper, value);
  return true;
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
    reconnectTimer: null,
    connectTimer: null,
    connectedAt: 0,
    errorCount: 0,
    closeCount: 0,
    backpressureDrops: 0,
  };
  realtimeHelpers.set(userId, helper);
  try {
    const ws = new WebSocket(realtimeSttUrl());
    helper.ws = ws;
    ws.binaryType = 'arraybuffer';
    helper.connectTimer = setTimeout(() => {
      helper.connectTimer = null;
      if (helper.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      helper.ready = false;
      helper.ws = null;
      helper.buffered = [];
      helper.bufferedBytes = 0;
      mirrorRuntimeLog('RT-STT', `connect timeout user=${userId}; helper reset`);
      if (realtimeHelpers.get(userId) === helper) realtimeHelpers.delete(userId);
      try { ws.close(); } catch {}
    }, REALTIME_WS_CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (helper.connectTimer) {
        clearTimeout(helper.connectTimer);
        helper.connectTimer = null;
      }
      helper.ready = true;
      helper.connectedAt = Date.now();
      if (helper.reconnectTimer) {
        clearTimeout(helper.reconnectTimer);
        helper.reconnectTimer = null;
      }
      mirrorRuntimeLog('RT-STT', `ready user=${userId} buffered=${helper.bufferedBytes}B`);
      let flushedBytes = 0;
      for (const chunk of helper.buffered) {
        if (Number(ws.bufferedAmount || 0) >= REALTIME_WS_MAX_BUFFERED_BYTES) {
          helper.backpressureDrops += 1;
          mirrorRuntimeLog('RT-STT', `preopen flush stopped user=${userId} queued=${Number(ws.bufferedAmount || 0)}B`);
          break;
        }
        try {
          ws.send(chunk);
          flushedBytes += chunk.length;
        } catch {
          break;
        }
      }
      helper.buffered = [];
      helper.bufferedBytes = 0;
      if (flushedBytes) mirrorRuntimeLog('RT-STT', `flushed user=${userId} bytes=${flushedBytes}`);
    };
    ws.onmessage = (event) => handleRealtimeMessage(helper, event.data);
    ws.onerror = () => {
      helper.ready = false;
      helper.errorCount = Number(helper.errorCount || 0) + 1;
      mirrorRuntimeLog('RT-STT', `error user=${userId} count=${helper.errorCount} readyFor=${helper.connectedAt ? Date.now() - helper.connectedAt : 0}ms; resetting helper`);
      try { ws.close(); } catch {}
    };
    ws.onclose = (event) => {
      if (helper.connectTimer) {
        clearTimeout(helper.connectTimer);
        helper.connectTimer = null;
      }
      helper.ready = false;
      helper.ws = null;
      helper.closeCount = Number(helper.closeCount || 0) + 1;
      mirrorRuntimeLog('RT-STT', `closed user=${userId} code=${event?.code ?? '?'} clean=${event?.wasClean ?? '?'} buffered=${helper.bufferedBytes}B count=${helper.closeCount}`);
      if (realtimeHelpers.get(userId) === helper) realtimeHelpers.delete(userId);
      if (connection && !helper.reconnectTimer) {
        helper.reconnectTimer = setTimeout(() => {
          helper.reconnectTimer = null;
          if (!connection || realtimeHelpers.has(userId)) return;
          const voiceState = client.guilds.cache
            .get(String(connection?.joinConfig?.guildId || ''))
            ?.voiceStates?.cache?.get(userId);
          if (String(voiceState?.channelId || '') !== String(connection?.joinConfig?.channelId || '')) return;
          mirrorRuntimeLog('RT-STT', `reconnect user=${userId}`);
          ensureRealtimeHelper(userId);
        }, 1200);
      }
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
  const ws = helper.ws;

  if (ws?.readyState === WebSocket.OPEN) {
    const queued = Number(ws.bufferedAmount || 0);
    if (queued >= REALTIME_WS_MAX_BUFFERED_BYTES) {
      helper.backpressureDrops = Number(helper.backpressureDrops || 0) + 1;
      if (helper.backpressureDrops === 1 || helper.backpressureDrops % 25 === 0) {
        mirrorRuntimeLog('RT-STT', `backpressure user=${helper.userId} queued=${queued}B drops=${helper.backpressureDrops}; reconnecting helper`);
      }
      helper.ready = false;
      try { ws.close(4001, 'realtime-backpressure'); } catch {}
      return;
    }
    try {
      ws.send(chunk);
    } catch (error) {
      helper.ready = false;
      mirrorRuntimeLog('RT-STT', `send failed user=${helper.userId}: ${String(error?.message || error).slice(0, 120)}`);
      try { ws.close(); } catch {}
    }
    return;
  }

  if (ws?.readyState === WebSocket.CONNECTING) {
    if (helper.bufferedBytes + chunk.length <= REALTIME_PREOPEN_MAX_BYTES) {
      helper.buffered.push(chunk);
      helper.bufferedBytes += chunk.length;
    } else {
      helper.backpressureDrops = Number(helper.backpressureDrops || 0) + 1;
      if (helper.backpressureDrops === 1) {
        mirrorRuntimeLog('RT-STT', `preopen buffer capped user=${helper.userId} limit=${REALTIME_PREOPEN_MAX_BYTES}B`);
      }
    }
  }
}

function closeRealtimeHelpers() {
  for (const helper of realtimeHelpers.values()) {
    helper.reactionSeq += 1;
    helper.active = null;
    if (helper.reconnectTimer) {
      clearTimeout(helper.reconnectTimer);
      helper.reconnectTimer = null;
    }
    if (helper.connectTimer) {
      clearTimeout(helper.connectTimer);
      helper.connectTimer = null;
    }
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
  clearPipelineStage(utteranceId, 'idle');

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
  if (cueReleased) {
    preAnswerCueSerial += 1;
    waitCueSerial += 1;
  }

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

async function withPromiseDeadline(promise, timeoutMs = DISCORD_REST_DEADLINE_MS, label = 'operation') {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), Math.max(1, Number(timeoutMs) || 1));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const ffmpeg = trackManagedChild(spawn(ffmpegPath, [
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
  ], { stdio: ['pipe', 'pipe', 'pipe'] }), 'resampler');
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
  mirrorRuntimeLog('STT', `u=${shortUtteranceId(utteranceId)} Whisper start pcm=${pcm.length}B`);

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
  mirrorRuntimeLog('STT', `u=${shortUtteranceId(utteranceId)} Whisper=${timeline.whisperCompleteAt - timeline.transcribeStartAt}ms server=${Number(body?.elapsedMs) || 0} model=${body.model || '?'} text="${confirmedTranscript}"`);
  return {
    confirmedTranscript,
    fastReaction: body?.fastReaction || null,
    model: body?.model || '',
    serverElapsedMs: Number(body?.elapsedMs) || 0,
    signal: body?.signal || null,
  };
}

async function postVoiceCheckpoint(stage, utteranceId, extra = {}) {
  try {
    const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/voice-stage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        sessionId: discordSessionId || `discord-${randomUUID()}`,
        utteranceId,
        channel: 'discord',
        stage,
        bridgeRevision: DISCORD_BRIDGE_REVISION,
        at: Date.now(),
        ...extra,
      }),
    }, {
      timeoutMs: 1800,
      label: 'voice-stage',
    });
    await response.arrayBuffer().catch(() => {});
    return response.ok;
  } catch (error) {
    console.warn('[checkpoint] voice stage failed:', error?.message || error);
    return false;
  }
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
    const detail = String(errorValue?.message || errorValue || '').slice(0, 220);
    console.warn('[metrics] voice metrics failed:', detail);
    mirrorRuntimeLog('METRICS-ERROR', `u=${shortUtteranceId(utteranceId)} ${detail}`);
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

function startWaitCue(text, utteranceId, parentSignal) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const cueSerial = ++waitCueSerial;
  let playing = false;
  let stopped = false;

  const done = (async () => {
    try {
      // Web parity: search preface is always an independent shared Worker decision.
      const cue = await fetchSearchPreface(text, signal);
      if (!cue || signal.aborted || stopped || cueSerial !== waitCueSerial) return false;
      if (activeFastReaction?.done) {
        await activeFastReaction.done.catch(() => {});
        if (signal.aborted || stopped || cueSerial !== waitCueSerial) return false;
      }
      const synthesized = await synthesize(cue, signal, { utteranceId, purpose: 'search-preface' });
      if (signal.aborted || stopped || cueSerial !== waitCueSerial) return false;
      playing = true;
      await playMp3(synthesized.audio, { spokenText: cue, purpose: 'search-preface', signal });
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
    },
  };
}

async function talk(text, utteranceId = '', signal, speechAlternatives = [], spokenBackchannel = '') {
  const started = Date.now();
  console.log('[turn] user:', text);
  mirrorRuntimeLog('TURN', `u=${shortUtteranceId(utteranceId)} user="${text}"`);
  const previous = history.slice(-MAX_HISTORY);
  const response = await fetchWithBudget(TALKSYS_BASE_URL + '/api/turn', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      speechAlternatives: WEB_UNIFIED_MODE ? [] : (Array.isArray(speechAlternatives) ? speechAlternatives.slice(0, 3) : []),
      spokenBackchannel: String(spokenBackchannel || '').trim(),
      history: previous,
      searchTrace,
      sessionId: discordSessionId || `discord-${randomUUID()}`,
      utteranceId,
      previousInteractionId,
      channel: 'discord',
      bridgeRevision: DISCORD_BRIDGE_REVISION,
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
  mirrorRuntimeLog('TURN', `u=${shortUtteranceId(utteranceId)} http=${elapsed}ms server=${body?.timings?.totalMs ?? '?'} primary=${body?.timings?.primaryMs ?? '?'} verify=${body?.timings?.verifierMs ?? '?'} search=${body?.search ? 1 : 0}`);
  return body;
}

function trackManagedChild(child, label = 'child') {
  if (!child) return child;
  const record = { child, label, startedAt: Date.now() };
  managedChildProcesses.set(child, record);
  const release = () => managedChildProcesses.delete(child);
  child.once('close', release);
  child.once('error', () => {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) release();
  });
  return child;
}

function terminateAllManagedChildren(reason = 'bridge-shutdown') {
  for (const record of [...managedChildProcesses.values()]) {
    terminateChildProcessTree(record.child, `${reason}:${record.label}`);
  }
}

function terminateChildProcessTree(child, reason = 'terminate') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  mirrorRuntimeLog('CHILD', `terminate pid=${child.pid || '?'} reason=${reason}`);
  try { child.kill('SIGKILL'); } catch {}
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {}
  }
}

function waitForChildProcess(child, { timeoutMs, signal, label = 'child' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let abortHandler = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = (code, childSignal) => finishResolve({ code, signal: childSignal });
    const onError = (error) => finishReject(error);

    child.once('close', onClose);
    child.once('error', onError);

    timer = setTimeout(() => {
      terminateChildProcessTree(child, `${label}-timeout`);
      finishReject(new Error(`${label}_timeout`));
    }, Math.max(1, Number(timeoutMs) || 1));

    if (signal) {
      abortHandler = () => {
        terminateChildProcessTree(child, `${label}-aborted`);
        const reason = signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError');
        finishReject(reason);
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

async function synthesizeWindowsJapaneseTtsUnlocked(text, signal) {
  if (process.platform !== 'win32') throw new Error('windows_tts_unavailable_non_windows');
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
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
  const child = trackManagedChild(spawn('powershell.exe', [
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
  }), 'windows-tts');

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    const result = await waitForChildProcess(child, {
      timeoutMs: WINDOWS_TTS_HARD_TIMEOUT_MS,
      signal,
      label: 'windows_tts',
    });
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');

    let audio = Buffer.alloc(0);
    try {
      audio = await fs.promises.readFile(tempFile, {
        signal: boundedSignal(signal, TTS_FILE_READ_TIMEOUT_MS),
      });
    } catch {}

    if (result.code !== 0 || audio.length < 44) {
      throw new Error(`windows_tts_failed code=${result.code} signal=${result.signal || ''} bytes=${audio.length} detail=${stderr.trim().slice(0, 240)}`);
    }

    return {
      audio,
      source: 'windows-system-speech',
      elapsedMs: Date.now() - started,
      workerMs: 0,
    };
  } finally {
    terminateChildProcessTree(child, 'windows-tts-finally');
    fs.promises.unlink(tempFile).catch(() => {});
  }
}

async function synthesizeWindowsJapaneseTts(text, signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');

  const prior = windowsTtsQueue.catch(() => {});
  const acquired = await Promise.race([
    prior.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), WINDOWS_TTS_QUEUE_WAIT_MS)),
  ]);
  if (!acquired) {
    mirrorRuntimeLog('TTS-QUEUE', `Windows TTS queue wait exceeded ${WINDOWS_TTS_QUEUE_WAIT_MS}ms`);
    throw new Error('windows_tts_queue_wait_timeout');
  }

  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  const task = synthesizeWindowsJapaneseTtsUnlocked(text, signal);
  windowsTtsQueue = task.then(() => undefined, () => undefined);
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
  mirrorRuntimeLog('TTS', `u=${shortUtteranceId(meta?.utteranceId)} ${elapsedMs}ms worker=${workerMs || '?'} source=${source} bytes=${audio.length}`);
  return { audio, source, elapsedMs, workerMs };
}

async function synthesize(text, signal, meta = {}) {
  if (process.platform === 'win32') {
    try {
      const local = await synthesizeWindowsJapaneseTts(text, signal);
      console.log(`[tts] ${local.audio.length} bytes source=${local.source}`);
      console.log(`[latency] tts-local=${local.elapsedMs}ms source=${local.source}`);
      mirrorRuntimeLog('TTS', `u=${shortUtteranceId(meta?.utteranceId)} ${local.elapsedMs}ms source=${local.source} bytes=${local.audio.length}`);
      return local;
    } catch (localError) {
      const detail = String(localError?.message || localError || '');
      if (signal?.aborted || localError?.name === 'AbortError') throw localError;
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
    const canStartRecovery = () => sessionEpoch === voiceEpoch
      && !(failedUtteranceEndAt > 0
        && (lastUserSpeechAt > failedUtteranceEndAt || lastUserPcmAt > failedUtteranceEndAt));
    if (!canStartRecovery()) {
      console.warn(`[recovery] suppressed after synthesis because a newer user utterance started reason=${reason}`);
      return false;
    }
    await playMp3(audio, {
      spokenText: RECOVERY_PROMPT,
      purpose: 'recovery',
      canStart: canStartRecovery,
    });
    console.warn(`[recovery] spoken reason=${reason}`);
    return true;
  } catch (error) {
    console.error('[recovery] unavailable:', error?.message || error);
    return false;
  } finally {
    recoverySpeaking = false;
  }
}

function playerOwnsResource(resource) {
  return Boolean(resource && player.state?.resource === resource);
}

function stopOwnedPlayback(resource) {
  if (!playerOwnsResource(resource)) return false;
  try { return player.stop(true); } catch { return false; }
}

async function playMp3(mp3, options = {}) {
  if (!ffmpegPath) throw new Error('ffmpeg_static_missing');
  if (options?.signal?.aborted) {
    throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  }

  const playbackId = ++audioPlaybackSerial;
  const ffmpegStarted = Date.now();
  const ffmpeg = trackManagedChild(spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] }), 'playback-ffmpeg');

  let ffmpegError = '';
  let ffmpegSpawnMs = 0;
  let botSpeechRecord = null;
  let started = false;
  let lastProgressAt = Date.now();
  let lastPlaybackDuration = 0;
  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    metadata: { playbackId },
  });

  const terminateFfmpeg = (reason = 'complete') => {
    if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) return;
    if (reason !== 'complete') {
      mirrorRuntimeLog('FFMPEG', `u=${shortUtteranceId(options?.utteranceId)} terminate id=${playbackId} reason=${reason}`);
    }
    try { ffmpeg.kill('SIGKILL'); } catch {}
  };

  ffmpeg.stderr.on('data', (d) => { ffmpegError += String(d); });
  ffmpeg.stdout.once('data', () => {
    ffmpegSpawnMs = Date.now() - ffmpegStarted;
    console.log(`[latency] ffmpeg-first-output=${ffmpegSpawnMs}ms`);
  });

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    let startTimer = null;
    let watchdog = null;
    let abortHandler = null;

    const finishBotRecord = () => {
      finishBotSpeech(botSpeechRecord);
      if (botSpeechRecord) lastBotPlaybackEndedAt = Date.now();
      if (activeBotPlaybackRecord === botSpeechRecord) activeBotPlaybackRecord = null;
    };
    const cleanup = () => {
      if (startTimer) clearTimeout(startTimer);
      if (watchdog) clearInterval(watchdog);
      player.off('stateChange', onStateChange);
      player.off('error', onPlayerError);
      ffmpeg.off('error', onFfmpegError);
      ffmpeg.off('close', onFfmpegClose);
      if (options?.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      finishBotRecord();
      terminateFfmpeg('complete');
      resolve({
        playbackStartedAt: Number(resource.metadata?.playbackStartedAt) || 0,
        ffmpegSpawnMs: Number(resource.metadata?.ffmpegSpawnMs) || ffmpegSpawnMs || 0,
      });
    };
    const fail = (error, reason = 'failed') => {
      if (settled) return;
      settled = true;
      cleanup();
      finishBotRecord();
      stopOwnedPlayback(resource);
      terminateFfmpeg(reason);
      reject(error instanceof Error ? error : new Error(String(error || reason)));
    };

    const onStateChange = (oldState, newState) => {
      const oldOwn = oldState?.resource === resource;
      const newOwn = newState?.resource === resource;

      if (!started && newOwn && newState.status === AudioPlayerStatus.Playing) {
        started = true;
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        const playbackStartedAt = Date.now();
        const measuredFfmpegMs = ffmpegSpawnMs || Math.max(0, playbackStartedAt - ffmpegStarted);
        resource.metadata.playbackStartedAt = playbackStartedAt;
        resource.metadata.ffmpegSpawnMs = measuredFfmpegMs;
        lastProgressAt = playbackStartedAt;
        lastPlaybackDuration = Number(newState.playbackDuration) || 0;
        if (options?.spokenText) {
          botSpeechRecord = rememberBotSpeech(options.spokenText, options?.purpose || '', playbackStartedAt);
          activeBotPlaybackRecord = botSpeechRecord;
        }
        console.log('[tx] playback started');
        mirrorRuntimeLog('TX', `u=${shortUtteranceId(options?.utteranceId)} start id=${playbackId} ffmpeg=${measuredFfmpegMs}ms purpose=${options?.purpose || 'audio'}`);
        try { options?.onPlaybackStart?.({ playbackStartedAt, ffmpegSpawnMs: measuredFfmpegMs }); } catch {}
        return;
      }

      if (oldOwn && newState.status === AudioPlayerStatus.Idle) {
        if (!started) fail(new Error('playback_ended_before_start'), 'ended-before-start');
        else succeed();
        return;
      }

      if (oldOwn && !newOwn && newState.status !== AudioPlayerStatus.Idle) {
        fail(new Error('playback_replaced'), 'replaced');
      }
    };

    const onPlayerError = (error) => {
      if (error?.resource && error.resource !== resource) return;
      if (!playerOwnsResource(resource) && !started) return;
      fail(error, 'player-error');
    };

    const onFfmpegError = (error) => fail(error, 'ffmpeg-error');
    const onFfmpegClose = (code) => {
      if (!settled && code && code !== 0) {
        fail(new Error(`ffmpeg_exit_${code}: ${ffmpegError.trim().slice(0, 240)}`), 'ffmpeg-exit');
      }
    };

    player.on('stateChange', onStateChange);
    player.on('error', onPlayerError);
    ffmpeg.once('error', onFfmpegError);
    ffmpeg.once('close', onFfmpegClose);

    if (options?.signal) {
      abortHandler = () => {
        const reason = options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException('Aborted', 'AbortError');
        fail(reason, 'aborted');
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    startTimer = setTimeout(() => {
      fail(new Error('playback_start_timeout'), 'start-timeout');
    }, PLAYBACK_START_TIMEOUT_MS);

    watchdog = setInterval(() => {
      if (settled || !started) return;
      if (!playerOwnsResource(resource)) {
        fail(new Error('playback_resource_lost'), 'resource-lost');
        return;
      }
      const state = player.state;
      const duration = Number(state?.playbackDuration ?? resource.playbackDuration) || 0;
      if (duration > lastPlaybackDuration + 20) {
        lastPlaybackDuration = duration;
        lastProgressAt = Date.now();
        return;
      }
      if (Date.now() - lastProgressAt >= PLAYBACK_STALL_TIMEOUT_MS) {
        fail(new Error('playback_stall_timeout'), 'stall-timeout');
      }
    }, 500);

    try {
      if (typeof options?.canStart === 'function' && !options.canStart()) {
        fail(new Error('playback_start_guard_rejected'), 'start-guard');
        return;
      }
      ffmpeg.stdin.end(mp3);
      player.play(resource);
    } catch (error) {
      fail(error, 'play-start-error');
    }
  });

  if (ffmpegError.trim()) console.log('[ffmpeg]', ffmpegError.trim());
  return result;
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
    // Web parity: once Whisper has confirmed a real new user turn, the old
    // answer is stale. Abort it instead of making the confirmed user wait.
    interruptActiveAnswer('confirmed-new-user-turn');
    mirrorRuntimeLog('TURN-SWITCH', `confirmed new turn: ${confirmedTranscript}`);
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
  const pipelineHardTimeout = setTimeout(() => {
    if (turnSerial !== activeTurnSerial || controller.signal.aborted) return;
    const age = Date.now() - pipelineStarted;
    const stage = pipelineStages.get(utteranceId)?.stage || activePipelineStage || 'unknown';
    mirrorRuntimeLog('PIPELINE-TIMEOUT', `u=${shortUtteranceId(utteranceId)} stage=${stage} age=${age}ms`);
    console.warn(`[pipeline-timeout] utterance=${utteranceId} stage=${stage} age=${age}ms`);
    postVoiceCheckpoint('pipeline-timeout', utteranceId, { stage, ageMs: age }).catch(() => {});
    try { controller.abort(new Error('answer_pipeline_hard_timeout')); } catch {}
    try { activeWaitCue?.stop?.('pipeline-hard-timeout'); } catch {}
    try { activeFastReaction?.stop?.('pipeline-hard-timeout'); } catch {}
    try { player.stop(true); } catch {}
  }, 55000);

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
    setPipelineStage('turn', utteranceId);
    postVoiceCheckpoint('turn-start', utteranceId, { text: confirmedTranscript }).catch(() => {});

    if (!timeline.fastReactionRequestedAt && fastReaction?.shouldSpeak && String(fastReaction?.text || '').trim()) {
      playWebFastReaction(fastReaction, utteranceId, sessionEpoch, timeline, confirmedTranscript);
    }
    activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal);
    const realtimeAlternative = String(captureMetrics?.realtimeTranscript || '').trim();
    const speechAlternatives = realtimeAlternative && !sameUtterance(realtimeAlternative, confirmedTranscript)
      ? [realtimeAlternative]
      : [];
    const spokenBackchannel = fastReaction?.shouldSpeak ? String(fastReaction?.text || '').trim() : '';
    const turn = await talk(confirmedTranscript, utteranceId, controller.signal, speechAlternatives, spokenBackchannel);
    if (controller.signal.aborted || turnSerial !== activeTurnSerial || sessionEpoch !== voiceEpoch) {
      throw controller.signal.reason || new Error('stale_turn_after_response');
    }
    timeline.finalAnswerAt = Date.now();
    setPipelineStage('turn-complete', utteranceId);
    timings.primaryMs = Number(turn?.timings?.primaryMs) || 0;
    timings.verifierMs = Number(turn?.timings?.verifierMs) || 0;
    timings.answerGenerationTotalMs = Number(turn?.timings?.totalMs) || Math.max(0, timeline.finalAnswerAt - timeline.turnStartAt);

    // v84: ordinary user speech no longer invalidates an answer that is already being generated.
    // Only classifyVoiceTurn(...)=interrupt can abort it.

    // Waiting audio is never part of the answer dependency chain.
    preAnswerCueSerial += 1;
    waitCueSerial += 1;
    if (activeWaitCue?.utteranceId === utteranceId) {
      activeWaitCue.stop?.('final-answer-ready');
      activeWaitCue = null;
    }
    if (activeFastReaction?.utteranceId === utteranceId) {
      activeFastReaction.stop?.('final-answer-ready');
      activeFastReaction = null;
    }

    timeline.ttsStartAt = Date.now();
    setPipelineStage('tts', utteranceId);
    postVoiceCheckpoint('tts-start', utteranceId).catch(() => {});
    const tts = await synthesize(turn.answer, controller.signal, { utteranceId, purpose: 'answer' });
    timeline.ttsEndAt = Date.now();
    setPipelineStage('tts-complete', utteranceId);
    timings.firstTtsMs = tts.elapsedMs;
    timings.firstAudioReadyMs = Math.max(0, timeline.ttsEndAt - pipelineStarted);
    timings.ttsProvider = tts.source;

    const playbackWallStarted = Date.now();
    setPipelineStage('playback-starting', utteranceId);
    postVoiceCheckpoint('playback-start', utteranceId).catch(() => {});
    await playMp3(tts.audio, {
      spokenText: turn.answer,
      purpose: 'answer',
      utteranceId,
      signal: controller.signal,
      onPlaybackStart: ({ playbackStartedAt, ffmpegSpawnMs }) => {
        clearTimeout(pipelineHardTimeout);
        setPipelineStage('playback-active', utteranceId);
        timeline.playbackStartAt = playbackStartedAt;
        timings.ffmpegSpawnMs = ffmpegSpawnMs;
        timings.speechEndToPlaybackStartMs = Math.max(0, playbackStartedAt - (timeline.utteranceEndAt || playbackStartedAt));
      },
    });
    timings.playbackMs = Date.now() - playbackWallStarted;
    setPipelineStage('playback-complete', utteranceId);
    postVoiceCheckpoint('pipeline-complete', utteranceId).catch(() => {});
  } catch (error) {
    pipelineError = String(error?.message || error || '').slice(0, 500);
    if (controller.signal.aborted || turnSerial !== activeTurnSerial) {
      console.log(`[pipeline] interrupted utterance=${utteranceId}`);
    } else {
      console.error('[pipeline]', error?.stack || error);
      mirrorRuntimeLog('ERROR', `pipeline: ${pipelineError}`);
      postVoiceCheckpoint('pipeline-error', utteranceId, { error: pipelineError }).catch(() => {});
      await speakRecoveryPrompt('answer-pipeline-failed', sessionEpoch, timeline.utteranceEndAt || 0);
    }
  } finally {
    clearTimeout(pipelineHardTimeout);
    // An interrupted pipeline may finish after the replacement turn has
    // already created its own cue/reaction. Only clean up handles that still
    // belong to this utterance; otherwise the old finally block can kill the
    // new turn and make barge-in appear frozen.
    if (activeWaitCue?.utteranceId === utteranceId) {
      activeWaitCue.stop?.('pipeline-complete');
      activeWaitCue = null;
    }
    if (activeFastReaction?.utteranceId === utteranceId) {
      activeFastReaction.stop?.('pipeline-complete');
      activeFastReaction = null;
    }
    timeline.pipelineCompleteAt = Date.now();
    timings.pipelineCompleteMs = Math.max(0, timeline.pipelineCompleteAt - pipelineStarted);
    console.log(`[latency-summary] utterance=${utteranceId} captureMs=${timings.captureMs} sttMs=${timings.sttMs} speechEndToSttFinalMs=${timings.speechEndToSttFinalMs} fastReactionMs=${timings.fastReactionMs} primaryMs=${timings.primaryMs} verifierMs=${timings.verifierMs} answerGenerationTotalMs=${timings.answerGenerationTotalMs} firstTtsMs=${timings.firstTtsMs} ffmpegSpawnMs=${timings.ffmpegSpawnMs} speechEndToPlaybackStartMs=${timings.speechEndToPlaybackStartMs} pipelineCompleteMs=${timings.pipelineCompleteMs}`);
    mirrorRuntimeLog('LATENCY', `u=${shortUtteranceId(utteranceId)} capture=${timings.captureMs} stt=${timings.sttMs} end2stt=${timings.speechEndToSttFinalMs} turn=${timings.answerGenerationTotalMs} gemini=${timings.answerGenerationTotalMs}ms verify=${timings.verifierMs}ms tts=${timings.firstTtsMs} end2play=${timings.speechEndToPlaybackStartMs} playStart=${timings.speechEndToPlaybackStartMs}ms total=${timings.pipelineCompleteMs}`);
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
    clearPipelineStage(utteranceId, 'idle');
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
  if (isClearlySilentCapture(captureMetrics)) {
    const detail = `local-silence rms=${captureMetrics?.maxRms ?? 0} peak=${captureMetrics?.maxPeak ?? 0} duration=${captureMetrics?.durationMs ?? 0}ms`;
    mirrorRuntimeLog('DROP', `u=${shortUtteranceId(utteranceId)} ${detail}`);
    console.log(`[capture] ${detail} utterance=${utteranceId}; Whisper skipped`);
    releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'local-silence-gate' });
    timeline.pipelineCompleteAt = Date.now();
    postVoiceMetrics({
      text: '',
      utteranceId,
      timings: {
        sttMode: 'local-silence-gate',
        captureMs: Math.max(0, (timeline.utteranceEndAt || 0) - (timeline.discordReceiveStartAt || timeline.firstPcmAt || 0)),
        sttMs: 0,
        speechEndToSttFinalMs: 0,
        pipelineCompleteMs: Math.max(0, timeline.pipelineCompleteAt - (timeline.discordReceiveStartAt || timeline.pipelineCompleteAt)),
      },
      timeline,
      realtimeTranscript: '',
      confirmedTranscript: '',
      geminiInputText: '',
      error: 'local-silence-gate',
    }).catch(() => {});
    return;
  }

  try {
    setPipelineStage('stt', utteranceId);
    postVoiceCheckpoint('stt-start', utteranceId).catch(() => {});
    const stt = await transcribeCapturedUtterance(pcm, utteranceId, timeline, controller.signal);
    if (isStaleVoiceResult(userId, sessionEpoch, utteranceSerial)) {
      mirrorRuntimeLog('STT-STALE', `ignored resolved-order ${utteranceId} serial=${utteranceSerial}`);
      releaseDroppedUtterance({ userId, sessionEpoch, utteranceId, controller, reason: 'stale-stt-result' });
      return;
    }
    markVoiceResultResolved(userId, sessionEpoch, utteranceId, utteranceSerial);
    setPipelineStage('stt-complete', utteranceId);
    let rawTranscript = stt.confirmedTranscript;
    let correctedTranscript = rawTranscript;
    let correctionReason = '';
    if (!WEB_UNIFIED_MODE) {
      const correction = correctLowConfidenceTranscript(rawTranscript, captureMetrics, history);
      correctedTranscript = correction.correctedTranscript || rawTranscript;
      correctionReason = correction.correctionReason || '';
      if (correctionReason) mirrorRuntimeLog('STT-CORRECT', correctionReason + ': "' + rawTranscript + '" -> "' + correctedTranscript + '"');
    } else {
      mirrorRuntimeLog('STT-AUTH', 'web transcript accepted without Discord-side semantic rewrite');
    }
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
        const rescueFastReaction = await fetchFastReaction(realtimeRescue, controller.signal).catch(() => null);
        await processConfirmedTranscript({
          confirmedTranscript: realtimeRescue,
          rawTranscript: realtimeRescue,
          correctedTranscript: realtimeRescue,
          correctionReason: 'realtime-rescue-after-whisper-failure',
          fastReaction: rescueFastReaction,
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
  } finally {
    clearPipelineStage(utteranceId, 'idle');
  }
}

function interruptActiveAnswer(reason = 'user-speech') {
  if (!answering && !activeFastReaction && player.state.status !== AudioPlayerStatus.Playing) return false;

  const interruptedUtteranceId = activeUserUtteranceId || activeWaitCue?.utteranceId || activeFastReaction?.utteranceId || '';
  activeTurnSerial += 1;
  preAnswerCueSerial += 1;
  waitCueSerial += 1;

  const controller = activeTurnAbortController;
  activeTurnAbortController = null;
  try { controller?.abort?.(reason); } catch {}

  if (!interruptedUtteranceId || activeWaitCue?.utteranceId === interruptedUtteranceId) {
    try { activeWaitCue?.stop?.(reason); } catch {}
    activeWaitCue = null;
  }
  if (!interruptedUtteranceId || activeFastReaction?.utteranceId === interruptedUtteranceId) {
    try { activeFastReaction?.stop?.(reason); } catch {}
    activeFastReaction = null;
  }

  // Stop output immediately, but do not touch receiver sessions: the user
  // utterance that caused the barge-in is already being captured there.
  try { player.stop(true); } catch {}

  answering = false;
  activeUserText = '';
  activeUserUtteranceId = '';
  pendingTurns.splice(0, pendingTurns.length);
  mirrorRuntimeLog('BARGE', `released old turn utterance=${interruptedUtteranceId || '-'} reason=${reason}`);
  console.log(`[barge-in] interrupted active answer utterance=${interruptedUtteranceId || '-'} reason=${reason}`);
  return true;
}

function isUserInConnectedVoiceChannel(userId) {
  if (!connection) return false;
  const guildId = String(connection?.joinConfig?.guildId || '');
  const channelId = String(connection?.joinConfig?.channelId || '');
  if (!guildId || !channelId) return false;
  const voiceState = client.guilds.cache.get(guildId)?.voiceStates?.cache?.get(userId);
  return String(voiceState?.channelId || '') === channelId;
}

function stopReceiverSession(userId, reason = 'voice-state-left') {
  const session = sessions.get(userId);
  if (session?.cancel) session.cancel(reason);
  const helper = realtimeHelpers.get(userId);
  if (helper) {
    helper.reactionSeq += 1;
    helper.active = null;
    if (helper.reconnectTimer) clearTimeout(helper.reconnectTimer);
    if (helper.connectTimer) clearTimeout(helper.connectTimer);
    helper.reconnectTimer = null;
    helper.connectTimer = null;
    try { helper.ws?.close(1000, reason); } catch {}
    realtimeHelpers.delete(userId);
  }
  mirrorRuntimeLog('CAPTURE', `receiver released user=${userId} reason=${reason}`);
}

function prearmVoiceChannelMembers(channel) {
  if (!channel?.members) return 0;
  let armed = 0;
  for (const [userId, member] of channel.members) {
    if (userId === client.user?.id || member?.user?.bot) continue;
    ensureRealtimeHelper(userId);
    startReceiverSession(userId, false);
    armed += 1;
  }
  mirrorRuntimeLog('CAPTURE', `prearmed members=${armed} channel=${channel.name || channel.id}`);
  return armed;
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

  // Discord speaking state is the primary transport gate. Do not run the full
  // browser VAD here; after capture we only reject clearly sub-threshold silence
  // with no realtime transcript before paying the Whisper round trip.
  const opus = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1600 },
  });
  let decoder = null;
  let resampler = null;
  let session = null;
  const pcm16Chunks = [];

  let completed = false;
  let speakingMarked = false;
  let packetStartWatchdog = null;
  let finalizeTimer = null;
  let pcm16Bytes = 0;
  let lastPcmAt = 0;
  let utteranceSerial = 0;
  let realtimeHelper = null;
  let pcmChunkCount = 0;
  let maxPcmGapMs = 0;
  let maxRms = 0;
  let maxPeak = 0;
  let rmsSum = 0;
  let speakingMarkedAt = 0;
  let firstOpusAt = 0;
  let opusChunkCount = 0;
  let maxOpusGapMs = 0;
  let lastOpusAt = 0;

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
    if (startedDuringBotPlayback) overlappedBotPlayback = true;
    lastUserSpeechAt = Date.now();
    if (speakingMarked) return;
    speakingMarked = true;
    speakingMarkedAt = Date.now();
    ensureUtteranceSerial();
    if (!realtimeHelper || realtimeHelper.active?.utteranceId !== utteranceId) {
      realtimeHelper = beginRealtimeUtterance(userId, {
        utteranceId,
        utteranceSerial,
        sessionEpoch,
        timeline,
        startedDuringBotPlayback: overlappedBotPlayback,
      });
    }
    if (!timeline.discordReceiveStartAt) timeline.discordReceiveStartAt = lastUserSpeechAt;
    mirrorRuntimeLog('RX', `u=${shortUtteranceId(utteranceId)} speaking.start overlap=${overlappedBotPlayback ? 1 : 0}`);
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
    try { decoder?.destroy(); } catch {}
    try { resampler?.stdin?.end(); } catch {}
    const processToKill = resampler;
    setTimeout(() => {
      try { if (processToKill && !processToKill.killed) processToKill.kill('SIGKILL'); } catch {}
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
      if (sessionEpoch === voiceEpoch && connection && isUserInConnectedVoiceChannel(userId)) {
        startReceiverSession(userId, false);
      }
    });

    const realtimeActive = realtimeHelper?.active?.utteranceId === utteranceId ? realtimeHelper.active : null;
    const realtimeTranscript = realtimeActive ? String(realtimeActive.latestRealtimeTranscript || '') : '';
    const realtimeConfidence = realtimeActive && Number.isFinite(Number(realtimeActive.latestRealtimeConfidence))
      ? Number(realtimeActive.latestRealtimeConfidence) : null;
    const realtimeWords = realtimeActive && Array.isArray(realtimeActive.realtimeWords) ? realtimeActive.realtimeWords.slice(0,120) : [];

    // Start the acknowledgement immediately at end-of-utterance from the
    // realtime transcript. Whisper remains authoritative for the actual turn.
    // Keeping helper.active until after this call prevents the cue from being
    // lost simply because Nova did not emit speech_final/UtteranceEnd.
    if (realtimeActive && realtimeTranscript) {
      triggerEndOfUtteranceReaction(realtimeHelper, realtimeTranscript);
    }
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
      pcmChunkCount,
      maxPcmGapMs,
      maxRms: Number(maxRms.toFixed(5)),
      maxPeak: Number(maxPeak.toFixed(5)),
      avgRms: Number((pcmChunkCount ? rmsSum / pcmChunkCount : 0).toFixed(5)),
      opusChunkCount,
      maxOpusGapMs,
      speakingToFirstOpusMs: speakingMarkedAt && firstOpusAt ? Math.max(0, firstOpusAt - speakingMarkedAt) : null,
      speakingToFirstPcmMs: speakingMarkedAt && timeline.firstPcmAt ? Math.max(0, timeline.firstPcmAt - speakingMarkedAt) : null,
      opusToFirstPcmMs: firstOpusAt && timeline.firstPcmAt ? Math.max(0, timeline.firstPcmAt - firstOpusAt) : null,
    };
    console.log(`[capture] finalized utterance=${utteranceId} reason=${reason} duration=${captureMetrics.durationMs}ms pcm=${pcm.length}B pcmChunks=${pcmChunkCount} opusChunks=${opusChunkCount} pcmGap=${maxPcmGapMs}ms opusGap=${maxOpusGapMs}ms speakToOpus=${captureMetrics.speakingToFirstOpusMs ?? '?'}ms speakToPcm=${captureMetrics.speakingToFirstPcmMs ?? '?'}ms rmsMax=${captureMetrics.maxRms} peakMax=${captureMetrics.maxPeak} transport-gated=true botOverlap=${overlappedBotPlayback}`);
    mirrorRuntimeLog('CAPTURE', `u=${shortUtteranceId(utteranceId)} ${captureMetrics.durationMs}ms ${reason} op=${opusChunkCount}/gap${maxOpusGapMs} pcm=${pcmChunkCount}/gap${maxPcmGapMs} start=${captureMetrics.speakingToFirstPcmMs ?? '?'} rms=${captureMetrics.maxRms} rt="${realtimeTranscript || '-'}"`);
    await handleCapturedUtterance({
      pcm,
      userId,
      sessionEpoch,
      utteranceId,
      timeline,
      captureMetrics,
    });
  };

  const cancel = (reason = 'cancelled') => {
    if (completed) return;
    completed = true;
    cleanup();
    if (realtimeHelper?.active?.utteranceId === utteranceId) {
      realtimeHelper.reactionSeq += 1;
      realtimeHelper.active = null;
      realtimeHelper.finalParts = [];
      realtimeHelper.interim = '';
    }
    mirrorRuntimeLog('CAPTURE', `cancelled utterance=${utteranceId} user=${userId} reason=${reason}`);
  };

  session = { opus, decoder: null, resampler: null, markSpeaking, finalize, cancel };
  sessions.set(userId, session);
  if (speakingNow) markSpeaking(Boolean(options?.startedDuringBotPlayback));

  finalizeTimer = setInterval(() => {
    if (completed || !lastPcmAt || pcm16Bytes === 0) return;
    if (Date.now() - lastPcmAt >= DISCORD_SEGMENT_SILENCE_MS) {
      finalize('discord-pcm-silence').catch(() => {});
    }
  }, 25);

  const handlePcm16 = (pcm16) => {
    if (!pcm16?.length || completed) return;
    const at = Date.now();
    const previousPcmAt = lastPcmAt;
    if (previousPcmAt) maxPcmGapMs = Math.max(maxPcmGapMs, at - previousPcmAt);
    const level = pcm16Level(pcm16);
    pcmChunkCount += 1;
    maxRms = Math.max(maxRms, level.rms);
    maxPeak = Math.max(maxPeak, level.peak);
    rmsSum += level.rms;
    lastUserPcmAt = at;
    if (!timeline.firstPcmAt) {
      timeline.firstPcmAt = at;
      mirrorRuntimeLog('RX', `u=${shortUtteranceId(utteranceId)} firstPCM speak=${speakingMarkedAt ? at - speakingMarkedAt : '?'}ms opus=${firstOpusAt ? at - firstOpusAt : '?'}ms`);
    }
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
  };

  const ensureDecodePipeline = () => {
    if (decoder && resampler) return true;
    if (completed) return false;
    try {
      decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      resampler = createWebCompatibleResampler();
      if (session) {
        session.decoder = decoder;
        session.resampler = resampler;
      }

      decoder.pipe(resampler.stdin);
      resampler.stdout.on('data', handlePcm16);

      resampler.stdout.on('error', (error) => {
        console.error('[resample]', error.message);
        mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} resampler-output ${error.message}`);
        finalize('resampler-output-error').catch(() => {});
      });
      resampler.stdin.on('error', (error) => {
        if (completed) return;
        console.error('[resample]', error.message);
        mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} resampler-input ${error.message}`);
        finalize('resampler-input-error').catch(() => {});
      });
      resampler.on('error', (error) => {
        console.error('[resample]', error.message);
        mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} resampler-process ${error.message}`);
        finalize('resampler-process-error').catch(() => {});
      });
      decoder.on('error', (error) => {
        console.error('[decode]', error.message);
        mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} decoder ${error.message}`);
        finalize('decoder-error').catch(() => {});
      });
      mirrorRuntimeLog('CAPTURE', `u=${shortUtteranceId(utteranceId)} decode pipeline activated`);
      return true;
    } catch (error) {
      mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} pipeline-create ${String(error?.message || error).slice(0, 160)}`);
      finalize('decode-pipeline-create-error').catch(() => {});
      return false;
    }
  };

  opus.on('data', (opusChunk) => {
    const at = Date.now();
    if (!speakingMarked) {
      const botAudiblySpeaking = Boolean(activeBotPlaybackRecord) || player.state.status === AudioPlayerStatus.Playing;
      const inferredOverlap = botAudiblySpeaking || (Date.now() - lastBotPlaybackEndedAt < 1200);
      mirrorRuntimeLog('RX', `u=${shortUtteranceId(utteranceId)} speaking inferred from first Opus packet`);
      markSpeaking(inferredOverlap);
    }
    if (!firstOpusAt) firstOpusAt = at;
    if (lastOpusAt) maxOpusGapMs = Math.max(maxOpusGapMs, at - lastOpusAt);
    lastOpusAt = at;
    opusChunkCount += 1;

    if (!ensureDecodePipeline() || completed || !decoder || decoder.destroyed) return;
    try {
      const writable = decoder.write(opusChunk);
      if (!writable) {
        opus.pause();
        decoder.once('drain', () => {
          if (!completed && !opus.destroyed) opus.resume();
        });
      }
    } catch (error) {
      mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} decoder-write ${String(error?.message || error).slice(0, 160)}`);
      finalize('decoder-write-error').catch(() => {});
    }
  });

  opus.on('error', (error) => {
    console.error('[opus]', error.message);
    mirrorRuntimeLog('RX-ERROR', `u=${shortUtteranceId(utteranceId)} opus ${error.message}`);
    finalize('opus-error').catch(() => {});
  });
  opus.on('end', () => {
    try { if (decoder && !decoder.writableEnded) decoder.end(); } catch {}
    finalize('discord-transport-end').catch(() => {});
  });

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
  terminateAllManagedChildren('voice-destroy');
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

  const existing = connection;
  const sameTarget = existing
    && existing.state.status !== VoiceConnectionStatus.Destroyed
    && String(existing.joinConfig?.guildId || '') === String(channel.guild.id)
    && String(existing.joinConfig?.channelId || '') === String(channel.id);
  if (sameTarget) {
    if (existing.state.status === VoiceConnectionStatus.Ready) {
      existing.subscribe(player);
      if (initialUserId && initialUserId !== client.user.id) {
        ensureRealtimeHelper(initialUserId);
        startReceiverSession(initialUserId, false);
      }
      mirrorRuntimeLog('VOICE', `reuse ready channel=${channel.name}`);
      return channel;
    }
    if ([VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting].includes(existing.state.status)) {
      await entersState(existing, VoiceConnectionStatus.Ready, 15000);
      existing.subscribe(player);
      mirrorRuntimeLog('VOICE', `reuse recovered channel=${channel.name}`);
      return channel;
    }
  }

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

  prearmVoiceChannelMembers(channel);
  if (initialUserId && initialUserId !== client.user.id) {
    ensureRealtimeHelper(initialUserId);
    startReceiverSession(initialUserId, false);
  }

  const boundConnection = connection;
  boundConnection.on('stateChange', (oldState, newState) => {
    if (boundConnection !== connection) return;
    const reason = String(newState?.reason || '');
    const closeCode = Number.isFinite(Number(newState?.closeCode)) ? Number(newState.closeCode) : '';
    console.log(`[discord] voice state=${oldState?.status || '?'}->${newState.status} reason=${reason || '-'} closeCode=${closeCode || '-'}`);
    mirrorRuntimeLog('VOICE-STATE', `${oldState?.status || '?'}->${newState.status} reason=${reason || '-'} close=${closeCode || '-'}`);
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

    // @discordjs/voice already handles resumable/reconnectable disconnects.
    // Give that state machine a short window to enter Signalling/Connecting
    // before attempting any manual rejoin.
    voiceRecoveryTimer = setTimeout(async () => {
      voiceRecoveryTimer = null;
      if (boundConnection !== connection || boundConnection.state.status === VoiceConnectionStatus.Destroyed) return;
      if (boundConnection.state.status === VoiceConnectionStatus.Ready) {
        boundConnection.subscribe(player);
        voiceRecoveryAttempts = 0;
        return;
      }
      try {
        await Promise.race([
          entersState(boundConnection, VoiceConnectionStatus.Signalling, 5000),
          entersState(boundConnection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        console.warn('[discord] voice auto-recovery in progress; manual rejoin skipped');
        mirrorRuntimeLog('VOICE-RECOVER', 'library auto-recovery detected');
        return;
      } catch {
        if (boundConnection.state.status === VoiceConnectionStatus.Ready) {
          boundConnection.subscribe(player);
          voiceRecoveryAttempts = 0;
          return;
        }
      }

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (boundConnection !== connection || boundConnection.state.status === VoiceConnectionStatus.Destroyed) return;
        voiceRecoveryAttempts = attempt;
        try {
          const accepted = boundConnection.rejoin();
          if (!accepted) throw new Error('voice_rejoin_rejected');
          await entersState(boundConnection, VoiceConnectionStatus.Ready, VOICE_REJOIN_TIMEOUT_MS);
          if (boundConnection === connection) {
            boundConnection.subscribe(player);
            voiceRecoveryAttempts = 0;
            console.log(`[discord] voice manual rejoin recovered attempt=${attempt}`);
            mirrorRuntimeLog('VOICE-RECOVER', `manual rejoin recovered attempt=${attempt}`);
          }
          return;
        } catch (error) {
          console.error(`[discord] voice manual rejoin failed attempt=${attempt}:`, error?.message || error);
          mirrorRuntimeLog('VOICE-RECOVER', `manual rejoin failed attempt=${attempt}: ${String(error?.message || error).slice(0, 160)}`);
          if (attempt < 3) {
            const delayMs = 500 * (2 ** (attempt - 1));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
      if (boundConnection === connection) {
        console.error('[discord] voice recovery exhausted; destroying stale voice connection');
        mirrorRuntimeLog('VOICE-RECOVER', 'exhausted; stale voice connection destroyed');
        destroyVoiceConnection();
      }
    }, 250);
    console.warn('[discord] voice disconnected; waiting for library auto-recovery');
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
  const existing = await withPromiseDeadline(guild.commands.fetch(), DISCORD_REST_DEADLINE_MS, 'guild-commands-fetch');
  for (const data of TALKSYS_COMMANDS) {
    const command = existing.find((item) => item.name === data.name);
    if (command) await withPromiseDeadline(guild.commands.edit(command.id, data), DISCORD_REST_DEADLINE_MS, 'guild-command-edit');
    else await withPromiseDeadline(guild.commands.create(data), DISCORD_REST_DEADLINE_MS, 'guild-command-create');
  }
}

client.once('ready', async () => {
  if (discordReadyWatchdog) {
    clearTimeout(discordReadyWatchdog);
    discordReadyWatchdog = null;
  }
  if (discordHealthTimer) clearInterval(discordHealthTimer);
  if (bridgeHeartbeatTimer) clearInterval(bridgeHeartbeatTimer);
  writeBridgeHeartbeat();
  bridgeHeartbeatTimer = setInterval(writeBridgeHeartbeat, BRIDGE_HEARTBEAT_MS);
  discordHealthTimer = setInterval(() => {
    console.log(`[discord] gateway health ready=${client.isReady()} ping=${client.ws.ping}ms guilds=${client.guilds.cache.size}`);
    const stageAge = activePipelineStageAt ? Date.now() - activePipelineStageAt : 0;
    if (runtimeLogChannel) mirrorRuntimeLog('HEALTH', `gateway=${client.isReady()} ping=${client.ws.ping}ms vc=${connection?.state?.status || '-'} rx=${sessions.size} rt=${realtimeHelpers.size} answering=${answering ? 1 : 0} player=${player.state.status} stage=${activePipelineStage} age=${stageAge}ms u=${shortUtteranceId(activePipelineUtteranceId)}`);
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
    if (process.platform !== 'win32') {
      warmRecoveryAudio().catch((error) => console.warn('[recovery] gateway warmup failed:', error?.message || error));
    } else {
      mirrorRuntimeLog('READY', 'Windows recovery TTS warmup deferred to avoid foreground queue contention');
    }
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
    await withPromiseDeadline(interaction.deferReply({ ephemeral: true }), 2500, 'interaction-defer');
    console.log(`[interaction] acked command=/${interaction.commandName}`);
  } catch (error) {
    console.error(`[interaction] ack failed command=/${interaction.commandName}:`, error?.stack || error);
    return;
  }

  try {
    if (interaction.commandName === 'logs') {
      const attached = await attachRuntimeLogChannel(interaction.channel);
      await withPromiseDeadline(interaction.editReply(attached
        ? 'TalkSysのライブログをこのチャンネルに表示します。'
        : 'このチャンネルにはライブログを表示できません。'), DISCORD_REST_DEADLINE_MS, 'interaction-edit');
      return;
    }

    if (interaction.commandName === 'talksys') {
      await attachRuntimeLogChannel(interaction.channel);
      mirrorRuntimeLog('CMD', `/talksys by ${interaction.user.tag || interaction.user.id}`);
      const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);
      const channelId = voiceState?.channelId;
      if (!channelId) {
        await withPromiseDeadline(interaction.editReply('先にボイスチャンネルへ参加してから /talksys を実行してください。'), DISCORD_REST_DEADLINE_MS, 'interaction-edit');
        return;
      }
      const channel = await withPromiseDeadline(interaction.guild.channels.fetch(channelId), DISCORD_REST_DEADLINE_MS, 'voice-channel-fetch');
      await connectToVoiceChannel(channel, interaction.user.id);
      await withPromiseDeadline(interaction.editReply(`TalkSysを「${channel.name}」へ接続しました。`), DISCORD_REST_DEADLINE_MS, 'interaction-edit');
      return;
    }

    mirrorRuntimeLog('CMD', '/leave');
    destroyVoiceConnection();
    await withPromiseDeadline(interaction.editReply('TalkSysをボイスチャンネルから退出させました。'), DISCORD_REST_DEADLINE_MS, 'interaction-edit');
  } catch (error) {
    console.error('[command]', error?.stack || error);
    try {
      await withPromiseDeadline(interaction.editReply(`TalkSysのVC操作に失敗しました: ${String(error?.message || error).slice(0, 180)}`), DISCORD_REST_DEADLINE_MS, 'interaction-edit');
    } catch (replyError) {
      console.error('[command] failure reply failed:', replyError?.message || replyError);
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!connection) return;
  const targetGuildId = String(connection?.joinConfig?.guildId || '');
  const targetChannelId = String(connection?.joinConfig?.channelId || '');
  const userId = String(newState?.id || oldState?.id || '');
  if (!userId || userId === client.user?.id) return;
  if (String(newState?.guild?.id || oldState?.guild?.id || '') !== targetGuildId) return;

  const wasTarget = String(oldState?.channelId || '') === targetChannelId;
  const isTarget = String(newState?.channelId || '') === targetChannelId;
  if (!wasTarget && isTarget && !newState?.member?.user?.bot) {
    ensureRealtimeHelper(userId);
    startReceiverSession(userId, false);
    mirrorRuntimeLog('VOICE-MEMBER', `joined/prearmed user=${userId}`);
  } else if (wasTarget && !isTarget) {
    stopReceiverSession(userId, 'voice-state-left');
    mirrorRuntimeLog('VOICE-MEMBER', `left/released user=${userId}`);
  }
});

client.on('error', (error) => console.error('[discord]', error));
client.on('warn', (info) => console.warn('[discord] warning:', info));
client.on('shardReady', (shardId, unavailableGuilds) => {
  console.log(`[discord] shard ready id=${shardId} unavailableGuilds=${unavailableGuilds?.size ?? 0}`);
  mirrorRuntimeLog('GATEWAY', `shard ready id=${shardId} unavailable=${unavailableGuilds?.size ?? 0}`);
});
client.on('shardError', (error, shardId) => {
  console.error(`[discord] shard error id=${shardId}:`, error?.stack || error);
  mirrorRuntimeLog('GATEWAY', `shard error id=${shardId}: ${String(error?.message || error).slice(0, 180)}`);
});
client.on('shardDisconnect', (event, shardId) => {
  console.error(`[discord] shard disconnected id=${shardId} code=${event?.code ?? 'unknown'}`);
  mirrorRuntimeLog('GATEWAY', `shard disconnected id=${shardId} code=${event?.code ?? 'unknown'}`);
});
client.on('shardReconnecting', (shardId) => {
  console.warn(`[discord] shard reconnecting id=${shardId}`);
  mirrorRuntimeLog('GATEWAY', `shard reconnecting id=${shardId}`);
});
client.on('shardResume', (shardId, replayedEvents) => {
  console.log(`[discord] shard resumed id=${shardId} replayed=${replayedEvents}`);
  mirrorRuntimeLog('GATEWAY', `shard resumed id=${shardId} replayed=${replayedEvents}`);
});
player.on('error', (error) => { console.error('[player]', error.message); mirrorRuntimeLog('ERROR', `player: ${error.message}`); });

function requestBridgeShutdown(reason = 'requested', exitCode = 124) {
  if (bridgeShuttingDown) return;
  bridgeShuttingDown = true;
  mirrorRuntimeLog('SHUTDOWN', `reason=${reason} code=${exitCode}`);
  if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
  if (discordHealthTimer) clearInterval(discordHealthTimer);
  if (bridgeHeartbeatTimer) clearInterval(bridgeHeartbeatTimer);
  if (bridgeShutdownPollTimer) clearInterval(bridgeShutdownPollTimer);
  try { destroyVoiceConnection(); } catch {}
  try { terminateAllManagedChildren(`shutdown-${reason}`); } catch {}
  try { client.destroy(); } catch {}
  if (BRIDGE_SHUTDOWN_FILE) fs.promises.unlink(BRIDGE_SHUTDOWN_FILE).catch(() => {});
  setTimeout(() => process.exit(exitCode), 100).unref();
}

function pollBridgeShutdownRequest() {
  if (!BRIDGE_SHUTDOWN_FILE || bridgeShutdownPollInFlight || bridgeShuttingDown) return;
  bridgeShutdownPollInFlight = true;
  fs.promises.readFile(BRIDGE_SHUTDOWN_FILE, {
    encoding: 'utf8',
    signal: AbortSignal.timeout(400),
  })
    .then((value) => {
      const reason = String(value || 'supervisor-request').trim().slice(0, 120) || 'supervisor-request';
      requestBridgeShutdown(reason, 124);
    })
    .catch((error) => {
      if (error?.code !== 'ENOENT' && error?.name !== 'AbortError' && error?.name !== 'TimeoutError') {
        console.warn('[shutdown] poll failed:', error?.message || error);
      }
    })
    .finally(() => { bridgeShutdownPollInFlight = false; });
}

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason?.stack || reason);
  mirrorRuntimeLog('ERROR', `unhandled: ${reason?.message || reason}`);
});

process.on('uncaughtException', (error) => {
  console.error('[process] uncaught exception:', error?.stack || error);
  mirrorRuntimeLog('ERROR', `uncaught: ${error?.message || error}`);
  requestBridgeShutdown('uncaught-exception', 3);
});

process.on('SIGINT', () => requestBridgeShutdown('sigint', 0));
process.on('SIGTERM', () => requestBridgeShutdown('sigterm', 0));

discordReadyWatchdog = setTimeout(() => {
  if (client.isReady()) return;
  console.error(`[fatal] Discord Gateway did not reach Ready within ${DISCORD_READY_TIMEOUT_MS}ms status=${client.ws.status} ping=${client.ws.ping} guilds=${client.guilds.cache.size}`);
  client.destroy();
  process.exit(2);
}, DISCORD_READY_TIMEOUT_MS);

mirrorRuntimeLog('BOOT', `process start node=${process.version}`);
mirrorRuntimeLog('BOOT', `bridge=${DISCORD_BRIDGE_REVISION}`);
if (BRIDGE_SHUTDOWN_FILE) {
  bridgeShutdownPollTimer = setInterval(pollBridgeShutdownRequest, BRIDGE_SHUTDOWN_POLL_MS);
  pollBridgeShutdownRequest();
}
// Keep startup free of semantic warmup. The shared Worker decides reactions.
// This also avoids blocking Gateway login on local TTS work.
await warmFastReactionAudio();

client.login(DISCORD_TOKEN).catch((error) => {
  if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
  console.error('[fatal] Discord login failed:', error?.stack || error);
  client.destroy();
  process.exit(2);
});
