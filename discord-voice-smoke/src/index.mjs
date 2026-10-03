import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder, Client, GatewayIntentBits } from 'discord.js';
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
import { fastReaction, sameUtterance, classifyVoiceTurn } from '../../src/voice-fast-reaction.js';
import { arbitrateSuccessfulTranscript, classifySttFailure, rescueFailedWhisper } from '../../src/voice-transcript-arbiter.js';

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
const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5';
const DISCORD_STABILITY_PATCH_REVISION = 'talksys-r5-stability-coordinator-p1';
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
let runtimeLogFlushTimer = null;
let runtimeLogFlushBusy = false;
const runtimeLogLines = [];
const discordLogQueue = [];
const discordLogStateDir = path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'TalkSys');
const discordLogChannelFile = path.join(discordLogStateDir, 'discord-log-channel.txt');
const discordLogOwnerFile = path.join(discordLogStateDir, 'discord-log-owner.txt');
const discordLogFile = path.join(discordLogStateDir, 'discord-runtime.log');
const discordLogPreviousFile = path.join(discordLogStateDir, 'discord-runtime.previous.log');
const DISK_LOG_MAX_BYTES = 5 * 1024 * 1024;
const diskLogQueue = [];
let diskLogFlushTimer = null;
let diskLogFlushBusy = false;
let diskLogWriteFailures = 0;
let discordLogSendFailCount = 0;
let consoleMirrorInstalled = false;
let activeBotPlaybackRecord = null;
let lastBotPlaybackEndedAt = 0;
let lastUserSpeechAt = 0;
let lastUserPcmAt = 0;
let recoveryAudio = null;
let recoveryAudioPromise = null;
let recoverySpeaking = false;
let voiceRecoveryTimer = null;
let voiceStallTimer = null;
let voiceRecoveryInFlight = false;
let voiceRecoveryAttempts = 0;
let discordReadyWatchdog = null;
let discordHealthTimer = null;
let lastHealthLogSignature = '';
let desiredVoiceTarget = null;
let fullReconnectTimer = null;
let fullReconnectInFlight = false;
let consecutivePipelineFailures = 0;
const bridgeHeartbeatFile = process.env.TALKSYS_BRIDGE_HEARTBEAT_FILE || '';
const bridgeShutdownFile = process.env.TALKSYS_BRIDGE_SHUTDOWN_FILE || '';
const activeWatchStages = new Map();
let bridgeHeartbeatTimer = null;
let bridgeShutdownTimer = null;
let bridgeShuttingDown = false;

function beginWatchStage(id, stage, deadlineMs) {
  activeWatchStages.set(String(id), { stage, at: Date.now(), deadlineMs });
}
function endWatchStage(id) {
  activeWatchStages.delete(String(id));
}
function writeBridgeHeartbeat() {
  if (!bridgeHeartbeatFile) return;
  const pending = [...activeWatchStages.values()].sort((a, b) => a.at - b.at);
  const stage = pending[0];
  try {
    fs.writeFileSync(bridgeHeartbeatFile, JSON.stringify({
      at: Date.now(),
      stage: stage?.stage || 'idle',
      stageAt: stage?.at || Date.now(),
      stageBlocking: Boolean(stage),
      stageDeadlineMs: stage?.deadlineMs || 0,
      voice: connection?.state?.status || 'none',
      player: player.state.status,
      captures: sessions.size,
      answering,
      queued: pendingTurns.length,
      activeUtterance: activeUserUtteranceId || '',
      logPending: discordLogQueue.length,
      revision: DISCORD_BRIDGE_REVISION,
      stabilityPatch: DISCORD_STABILITY_PATCH_REVISION,
    }));
  } catch (error) {
    process.stderr.write('[heartbeat] write failed: ' + String(error?.message || error) + '\n');
  }
}
function flushPendingLogsOnExit() {
  if (!diskLogQueue.length) return;
  try {
    fs.mkdirSync(discordLogStateDir, { recursive: true });
    fs.appendFileSync(discordLogFile, diskLogQueue.splice(0).join('\n') + '\n');
  } catch {}
}
function startBridgeMonitors() {
  writeBridgeHeartbeat();
  bridgeHeartbeatTimer = setInterval(writeBridgeHeartbeat, 2500);
  bridgeHeartbeatTimer.unref?.();
  if (!bridgeShutdownFile) return;
  bridgeShutdownTimer = setInterval(() => {
    if (bridgeShuttingDown || !fs.existsSync(bridgeShutdownFile)) return;
    bridgeShuttingDown = true;
    let reason = 'supervisor-request';
    try { reason = fs.readFileSync(bridgeShutdownFile, 'utf8').trim() || reason; } catch {}
    mirrorRuntimeLog('SUPERVISOR', 'graceful shutdown: ' + reason);
    if (bridgeHeartbeatTimer) clearInterval(bridgeHeartbeatTimer);
    if (bridgeShutdownTimer) clearInterval(bridgeShutdownTimer);
    destroyVoiceConnection();
    client.destroy();
    flushPendingLogsOnExit();
    process.exit(0);
  }, 250);
  bridgeShutdownTimer.unref?.();
}

function resetConversationState() {
  if (voiceRecoveryTimer) {
    clearTimeout(voiceRecoveryTimer);
    voiceRecoveryTimer = null;
  }
  if (voiceStallTimer) {
    clearTimeout(voiceStallTimer);
    voiceStallTimer = null;
  }
  voiceRecoveryInFlight = false;
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

function rescueBargeInTranscriptFromRealtime(confirmedText, captureMetrics = {}, timeline = {}) {
  if (!captureMetrics?.overlappedBotPlayback) return '';
  const confirmed = String(confirmedText || '').trim();
  const realtime = String(captureMetrics?.realtimeTranscript || '').trim();
  if (!confirmed || !realtime || sameUtterance(confirmed, realtime)) return '';
  const bargeTriggered = Number(captureMetrics?.bargeInTriggerMs || timeline?.bargeInTriggerMs || 0) > 0;
  if (!bargeTriggered) return '';
  if (normalizeSttToken(confirmed).length > BOT_OVERLAP_SHORT_TEXT_MAX) return '';
  if (normalizeSttToken(realtime).length < 6) return '';
  if (looksLikeRecentBotEcho(realtime, timeline)) return '';
  const realtimePolicy = classifyVoiceTurn(realtime, { answerInFlight: false });
  if (realtimePolicy.action !== 'answer') return '';
  return realtime;
}

function sanitizeLogText(value = '') {
  return String(value || '')
    .replace(/("?(?:token|authorization|discord_token|discord_bridge_token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[redacted]$3')
    .replace(/(Bot\s+)[A-Za-z0-9._-]{20,}/g, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[redacted]')
    .replace(/(["']?(?:token|authorization|api_key|api-key|secret|password)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/`/g, 'ˋ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function persistRuntimeLogChannelId(channelId = '') {
  const value = String(channelId || '').trim();
  if (!value) return false;
  try {
    fs.mkdirSync(discordLogStateDir, { recursive: true });
    fs.writeFileSync(discordLogChannelFile, value, 'utf8');
    return true;
  } catch (error) {
    console.warn('[discord-log] failed to persist log channel:', error?.message || error);
    return false;
  }
}

function persistRuntimeLogOwnerId(userId = '') {
  try {
    const id = String(userId || '').trim();
    if (!id) return false;
    fs.mkdirSync(discordLogStateDir, { recursive: true });
    fs.writeFileSync(discordLogOwnerFile, id, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readPersistedRuntimeLogOwnerId() {
  try {
    return fs.readFileSync(discordLogOwnerFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function flushRuntimeLogsToDisk() {
  if (diskLogFlushBusy) return;
  if (!diskLogQueue.length) return;
  diskLogFlushBusy = true;
  const lines = diskLogQueue.splice(0, 300);
  try {
    await fs.promises.mkdir(discordLogStateDir, { recursive: true });
    const stat = await fs.promises.stat(discordLogFile).catch(() => null);
    if (stat && stat.size >= DISK_LOG_MAX_BYTES) {
      await fs.promises.rm(discordLogPreviousFile, { force: true });
      await fs.promises.rename(discordLogFile, discordLogPreviousFile);
    }
    await fs.promises.appendFile(discordLogFile, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    diskLogWriteFailures = 0;
  } catch (error) {
    diskLogWriteFailures += 1;
    diskLogQueue.unshift(...lines);
    if (diskLogWriteFailures <= 3 || diskLogWriteFailures % 25 === 0) {
      process.stderr.write('[discord-log] disk write failed: ' + String(error?.message || error) + '\n');
    }
  } finally {
    diskLogFlushBusy = false;
    if (diskLogQueue.length) {
      const backoff = diskLogWriteFailures
        ? Math.min(60_000, 300 * (2 ** Math.min(diskLogWriteFailures, 8)))
        : 300;
      scheduleDiskLogFlush(backoff);
    }
  }
}

function scheduleDiskLogFlush(delayMs = 300) {
  if (diskLogFlushTimer || diskLogFlushBusy || !diskLogQueue.length) return;
  diskLogFlushTimer = setTimeout(() => {
    diskLogFlushTimer = null;
    flushRuntimeLogsToDisk().catch(() => {});
  }, delayMs);
}

async function exportRuntimeLogs() {
  if (diskLogFlushTimer) clearTimeout(diskLogFlushTimer);
  diskLogFlushTimer = null;
  for (let i = 0; i < 20 && diskLogQueue.length; i += 1) {
    if (diskLogFlushBusy) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      continue;
    }
    await flushRuntimeLogsToDisk();
  }
  const chunks = [];
  for (const filename of [discordLogPreviousFile, discordLogFile]) {
    try { chunks.push(await fs.promises.readFile(filename)); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  let all = Buffer.concat(chunks);
  if (all.length > 7_000_000) {
    all = Buffer.concat([Buffer.from('[Older runtime log truncated for Discord upload]\n'), all.subarray(all.length - 6_900_000)]);
  }
  return all.length ? all : Buffer.from('No TalkSys runtime logs were available.\n');
}

function readPersistedRuntimeLogChannelId() {
  try {
    return fs.existsSync(discordLogChannelFile) ? fs.readFileSync(discordLogChannelFile, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function nextDiscordLogBatch() {
  if (!discordLogQueue.length) return { body: '', count: 0 };
  const lines = [];
  let chars = 0;
  for (const line of discordLogQueue) {
    if (lines.length && chars + line.length + 1 > 1500) break;
    lines.push(line.slice(0, 1500));
    chars += line.length + 1;
    if (lines.length >= 10) break;
  }
  return { body: lines.join('\n'), count: lines.length };
}

async function flushRuntimeLogQueue() {
  if (!runtimeLogChannel || runtimeLogFlushBusy || !discordLogQueue.length) return;
  runtimeLogFlushBusy = true;
  try {
    // Only one Discord API call per flush; persist everything to disk separately.
    const batch = nextDiscordLogBatch();
    if (!batch.count) return;
    await runtimeLogChannel.send(`**TalkSys Discord runtime** · ${DISCORD_BRIDGE_REVISION}\n\`\`\`text\n${batch.body}\n\`\`\``);
    discordLogQueue.splice(0, batch.count);
    discordLogSendFailCount = 0;
  } catch (error) {
    discordLogSendFailCount += 1;
    mirrorRuntimeLog('LOG-ERROR', 'Discord log send failed code='
      + String(error?.code || error?.status || 'unknown')
      + ' retry=' + discordLogSendFailCount);
  } finally {
    runtimeLogFlushBusy = false;
    if (runtimeLogChannel && discordLogQueue.length) {
      const delay = discordLogSendFailCount
        ? Math.min(60_000, 1000 * (2 ** Math.min(discordLogSendFailCount, 6)))
        : 1500;
      scheduleRuntimeLogFlush(delay);
    }
  }
}

function scheduleRuntimeLogFlush(delayMs = 1500) {
  if (!runtimeLogChannel || runtimeLogFlushTimer || runtimeLogFlushBusy || !discordLogQueue.length) return;
  runtimeLogFlushTimer = setTimeout(() => {
    runtimeLogFlushTimer = null;
    flushRuntimeLogQueue().catch(() => {});
  }, delayMs);
}

function mirrorRuntimeLog(kind, message) {
  const value = sanitizeLogText(message).slice(0, 24000);
  if (!value) return;
  const stamp = new Date().toISOString();
  for (let i = 0; i < value.length; i += 1100) {
    const line = `${stamp} [${kind}${i ? '-CONT' : ''}] ${value.slice(i, i + 1100)}`;
    runtimeLogLines.push(line);
    if (runtimeLogLines.length > 300) runtimeLogLines.splice(0, runtimeLogLines.length - 300);
    diskLogQueue.push(line);
    discordLogQueue.push(line);
  }
  if (discordLogQueue.length > 2000) {
    discordLogQueue.splice(0, discordLogQueue.length - 1999);
    discordLogQueue.unshift('[LOG] Discord backlog exceeded 2000 lines; full retained logs in /logdump');
  }
  scheduleDiskLogFlush();
  scheduleRuntimeLogFlush();
}

function installConsoleMirror() {
  if (consoleMirrorInstalled) return;
  consoleMirrorInstalled = true;
  const format = (args) => sanitizeLogText(args.map((item) => {
    if (item instanceof Error) return item.stack || item.message;
    if (typeof item === 'string') return item;
    try { return JSON.stringify(item); } catch { return String(item); }
  }).join(' '));
  for (const [method, kind] of [['log', 'RAW'], ['info', 'RAW'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      const value = format(args);
      if (!value || value.startsWith('[discord-log]')) return;
      mirrorRuntimeLog(kind, value);
    };
  }
}

async function attachRuntimeLogChannel(channel, { persist = true } = {}) {
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;
  runtimeLogChannel = channel;
  if (persist) persistRuntimeLogChannelId(channel.id);
  mirrorRuntimeLog('LOG', `Discord log channel attached id=${channel.id}`);
  mirrorRuntimeLog('BOOT', `bridge=${DISCORD_BRIDGE_REVISION}`);
mirrorRuntimeLog('BOOT', `stabilityPatch=${DISCORD_STABILITY_PATCH_REVISION}`);
  mirrorRuntimeLog('BOOT', `TalkSys=${TALKSYS_BASE_URL}`);
  mirrorRuntimeLog('BOOT', `ttsPrimary=${process.platform === 'win32' ? 'windows-system-speech' : 'cloudflare-melotts'}`);
  scheduleRuntimeLogFlush();
  return true;
}

async function restoreRuntimeLogChannel() {
  const channelId = readPersistedRuntimeLogChannelId();
  if (!channelId) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    return attachRuntimeLogChannel(channel, { persist: false });
  } catch (error) {
    console.warn('[discord-log] persisted channel unavailable:', error?.message || error);
    return false;
  }
}

installConsoleMirror();

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

function triggerWebFastReaction(helper, text, source = 'realtime') {
  const active = helper?.active;
  const value = String(text || '').trim();
  if (!active || active.reactionIssued || !value || active.sessionEpoch !== voiceEpoch) return false;
  active.latestRealtimeTranscript = value;
  if (active.startedDuringBotPlayback && !active.bargeInTriggered) {
    console.log(`[fast-reaction] deferred bot-overlap utterance=${active.utteranceId}`);
    return false;
  }
  const reaction = fastReaction(value);
  if (!reaction?.shouldSpeak || !String(reaction?.text || '').trim()) return false;
  active.reactionIssued = true;
  active.reaction = reaction;
  helper.reactionSeq += 1;
  mirrorRuntimeLog('REACTION-CANDIDATE', `${source} ${reaction.kind}: ${value}`);
  playWebFastReaction(reaction, active.utteranceId, active.sessionEpoch, active.timeline, value);
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
    if (helper.active) helper.active.realtimeSpeechStartedAt = Date.now();
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
      if (text && helper.active) helper.active.latestRealtimeTranscript = text;
      helper.finalParts = [];
      helper.interim = '';
    }
    return;
  }
  if (/UtteranceEnd/i.test(type)) {
    const text = helper.finalParts.join(' ').trim() || helper.interim;
    if (text && helper.active) helper.active.latestRealtimeTranscript = text;
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
    realtimeSpeechStartedAt: 0,
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

function boundedSignal(parentSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

async function promiseWithTimeout(promise, timeoutMs, label = 'operation_timeout') {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithBudget(url, init = {}, { timeoutMs = 15000, label = 'request' } = {}) {
  const startedAt = Date.now();
  const signal = boundedSignal(init.signal, timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    const reason = signal.aborted ? String(signal.reason?.name || error?.name || 'aborted') : String(error?.name || 'network-error');
    const kind = init.signal?.aborted ? 'API-CANCEL' : 'API-ERROR';
    mirrorRuntimeLog(kind, `${label} reason=${reason} elapsed=${Date.now() - startedAt}ms limit=${timeoutMs}ms ${String(error?.message || error).slice(0, 160)}`);
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    mirrorRuntimeLog('API-ERROR', `${label} http=${response.status} elapsed=${Date.now() - startedAt}ms detail=${detail.slice(0, 300)}`);
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
  const clientElapsedMs = timeline.whisperCompleteAt - timeline.transcribeStartAt;
  const serverElapsedMs = Number(body?.elapsedMs) || 0;
  const retryUsed = Boolean(body?.retryUsed);
  console.log(`[stt] confirmed model=${body.model || 'unknown'} elapsed=${clientElapsedMs}ms server=${serverElapsedMs}ms retry=${retryUsed}: ${confirmedTranscript}`);
  mirrorRuntimeLog('STT', `Whisper ${clientElapsedMs}ms server=${serverElapsedMs}ms retry=${retryUsed}: ${confirmedTranscript}`);
  return {
    confirmedTranscript,
    fastReaction: body?.fastReaction || null,
    model: body?.model || '',
    serverElapsedMs,
    retryUsed,
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
    done,
    stop(reason = 'answer-ready') {
      if (stopped) return;
      stopped = true;
      try { controller.abort(reason); } catch {}
      if (playing) player.stop(true);
    },
  };
}

function commitConversationTurn(text, body) {
  if (!body?.answer) return false;
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
  mirrorRuntimeLog('CONTEXT-COMMIT', `utterance committed interaction=${body.interactionId || '-'} history=${history.length}`);
  return true;
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
  const elapsed = Date.now() - started;
  console.log('[turn] assistant:', body.answer);
  console.log(`[latency] turn-http=${elapsed}ms server-total=${body?.timings?.totalMs ?? '?'}ms primary=${body?.timings?.primaryMs ?? '?'}ms verifier=${body?.timings?.verifierMs ?? '?'}ms`);
  mirrorRuntimeLog('TURN', `total=${elapsed}ms primary=${body?.timings?.primaryMs ?? '?'} verifier=${body?.timings?.verifierMs ?? '?'}`);
  return body;
}

async function synthesizeWindowsJapaneseTts(text, signal) {
  if (process.platform !== 'win32') throw new Error('windows_tts_unavailable_non_windows');
  const spoken = String(text || '').trim();
  if (!spoken) throw new Error('windows_tts_empty_text');

  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TALKSYS_TTS_TEXT_B64))",
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$ja=@($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' })",
    "$pick=$null",
    "$best=-1",
    "foreach($v in $ja){$n=[string]$v.VoiceInfo.Name;$score=0;if($n -match 'Google.*(日本語|Japanese)'){$score=1000}elseif($n -match 'Nanami'){$score=820}elseif($n -match 'Haruka|Sayaka|Ichiro|Keita'){$score=760}elseif($n -match 'Microsoft'){$score=650}elseif($n -match 'Ayumi'){$score=420};if($score -gt $best){$best=$score;$pick=$v}}",
    "if($pick -ne $null){$s.SelectVoice([string]$pick.VoiceInfo.Name);[Console]::Error.WriteLine(('voice=' + [string]$pick.VoiceInfo.Name))}",
    "$m=New-Object IO.MemoryStream",
    "$s.SetOutputToWaveStream($m)",
    "$s.Speak($text)",
    "$s.Dispose()",
    "$bytes=$m.ToArray()",
    "$m.Dispose()",
    "if($bytes.Length -lt 44){throw 'windows_tts_empty_audio'}",
    "$o=[Console]::OpenStandardOutput()",
    "$o.Write($bytes,0,$bytes.Length)",
    "$o.Flush()"
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdout = [];
  let stderr = '';
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  let stopReason = '';
  let hardCloseTimer = null;
  let rejectHardClose = null;
  const hardClosePromise = new Promise((_, reject) => { rejectHardClose = reject; });
  const requestChildStop = (reason) => {
    if (!stopReason) stopReason = String(reason || 'stop');
    mirrorRuntimeLog('TTS-CHILD', `Windows TTS stop requested reason=${stopReason} pid=${child.pid || '-'}`);
    try { child.kill(); } catch {}
    if (!hardCloseTimer) {
      hardCloseTimer = setTimeout(() => {
        mirrorRuntimeLog('TTS-CHILD', `Windows TTS hard-close timeout reason=${stopReason} pid=${child.pid || '-'}`);
        rejectHardClose(new Error(`windows_tts_hard_close_timeout:${stopReason}`));
      }, 5000);
    }
  };

  const timeout = setTimeout(() => requestChildStop('tts-timeout-8000ms'), 8000);

  let abortHandler = null;
  if (signal) {
    abortHandler = () => requestChildStop('abort');
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }

  const childDone = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  const code = await Promise.race([childDone, hardClosePromise]).finally(() => {
    clearTimeout(timeout);
    if (hardCloseTimer) clearTimeout(hardCloseTimer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  });

  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const audio = Buffer.concat(stdout);
  if (code !== 0 || audio.length < 44) {
    throw new Error(`windows_tts_failed code=${code} detail=${stderr.trim().slice(0, 240)}`);
  }

  return {
    audio,
    source: 'windows-system-speech',
    elapsedMs: Date.now() - started,
    workerMs: 0,
  };
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
      if (signal?.aborted || localError?.name === 'AbortError' || /(?:^|\b)abort(?:ed)?(?:\b|$)/i.test(detail)) {
        mirrorRuntimeLog('TTS', 'Windows local cancelled; fallback suppressed');
        throw localError;
      }
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
  let cancelCompletionWait = () => {};
  const completionPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ffmpeg.kill('SIGKILL'); } catch {}
      player.stop(true);
      reject(new Error('playback_timeout'));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Idle, done);
      player.off('error', fail);
    };
    const finishRecord = () => {
      finishBotSpeech(botSpeechRecord);
      if (botSpeechRecord) lastBotPlaybackEndedAt = Date.now();
      if (activeBotPlaybackRecord === botSpeechRecord) activeBotPlaybackRecord = null;
    };
    const done = () => { cleanup(); finishRecord(); resolve(); };
    const fail = (error) => { cleanup(); finishRecord(); reject(error); };
    cancelCompletionWait = () => {
      cleanup();
      finishRecord();
      resolve();
    };
    player.once(AudioPlayerStatus.Idle, done);
    player.once('error', fail);
  });
  // A player error may arrive before playbackStartedPromise is awaited. Keep a
  // rejection observer attached so Node never treats that early rejection as
  // unhandled; the original promise still rejects when awaited below.
  completionPromise.catch(() => {});

  const playbackStartedPromise = new Promise((resolve, reject) => {
    const onPlayerErrorBeforeStart = (error) => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Playing, onPlaying);
      cancelCompletionWait();
      reject(error);
    };
    const timeout = setTimeout(() => {
      player.off(AudioPlayerStatus.Playing, onPlaying);
      player.off('error', onPlayerErrorBeforeStart);
      cancelCompletionWait();
      try { ffmpeg.kill('SIGKILL'); } catch {}
      player.stop(true);
      reject(new Error('playback_start_timeout'));
    }, 5000);
    const onPlaying = () => {
      clearTimeout(timeout);
      player.off('error', onPlayerErrorBeforeStart);
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
    player.once('error', onPlayerErrorBeforeStart);
  });

  player.play(resource);

  const watchId = `playback:${randomUUID()}`;
  beginWatchStage(watchId, 'playback', 40_000);
  try {
    const startedInfo = await playbackStartedPromise;
    await completionPromise;
    if (ffmpegError.trim()) console.log('[ffmpeg]', ffmpegError.trim());
    return startedInfo;
  } finally {
    endWatchStage(watchId);
  }
}

async function processConfirmedTranscript({ confirmedTranscript, rawTranscript = '', correctedTranscript = '', correctionReason = '', fastReaction: providedFastReaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta }) {
  if (!confirmedTranscript || sessionEpoch !== voiceEpoch) return;
  let reaction = providedFastReaction;

  const realtimeRescue = rescueBargeInTranscriptFromRealtime(confirmedTranscript, captureMetrics, timeline);
  if (realtimeRescue) {
    mirrorRuntimeLog('STT-RESCUE', `barge-in realtime replaced short Whisper: "${confirmedTranscript}" -> "${realtimeRescue}"`);
    correctedTranscript = realtimeRescue;
    confirmedTranscript = realtimeRescue;
    reaction = fastReaction(realtimeRescue);
    correctionReason = [correctionReason, 'barge-in-realtime-rescue'].filter(Boolean).join(';');
  }

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
    return;
  }
  if (policy.action === 'interrupt') {
    interruptActiveAnswer('explicit-user-stop');
    pendingTurns.splice(0, pendingTurns.length);
    mirrorRuntimeLog('INTERRUPT', `explicit stop: ${confirmedTranscript}`);
    return;
  }
  if (reaction?.terminal && reaction?.shouldSpeak) {
    if (!timeline.fastReactionRequestedAt) {
      playWebFastReaction(reaction, utteranceId, sessionEpoch, timeline, confirmedTranscript);
    }
    rememberAcceptedUserTurn(confirmedTranscript, userId, timeline);
    mirrorRuntimeLog('TERMINAL', `${reaction.kind}: ${confirmedTranscript}`);
    return;
  }
  if (shouldDropUncorroboratedBotOverlap(confirmedTranscript, captureMetrics, policy)) {
    console.warn(`[turn-policy] dropped reason=bot-overlap-unconfirmed whisper="${confirmedTranscript}" realtime="${String(captureMetrics?.realtimeTranscript || '')}"`);
    mirrorRuntimeLog('DROP', `bot-overlap-unconfirmed: ${confirmedTranscript}`);
    return;
  }

  // A final accepted user utterance that began while the bot was audibly
  // speaking is authoritative barge-in evidence. Preempt the old answer once,
  // then process this same utterance as the new turn instead of buffering it.
  if (answering && captureMetrics?.overlappedBotPlayback) {
    const interrupted = interruptActiveAnswer('confirmed-transcript-barge-in');
    if (interrupted) mirrorRuntimeLog('BARGE', `confirmed transcript preempted prior answer utterance=${utteranceId}`);
  }

  if (answering) {
    const nextTurn = { confirmedTranscript, rawTranscript, correctedTranscript, correctionReason, fastReaction: reaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta };
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
      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);
    }
    beginWatchStage(`turn:${utteranceId}`, 'turn', 50_000);
    const turn = await talk(confirmedTranscript, utteranceId, controller.signal)
      .finally(() => endWatchStage(`turn:${utteranceId}`));
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
    beginWatchStage(`tts:${utteranceId}`, 'tts', 30_000);
    const tts = await synthesize(turn.answer, controller.signal, { utteranceId, purpose: 'answer' })
      .finally(() => endWatchStage(`tts:${utteranceId}`));
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
    if (!controller.signal.aborted && turnSerial === activeTurnSerial && sessionEpoch === voiceEpoch) {
      commitConversationTurn(confirmedTranscript, turn);
    } else {
      mirrorRuntimeLog('CONTEXT-DROP', `uncommitted interrupted answer utterance=${utteranceId}`);
    }
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

async function handleCapturedUtterance({ pcm, userId, sessionEpoch, utteranceId, timeline, captureMetrics }) {
  if (sessionEpoch !== voiceEpoch) return;
  if (!pcm?.length) {
    console.log(`[capture] rejected empty utterance=${utteranceId}`);
    return;
  }

  const controller = new AbortController();
  try {
    beginWatchStage(`stt:${utteranceId}`, 'stt', 45_000);
    const stt = await transcribeCapturedUtterance(pcm, utteranceId, timeline, controller.signal)
      .finally(() => endWatchStage(`stt:${utteranceId}`));
    let rawTranscript = stt.confirmedTranscript;
    const correction = correctLowConfidenceTranscript(rawTranscript, captureMetrics, history);
    let correctedTranscript = correction.correctedTranscript || rawTranscript;
    let correctionReason = correction.correctionReason || '';
    if (correctionReason) mirrorRuntimeLog('STT-CORRECT', correctionReason + ': "' + rawTranscript + '" -> "' + correctedTranscript + '"');
    const arbitration = arbitrateSuccessfulTranscript({ whisperText: correctedTranscript, captureMetrics, timeline });
    mirrorRuntimeLog('STT-ARBITER', arbitration.action + ' reason=' + arbitration.reason
      + ' whisper="' + correctedTranscript + '" realtime="' + String(captureMetrics?.realtimeTranscript || '') + '"');
    if (arbitration.action === 'drop') {
      activeFastReaction?.stop?.('stt-conflict');
      activeFastReaction = null;
      if (!answering && player.state.status !== AudioPlayerStatus.Playing) {
        await speakRecoveryPrompt('stt-transcript-conflict', sessionEpoch, timeline.utteranceEndAt || 0);
      }
      return;
    }
    if (arbitration.action === 'accept-realtime') {
      correctedTranscript = arbitration.text;
      correctionReason = [correctionReason, arbitration.reason].filter(Boolean).join(';');
    }

    const echoRecord = looksLikeRecentBotEcho(correctedTranscript, timeline);
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
      fastReaction: fastReaction(correctedTranscript),
      userId,
      sessionEpoch,
      utteranceId,
      timeline,
      captureMetrics,
      sttMeta: stt,
    });
  } catch (error) {
    const message = String(error?.message || error || '').slice(0, 500);
    console.error('[stt]', message);
    mirrorRuntimeLog('ERROR', `STT: ${message}`);
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
    activeFastReaction?.stop?.('stt-failed');
    activeFastReaction = null;
    const failureKind = classifySttFailure(message);
    const rescue = rescueFailedWhisper({ error: message, captureMetrics, timeline });
    mirrorRuntimeLog('STT-ARBITER', `failure=${failureKind} action=${rescue.action} reason=${rescue.reason}`);
    if (rescue.action === 'accept-realtime') {
      const rescuePolicy = classifyVoiceTurn(rescue.text, {
        answerInFlight: answering || player.state.status === AudioPlayerStatus.Playing,
      });
      if (rescuePolicy.action === 'answer') {
        mirrorRuntimeLog('STT-RESCUE', `safe realtime rescue: ${rescue.text}`);
        await processConfirmedTranscript({
          confirmedTranscript: rescue.text,
          rawTranscript: rescue.text,
          correctedTranscript: rescue.text,
          correctionReason: rescue.reason,
          fastReaction: fastReaction(rescue.text),
          userId,
          sessionEpoch,
          utteranceId,
          timeline,
          captureMetrics,
          sttMeta: { model: 'realtime-rescue', whisperError: message },
        });
        return;
      }
    }
    if (['no-speech', 'hallucination', 'weak-speech'].includes(failureKind)) {
      mirrorRuntimeLog('DROP', `unsafe STT rescue blocked kind=${failureKind}: ${message}`);
      return;
    }
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
  let realtimeHelper = null;
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
    if (startedDuringBotPlayback) overlappedBotPlayback = true;
    if (!realtimeHelper || realtimeHelper.active?.utteranceId !== utteranceId) {
      realtimeHelper = beginRealtimeUtterance(userId, {
        utteranceId,
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
    const durationMs = pcm.length / 2 / WEB_VOICE_CAPTURE_POLICY.targetRate * 1000;
    timeline.utteranceEndAt = endedAt;
    cleanup();

    // Re-subscribe only on the next speaking.start event.
    // Re-subscribing an empty ended stream here can loop without incoming PCM.
    if (!pcm.length) {
      if (speakingMarked) mirrorRuntimeLog('CAPTURE-SKIP', `no PCM reason=${reason} user=${userId}`);
      return;
    }

    const realtimeActive = realtimeHelper?.active?.utteranceId === utteranceId ? realtimeHelper.active : null;
    const realtimeTranscript = realtimeActive ? String(realtimeActive.latestRealtimeTranscript || '') : '';
    const realtimeConfidence = realtimeActive && Number.isFinite(Number(realtimeActive.latestRealtimeConfidence))
      ? Number(realtimeActive.latestRealtimeConfidence) : null;
    const realtimeWords = realtimeActive && Array.isArray(realtimeActive.realtimeWords) ? realtimeActive.realtimeWords.slice(0,120) : [];
    const realtimeSpeechStartedAt = Number(realtimeActive?.realtimeSpeechStartedAt || 0);
    if (realtimeActive && realtimeTranscript && realtimeSpeechStartedAt) {
      triggerWebFastReaction(realtimeHelper, realtimeTranscript, 'capture-finalize');
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
      realtimeSpeechStartedAt,
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
    if (!realtimeHelper || !realtimeHelper.ws || realtimeHelper.ws.readyState >= WebSocket.CLOSING) {
      realtimeHelper = beginRealtimeUtterance(userId, {
        utteranceId,
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
  opus.on('close', () => {
    if (completed) return;
    mirrorRuntimeLog('RECEIVER', `AudioReceiveStream closed before finalize user=${userId}`);
    finalize('discord-transport-close').catch(() => {});
  });
  opus.pipe(decoder);

  if (!speakingMarked) console.log(`[capture] prearmed user=${userId}`);
}

function destroyVoiceConnection({ clearIntent = false } = {}) {
  if (clearIntent) desiredVoiceTarget = null;
  if (fullReconnectTimer) {
    clearTimeout(fullReconnectTimer);
    fullReconnectTimer = null;
  }
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

async function createReadyVoiceConnection(channel) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const candidate = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      debug: true,
    });

    const onState = (oldState, newState) => {
      const from = oldState?.status || 'unknown';
      const to = newState?.status || 'unknown';
      console.log(`[discord] voice connect attempt=${attempt} state=${from}->${to}`);
      mirrorRuntimeLog('VOICE-CONNECT', `attempt=${attempt} ${from}->${to}`);
    };
    const onDebug = (message) => {
      const value = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      if (value) mirrorRuntimeLog('VOICE-DEBUG', `attempt=${attempt} ${value}`);
    };
    candidate.on('stateChange', onState);
    candidate.on('debug', onDebug);

    try {
      mirrorRuntimeLog('VOICE-CONNECT', `attempt=${attempt}/3 dave=enabled`);
      await entersState(candidate, VoiceConnectionStatus.Ready, 20000);
      candidate.off('stateChange', onState);
      candidate.off('debug', onDebug);
      mirrorRuntimeLog('VOICE-CONNECT', `ready attempt=${attempt}`);
      return candidate;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '').slice(0, 220);
      console.warn(`[discord] voice ready failed attempt=${attempt}/3: ${message}`);
      mirrorRuntimeLog('VOICE-CONNECT', `failed attempt=${attempt}: ${message}`);
      candidate.off('stateChange', onState);
      candidate.off('debug', onDebug);
      try { candidate.destroy(); } catch {}
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw lastError || new Error('voice_ready_failed');
}

async function forceReconnectDesiredVoice(reason = 'voice-self-heal') {
  if (!desiredVoiceTarget || fullReconnectInFlight || bridgeShuttingDown) return false;
  fullReconnectInFlight = true;
  const target = { ...desiredVoiceTarget };
  try {
    mirrorRuntimeLog('VOICE-RESET', `full reconnect reason=${reason} guild=${target.guildId} channel=${target.channelId}`);
    const channel = await promiseWithTimeout((async () => {
      const guild = client.guilds.cache.get(target.guildId) || await client.guilds.fetch(target.guildId);
      return guild.channels.cache.get(target.channelId) || await guild.channels.fetch(target.channelId);
    })(), VOICE_REJOIN_TIMEOUT_MS, 'voice_reconnect_target_resolve_timeout');
    if (!channel?.isVoiceBased?.()) throw new Error('desired_voice_channel_unavailable');
    await connectToVoiceChannel(channel, target.initialUserId, { suppressGreeting: true });
    mirrorRuntimeLog('VOICE-RESET', 'full reconnect recovered');
    return true;
  } catch (error) {
    mirrorRuntimeLog('VOICE-RESET', `full reconnect failed: ${error?.message || error}`);
    return false;
  } finally {
    fullReconnectInFlight = false;
  }
}

function scheduleFullReconnect(reason = 'voice-reset', delayMs = 1200) {
  if (!desiredVoiceTarget || fullReconnectTimer || fullReconnectInFlight || bridgeShuttingDown) return;
  fullReconnectTimer = setTimeout(async () => {
    fullReconnectTimer = null;
    const ok = await forceReconnectDesiredVoice(reason);
    if (!ok && desiredVoiceTarget && !bridgeShuttingDown) {
      scheduleFullReconnect('retry-' + reason, Math.min(30_000, Math.max(2000, delayMs * 2)));
    }
  }, delayMs);
}

async function connectToVoiceChannel(channel, initialUserId = '', options = {}) {
  if (!channel || !channel.isVoiceBased()) throw new Error('target channel is not voice based');
  if (connection
      && connection.joinConfig?.channelId === channel.id
      && connection.state?.status === VoiceConnectionStatus.Ready) {
    mirrorRuntimeLog('VOICE', `already connected channel=${channel.name}; duplicate greeting skipped`);
    return channel;
  }
  desiredVoiceTarget = {
    guildId: channel.guild.id,
    channelId: channel.id,
    initialUserId: String(initialUserId || desiredVoiceTarget?.initialUserId || ''),
  };
  destroyVoiceConnection();

  connection = await createReadyVoiceConnection(channel);
  connection.subscribe(player);
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
  const noRejoinClose = () => boundConnection.state?.status === VoiceConnectionStatus.Disconnected
    && [4014, 4021, 4022].includes(Number(boundConnection.state?.closeCode));

  const scheduleRecovery = (reason = 'voice-disconnected') => {
    if (boundConnection !== connection || !connection) return;
    if (boundConnection.state.status === VoiceConnectionStatus.Ready
      || boundConnection.state.status === VoiceConnectionStatus.Destroyed || noRejoinClose()) return;
    if (voiceRecoveryTimer || voiceRecoveryInFlight) return;
    const delayMs = Math.min(30_000, 500 * (2 ** Math.min(voiceRecoveryAttempts, 6)));
    mirrorRuntimeLog('VOICE-RECOVERY', `scheduled reason=${reason} delay=${delayMs}ms attempt=${voiceRecoveryAttempts + 1}`);
    voiceRecoveryTimer = setTimeout(async () => {
      voiceRecoveryTimer = null;
      if (boundConnection !== connection || boundConnection.state.status === VoiceConnectionStatus.Ready
        || boundConnection.state.status === VoiceConnectionStatus.Destroyed || noRejoinClose()) return;
      voiceRecoveryInFlight = true;
      voiceRecoveryAttempts += 1;
      try {
        const accepted = boundConnection.rejoin();
        if (!accepted) throw new Error('voice_rejoin_rejected');
        await entersState(boundConnection, VoiceConnectionStatus.Ready, VOICE_REJOIN_TIMEOUT_MS);
        if (boundConnection !== connection) return;
        boundConnection.subscribe(player);
        voiceRecoveryAttempts = 0;
        mirrorRuntimeLog('VOICE-RECOVERY', 'rejoin recovered; player subscription restored');
      } catch (error) {
        mirrorRuntimeLog('VOICE-RECOVERY', `failed attempt=${voiceRecoveryAttempts} state=${boundConnection.state.status}: ${error?.message || error}`);
      } finally {
        voiceRecoveryInFlight = false;
        if (boundConnection === connection && boundConnection.state.status !== VoiceConnectionStatus.Ready
          && boundConnection.state.status !== VoiceConnectionStatus.Destroyed && !noRejoinClose()) {
          scheduleRecovery('retry-after-failure');
        }
      }
    }, delayMs);
  };

  boundConnection.on('stateChange', (oldState, newState) => {
    if (boundConnection !== connection) return;
    const reason = String(newState?.reason || '-');
    const code = String(newState?.closeCode ?? '-');
    mirrorRuntimeLog('VOICE-STATE', `${oldState?.status || '-'} -> ${newState.status} reason=${reason} closeCode=${code}`);
    if (newState.status === VoiceConnectionStatus.Ready) {
      voiceRecoveryAttempts = 0;
      if (voiceRecoveryTimer) clearTimeout(voiceRecoveryTimer);
      if (voiceStallTimer) clearTimeout(voiceStallTimer);
      voiceRecoveryTimer = null;
      voiceStallTimer = null;
      boundConnection.subscribe(player);
      return;
    }
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      if (voiceStallTimer) clearTimeout(voiceStallTimer);
      voiceStallTimer = null;
      scheduleFullReconnect('destroyed');
      return;
    }
    if (noRejoinClose()) {
      mirrorRuntimeLog('VOICE-ERROR', `server rejected rejoin closeCode=${code} reason=${reason}; creating fresh connection`);
      if (voiceStallTimer) clearTimeout(voiceStallTimer);
      voiceStallTimer = null;
      scheduleFullReconnect('non-rejoin-close-' + code);
      return;
    }
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      scheduleRecovery('disconnected');
    } else if (!voiceStallTimer && !voiceRecoveryInFlight
      && [VoiceConnectionStatus.Connecting, VoiceConnectionStatus.Signalling].includes(newState.status)) {
      voiceStallTimer = setTimeout(() => {
        voiceStallTimer = null;
        if (boundConnection !== connection || !connection) return;
        if (boundConnection.state.status === VoiceConnectionStatus.Ready
          || boundConnection.state.status === VoiceConnectionStatus.Destroyed) return;
        mirrorRuntimeLog('VOICE-STALLED', `state=${boundConnection.state.status} >15000ms; requesting rejoin`);
        scheduleRecovery('nonready-timeout');
      }, 15_000);
    }
  });
  boundConnection.on('error', (error) => {
    mirrorRuntimeLog('VOICE-ERROR', `status=${boundConnection.state?.status || '-'}: ${error?.message || error}`);
    console.error('[discord] voice connection error:', error?.message || error);
  });

  console.log('[discord] voice ready:', channel.name);
  console.log('[discord] conversation session:', discordSessionId);
  mirrorRuntimeLog('SESSION', discordSessionId);
  console.log('[discord] input architecture: Discord speaking gate -> Opus -> PCM16 Web STT format -> /api/transcribe');
  console.log('[discord] final STT: Whisper Large v3 Turbo via /api/transcribe');
  console.log('[discord] fast reaction: Web-compatible Nova helper -> /api/fast-reaction (non-authoritative)');
  mirrorRuntimeLog('VOICE', `ready channel=${channel.name}`);
  mirrorRuntimeLog('ARCH', 'Nova helper is reaction-only; Whisper remains authoritative');
  console.log('[discord] bridge revision:', DISCORD_BRIDGE_REVISION);
  if (!options?.suppressGreeting) await playConnectionGreeting();
  warmFastReactionAudio().catch((error) => console.warn('[fast-reaction] warmup failed:', error?.message || error));
  warmRecoveryAudio().catch((error) => console.warn('[recovery] warmup failed:', error?.message || error));
  return channel;
}

const TALKSYS_COMMANDS = [
  { name: 'talksys', description: 'TalkSysを現在参加中のVCへ呼び出します' },
  { name: 'logs', description: 'TalkSysのライブログをこのチャンネルに転送します' },
  { name: 'logdump', description: 'TalkSysのログを1つのテキストファイルで取得します' },
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
    const ready = client.isReady();
    const voiceStatus = connection?.state?.status || 'none';
    const voiceChannel = connection?.joinConfig?.channelId || '-';
    const desiredChannel = desiredVoiceTarget?.channelId || '-';
    const healthSignature = [
      ready ? '1' : '0',
      voiceStatus,
      voiceChannel,
      desiredChannel,
    ].join('|');
    const healthChanged = healthSignature !== lastHealthLogSignature;

    if (healthChanged) {
      lastHealthLogSignature = healthSignature;
      console.log(`[discord] gateway health ready=${ready} ping=${client.ws.ping}ms guilds=${client.guilds.cache.size} voice=${voiceStatus} channel=${voiceChannel} desired=${desiredChannel}`);
      if (runtimeLogChannel) {
        mirrorRuntimeLog('HEALTH', `gateway=${ready} ping=${client.ws.ping}ms voice=${voiceStatus} channel=${voiceChannel} captures=${sessions.size} answering=${answering} queued=${pendingTurns.length} logPending=${discordLogQueue.length} desired=${desiredChannel}`);
      }
    }

    if (desiredVoiceTarget && ready) {
      const missing = !connection || voiceStatus === VoiceConnectionStatus.Destroyed;
      const wrongChannel = connection && voiceChannel !== desiredVoiceTarget.channelId;
      if (missing || wrongChannel) scheduleFullReconnect(missing ? 'health-missing-connection' : 'health-channel-mismatch');
    }
  }, 10_000);

  console.log(`[discord] bridge revision=${DISCORD_BRIDGE_REVISION}`);
  console.log(`[discord] gateway ready user=${client.user?.tag || client.user?.id || 'unknown'} ping=${client.ws.ping}ms`);
  mirrorRuntimeLog('VERSION', DISCORD_BRIDGE_REVISION);
  mirrorRuntimeLog('GATEWAY', `ready ping=${client.ws.ping}ms guilds=${client.guilds.cache.size}`);
  await restoreRuntimeLogChannel();
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
  if (!['talksys', 'logs', 'logdump', 'leave'].includes(interaction.commandName)) return;

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
      const currentOwner = readPersistedRuntimeLogOwnerId();
      if (currentOwner && currentOwner !== interaction.user.id) {
        await interaction.editReply('既存のログ設定者以外は変更できません。');
        return;
      }
      const attached = await attachRuntimeLogChannel(interaction.channel);
      if (attached) persistRuntimeLogOwnerId(interaction.user.id);
      await interaction.editReply(attached
        ? 'このチャンネルをログ先として保存しました。再起動後も追記します。すべてまとめて取得するには /logdump を実行してください。'
        : 'このチャンネルにはライブログを表示できません。');
      return;
    }

    if (interaction.commandName === 'logdump') {
      const owner = readPersistedRuntimeLogOwnerId();
      if (!owner) {
        await interaction.editReply('専用ログチャンネルで一度 /logs を実行してください。');
        return;
      }
      if (owner !== interaction.user.id) {
        await interaction.editReply('ログ設定者のみ取得できます。');
        return;
      }
      const data = await exportRuntimeLogs();
      const filename = 'talksys-discord-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      await interaction.editReply({
        content: 'ログを1つのテキストファイルにまとめました。ファイルを開けば全選択してコピーできます。',
        files: [new AttachmentBuilder(data, { name: filename })],
      });
      return;
    }

    if (interaction.commandName === 'talksys') {
      if (!runtimeLogChannel) await attachRuntimeLogChannel(interaction.channel, { persist: false });
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
    destroyVoiceConnection({ clearIntent: true });
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

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!client.user || newState.id !== client.user.id) return;
  if (oldState.channelId === newState.channelId) return;
  mirrorRuntimeLog('VOICE-STATE', `bot channel ${oldState.channelId || '-'} -> ${newState.channelId || '-'}`);
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
  if (bridgeHeartbeatTimer) clearInterval(bridgeHeartbeatTimer);
  if (bridgeShutdownTimer) clearInterval(bridgeShutdownTimer);
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

process.on('exit', flushPendingLogsOnExit);
startBridgeMonitors();
mirrorRuntimeLog('BOOT', `process start node=${process.version}`);
mirrorRuntimeLog('BOOT', `bridge=${DISCORD_BRIDGE_REVISION}`);
client.login(DISCORD_TOKEN).catch((error) => {
  if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
  console.error('[fatal] Discord login failed:', error?.stack || error);
  client.destroy();
  process.exit(2);
});
