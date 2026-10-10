import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalkmanSource } from './build-talkman.mjs';

export const TALKMAN_RUNTIME_HARDENING_REVISION = 'talkman-group-v1-hardening-r5-decode-resilience';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) throw new Error(`TalkMan hardening anchor missing: ${label}`);
  if (first !== last) throw new Error(`TalkMan hardening anchor is not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function buildTalkmanRuntimeSource(input) {
  let source = buildTalkmanSource(String(input || ''));

  source = replaceOnce(
    source,
    'const TALKMAN_QUEUE_LIMIT = 12;',
    'const TALKMAN_QUEUE_LIMIT = 1;',
    'TalkMan latest-only queue limit',
  );

  source = replaceOnce(
    source,
    `function buildTalkmanInput(text = '', speakerName = '') {
  const utterance = String(text || '').trim();
  const speaker = sanitizeTalkmanSpeakerName(speakerName);
  return [
    '[TalkMan group conversation]',
    '発話者=' + speaker,
    '発言=' + utterance,
    'このモードは複数人の雑談用です。会話履歴にある発話者を取り違えず、今の発話者と場全体の流れに自然に返してください。',
    '雑談では軽いツッコミ、言葉遊び、直前の話題へのコールバックを使ってよいですが、無理に毎回ボケず、しつこいイジりや誰かを傷つける笑いは避けてください。',
    '通常は1文から3文で短く返してください。質問、事実確認、安全に関わる話ではユーモアより正確さを優先してください。発話者や発言内容を推測で作らないでください。',
    'この制御文自体は読み上げず、返答本文だけを出してください。',
  ].join('\\n');
}`,
    `function buildTalkmanInput(text = '', speakerName = '') {
  const utterance = String(text || '').trim();
  const speaker = sanitizeTalkmanSpeakerName(speakerName);
  return '[TM ' + speaker + '] ' + utterance
    + '\\n返答:原則1文45字以内。VC参加者として即答。必要なら軽くツッコむ/直前ネタ回収。事実は正確に。待ち文句・司会口調・丁寧な締め・長い一般論は禁止。';
}`,
    'compact TalkMan prompt',
  );

  source = replaceOnce(
    source,
    `function enqueueTalkmanTurn(nextTurn) {
  if (pendingTurns.length >= TALKMAN_QUEUE_LIMIT) {
    const sameSpeakerIndex = pendingTurns.findIndex((item) => String(item?.userId || '') === String(nextTurn?.userId || ''));
    if (sameSpeakerIndex >= 0) pendingTurns.splice(sameSpeakerIndex, 1);
    else pendingTurns.shift();
  }
  pendingTurns.push(nextTurn);
}

function pruneRecentBotSpeech`,
    `function enqueueTalkmanTurn(nextTurn) {
  pendingTurns.splice(0, pendingTurns.length, nextTurn);
}

function normalizeTalkmanAnswer(value = '') {
  let answer = String(value || '').trim();
  if (conversationMode !== 'talkman') return answer;
  answer = answer.replace(/フォーンズ/g, 'トークマン');
  answer = answer.replace(/^(?:はい[、, ]*)?(?:少し)?(?:確認してお答えします(?:ね)?|内容を確認します(?:ね)?|関連情報を確認します|最新の情報を確認してみます|少し検索して確かめます|確認できる情報を調べています|調べます(?:ね)?|確認します(?:ね)?)[。！!\\s]*/u, '').trim();
  answer = answer.replace(/(?:気をつけて行ってきてください|楽しんできてください|楽しそうですね)[。！!\\s]*$/u, '').trim();
  const firstSentence = answer.match(/^.{1,64}?[。！？!?](?:\\s|$)/u)?.[0]?.trim();
  if (answer.length > 64 && firstSentence) answer = firstSentence;
  if (answer.length > 64) answer = answer.slice(0, 60).replace(/[、,][^、,]*$/u, '').trim() + '。';
  return answer || 'うん。';
}

function pruneRecentBotSpeech`,
    'TalkMan final-answer normalizer',
  );

  // TalkMan is a participant, not an acknowledgement generator. Keep the
  // build-talkman defaults that disable fast reactions and waiting cues.
  source = replaceOnce(
    source,
    '      console.log(`[queue] TalkMan FIFO user=${userId} queued=${pendingTurns.length}: ${confirmedTranscript}`);',
    '      console.log(`[queue] TalkMan latest user=${userId} queued=${pendingTurns.length}: ${confirmedTranscript}`);',
    'TalkMan queue log',
  );

  source = replaceOnce(
    source,
    "      mirrorRuntimeLog('QUEUE', `talkman fifo size=${pendingTurns.length}: ${confirmedTranscript}`);",
    "      mirrorRuntimeLog('QUEUE', `talkman latest size=${pendingTurns.length}: ${confirmedTranscript}`);",
    'TalkMan queue mirror log',
  );

  // Do not speak a connection greeting in TalkMan mode.
  source = replaceOnce(
    source,
    '  if (!options?.suppressGreeting) await playConnectionGreeting();',
    "  if (!options?.suppressGreeting && conversationMode !== 'talkman') await playConnectionGreeting();",
    'TalkMan no connection greeting',
  );

  // TalkMan should be harder to interrupt accidentally. Classic TalkSys keeps
  // the existing 150 ms threshold; TalkMan requires 600 ms of sustained voice.
  source = replaceOnce(
    source,
    `function updateBargeInVoiceGate(active, pcm16) {
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
}`,
    `function updateBargeInVoiceGate(active, pcm16) {
  if (!active?.startedDuringBotPlayback || active.bargeInTriggered || !pcm16?.length) return;
  const level = pcm16Level(pcm16);
  const durationMs = (pcm16.length / 2 / WEB_VOICE_CAPTURE_POLICY.targetRate) * 1000;
  const voiced = level.rms >= BARGE_IN_RMS_THRESHOLD && level.peak >= BARGE_IN_PEAK_THRESHOLD;
  active.bargeInVoicedMs = voiced ? Number(active.bargeInVoicedMs || 0) + durationMs : 0;
  const confirmMs = conversationMode === 'talkman' ? 600 : BARGE_IN_CONFIRM_MS;
  if (!active.bargeInArmed && active.bargeInVoicedMs >= confirmMs) {
    active.bargeInArmed = true;
    active.bargeInArmedAt = Date.now();
    maybeTriggerConfirmedBargeIn(active);
  }
}`,
    'TalkMan relaxed barge-in',
  );

  // Keep a transient decoder failure from killing voice capture permanently.
  // A valid PCM frame clears the failure streak. Repeated failures trigger the
  // bridge's existing full voice reconnect so DAVE/RTP state is rebuilt.
  source = replaceOnce(
    source,
    'const sessions = new Map();\nconst history = [];',
    'const sessions = new Map();\nconst decoderRecoveryByUser = new Map();\nconst history = [];',
    'decoder recovery state',
  );

  source = replaceOnce(
    source,
    `  let lastPcmAt = 0;
  let realtimeHelper = null;`,
    `  let lastPcmAt = 0;
  let lastOpusPacketBytes = 0;
  let lastOpusPacketHead = '';
  let realtimeHelper = null;`,
    'decoder diagnostics state',
  );

  source = replaceOnce(
    source,
    `  decoder.on('data', (pcm48) => {
    if (!resampler.stdin.destroyed && !resampler.stdin.writableEnded) resampler.stdin.write(pcm48);
  });

  resampler.stdout.on('data', (pcm16) => {`,
    `  opus.on('data', (packet) => {
    if (!packet?.length) return;
    lastOpusPacketBytes = packet.length;
    lastOpusPacketHead = packet.subarray(0, Math.min(8, packet.length)).toString('hex');
  });

  decoder.on('data', (pcm48) => {
    if (!resampler.stdin.destroyed && !resampler.stdin.writableEnded) resampler.stdin.write(pcm48);
  });

  resampler.stdout.on('data', (pcm16) => {`,
    'decoder packet diagnostics',
  );

  source = replaceOnce(
    source,
    `  resampler.stdout.on('data', (pcm16) => {
    if (!pcm16?.length || completed) return;
    const at = Date.now();`,
    `  resampler.stdout.on('data', (pcm16) => {
    if (!pcm16?.length || completed) return;
    decoderRecoveryByUser.delete(userId);
    const at = Date.now();`,
    'decoder recovery reset on PCM',
  );

  source = replaceOnce(
    source,
    `  decoder.on('error', (error) => {
    console.error('[decode]', error.message);
    finalize('decoder-error').catch(() => {});
  });`,
    `  decoder.on('error', (error) => {
    const now = Date.now();
    const previous = decoderRecoveryByUser.get(userId);
    const sameWindow = previous && now - previous.startedAt <= 2000;
    const recovery = {
      startedAt: sameWindow ? previous.startedAt : now,
      count: sameWindow ? previous.count + 1 : 1,
    };
    decoderRecoveryByUser.set(userId, recovery);
    const message = String(error?.message || error || 'decoder error');
    console.error(\`[decode] \${message} user=\${userId} recovery=\${recovery.count}/3 opusBytes=\${lastOpusPacketBytes} head=\${lastOpusPacketHead || '-'}\`);
    mirrorRuntimeLog('DECODE', \`error user=\${userId} recovery=\${recovery.count}/3 bytes=\${lastOpusPacketBytes} message=\${message.slice(0, 120)}\`);
    const reconnectVoice = recovery.count > 3;
    finalize('decoder-error').finally(() => {
      if (sessionEpoch !== voiceEpoch || !connection) return;
      if (reconnectVoice) {
        decoderRecoveryByUser.delete(userId);
        mirrorRuntimeLog('DECODE-RECOVERY', \`full reconnect user=\${userId} after repeated decoder errors\`);
        scheduleFullReconnect('decoder-invalid-packet', 250);
        return;
      }
      setTimeout(() => {
        if (sessionEpoch !== voiceEpoch || !connection || sessions.has(userId)) return;
        mirrorRuntimeLog('DECODE-RECOVERY', \`rearm user=\${userId} attempt=\${recovery.count}\`);
        startReceiverSession(userId, false);
      }, 80);
    }).catch(() => {});
  });`,
    'decoder transient recovery',
  );

  source = replaceOnce(
    source,
    `  sessions.clear();
  closeRealtimeHelpers();`,
    `  sessions.clear();
  decoderRecoveryByUser.clear();
  closeRealtimeHelpers();`,
    'decoder recovery reset on disconnect',
  );

  source = replaceOnce(
    source,
    '  const previous = history.slice(-MAX_HISTORY);',
    `  const previous = history.slice(-(conversationMode === 'talkman' ? 6 : MAX_HISTORY));
  if (conversationMode === 'talkman') {
    const historyChars = previous.reduce((sum, item) => sum + String(item?.content || '').length, 0);
    mirrorRuntimeLog('TOKEN-PROXY', \`inputChars=\${String(text || '').length} historyItems=\${previous.length} historyChars=\${historyChars}\`);
  }`,
    'TalkMan compact local history',
  );

  source = replaceOnce(
    source,
    '      commitConversationTurn(conversationalInput, turn);',
    "      commitConversationTurn(conversationMode === 'talkman' ? ('[TM ' + talkmanSpeaker + '] ' + confirmedTranscript) : conversationalInput, turn);",
    'TalkMan compact history commit',
  );

  source = replaceOnce(
    source,
    `  const body = await response.json().catch(() => ({}));
  if (!body?.ok || !body?.answer) {`,
    `  const body = await response.json().catch(() => ({}));
  if (conversationMode === 'talkman' && body?.answer) {
    body.answer = normalizeTalkmanAnswer(body.answer);
  }
  if (!body?.ok || !body?.answer) {`,
    'TalkMan answer normalization hook',
  );

  source = replaceOnce(
    source,
    `      const channel = await interaction.guild.channels.fetch(channelId);
      await connectToVoiceChannel(channel, interaction.user.id);
      if (conversationMode === 'talkman') {`,
    `      const channel = await interaction.guild.channels.fetch(channelId);
      await connectToVoiceChannel(channel, interaction.user.id);
      if (modeChanged && !discordSessionId) {
        discordSessionId = \`discord-\${channel.guild.id}-\${channel.id}-\${randomUUID()}\`;
        mirrorRuntimeLog('SESSION', \`mode-switch renewed \${discordSessionId}\`);
      }
      if (conversationMode === 'talkman') {`,
    'mode-switch session renewal',
  );

  return source;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'index.mjs');
const canonicalSourcePath = path.join(here, 'index-classic-base.mjs');
const outputPath = path.join(here, 'index-talkman.generated.mjs');

export function hasTalkmanWorkingTreeMarkers(input = '') {
  const source = String(input || '');
  return [
    "let activeUserId = '';",
    "let conversationMode = 'talksys';",
    "name: 'talkman'",
    'function sanitizeTalkmanSpeakerName',
    'function normalizeTalkmanAnswer',
  ].some((marker) => source.includes(marker));
}

export function buildTalkmanRuntimeWithFallback(primaryInput = '', canonicalInput = '') {
  const primary = String(primaryInput || '');
  try {
    return { built: buildTalkmanRuntimeSource(primary), fallbackUsed: false, reason: '' };
  } catch (error) {
    if (!hasTalkmanWorkingTreeMarkers(primary)) throw error;
    const canonical = String(canonicalInput || '');
    if (!canonical) throw error;
    return {
      built: buildTalkmanRuntimeSource(canonical),
      fallbackUsed: true,
      reason: String(error?.message || error),
    };
  }
}

export function buildTalkmanRuntimeFile() {
  const workingSource = fs.readFileSync(sourcePath, 'utf8');
  const canonicalSource = fs.readFileSync(canonicalSourcePath, 'utf8');
  const result = buildTalkmanRuntimeWithFallback(workingSource, canonicalSource);
  if (result.fallbackUsed) {
    console.warn(`[talkman-build] index.mjs contains TalkMan/partial-patch markers; using canonical classic base (${result.reason})`);
  }
  fs.writeFileSync(outputPath, result.built, 'utf8');
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builtPath = buildTalkmanRuntimeFile();
  console.log(`[talkman-build] ${TALKMAN_RUNTIME_HARDENING_REVISION}`);
  console.log(`[talkman-build] generated ${builtPath}`);
}
