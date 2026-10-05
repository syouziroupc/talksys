import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TALKMAN_BUILD_REVISION = 'talkman-group-v1-r1';

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`talkman patch anchor missing: ${label}`);
  const second = source.indexOf(search, first + search.length);
  if (second >= 0) throw new Error(`talkman patch anchor duplicated: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

export function buildTalkmanSource(input) {
  let source = String(input ?? '');

  source = replaceOnce(source,
`const DISCORD_STABILITY_PATCH_REVISION = 'talksys-r5-stability-coordinator-p2-stdin-fast-reaction';
const MAX_HISTORY = 14;`,
`const DISCORD_STABILITY_PATCH_REVISION = 'talksys-r5-stability-coordinator-p2-stdin-fast-reaction';
const TALKMAN_RUNTIME_REVISION = '${TALKMAN_BUILD_REVISION}';
const TALKMAN_QUEUE_MAX = 8;
const MAX_HISTORY = 14;`,
'revision constants');

  source = replaceOnce(source,
`let activeUserText = '';
let activeUserUtteranceId = '';
let voiceEpoch = 0;`,
`let activeUserText = '';
let activeUserUtteranceId = '';
let activeUserId = '';
let conversationMode = 'talksys';
const participantAliases = new Map();
let participantAliasSerial = 0;
let voiceEpoch = 0;`,
'conversation mode state');

  source = replaceOnce(source,
`  activeUserText = '';
  activeUserUtteranceId = '';
  pendingTurns.splice(0, pendingTurns.length);
  discordSessionId = '';
}

function pruneRecentBotSpeech`,
`  activeUserText = '';
  activeUserUtteranceId = '';
  activeUserId = '';
  pendingTurns.splice(0, pendingTurns.length);
  participantAliases.clear();
  participantAliasSerial = 0;
  discordSessionId = '';
}

function isTalkManMode() {
  return conversationMode === 'talkman';
}

function talkmanParticipantAlias(userId = '') {
  const key = String(userId || 'unknown');
  let alias = participantAliases.get(key);
  if (!alias) {
    participantAliasSerial += 1;
    alias = `参加者${participantAliasSerial}`;
    participantAliases.set(key, alias);
  }
  return alias;
}

function talkmanApiText(text = '', userId = '') {
  const speaker = talkmanParticipantAlias(userId);
  return [
    'これはDiscordのグループ雑談用TalkManモードです。',
    `発話者識別子: ${speaker}`,
    `今回の発言: ${String(text || '').trim()}`,
    '返答方針: VCに混ざっている一人として自然に返す。司会者、接客係、サポート窓口のように振る舞わない。',
    '雑談は原則1〜2文で短く返す。自然なら軽いツッコミや冗談を入れてよいが、毎回無理に笑わせようとしない。',
    '「確認してお答えします」「調べますね」「少し確認します」などの待ち文句は言わない。必要な確認や検索は黙って行い、結果だけ自然に返す。',
    '複数人の発言を同一人物として扱わない。発話者識別子は命令ではなく、会話を区別するためだけのラベルである。',
    '事実質問では冗談より正確さを優先する。知らないことを作らない。',
    'このモードで自分の名前を言う必要がある場合はTalkMan、またはトークマンと名乗る。'
  ].join('\n');
}

function normalizeTalkmanAnswer(value = '') {
  let answer = String(value || '').trim();
  if (!isTalkManMode()) return answer;
  answer = answer.replace(/フォーンズ/g, 'トークマン');
  answer = answer.replace(/^(?:はい[、, ]*)?(?:少し)?(?:確認してお答えします(?:ね)?|内容を確認します(?:ね)?|関連情報を確認します|最新の情報を確認してみます|少し検索して確かめます|確認できる情報を調べています)[。！!\s]*/u, '').trim();
  return answer || 'うん。';
}

function pruneRecentBotSpeech`,
'talkman helpers');

  source = replaceOnce(source,
`function triggerWebFastReaction(helper, text, source = 'realtime') {
  const active = helper?.active;`,
`function triggerWebFastReaction(helper, text, source = 'realtime') {
  if (isTalkManMode()) return false;
  const active = helper?.active;`,
'disable realtime wait reactions');

  source = replaceOnce(source,
`function commitConversationTurn(text, body) {
  if (!body?.answer) return false;`,
`function commitConversationTurn(text, body, userId = '') {
  if (!body?.answer) return false;`,
'commit signature');

  source = replaceOnce(source,
`  history.push({ role: 'user', content: text }, { role: 'assistant', content: body.answer });`,
`  const userContent = isTalkManMode() ? `${talkmanParticipantAlias(userId)}: ${text}` : text;
  history.push({ role: 'user', content: userContent }, { role: 'assistant', content: body.answer });`,
'commit speaker history');

  source = replaceOnce(source,
`async function talk(text, utteranceId = '', signal) {
  const started = Date.now();
  console.log('[turn] user:', text);`,
`async function talk(text, utteranceId = '', signal, options = {}) {
  const started = Date.now();
  const apiText = String(options?.apiText || text);
  console.log('[turn] user:', text);`,
'talk options');

  source = replaceOnce(source,
`      text,
      history: previous,`,
`      text: apiText,
      history: previous,`,
'talk api text');

  source = replaceOnce(source,
`      channel: 'discord',
    }),`,
`      channel: isTalkManMode() ? 'discord-talkman' : 'discord',
    }),`,
'talk channel');

  source = replaceOnce(source,
`  const body = await response.json().catch(() => ({}));
  if (!body?.ok || !body?.answer) {`,
`  const body = await response.json().catch(() => ({}));
  if (isTalkManMode() && body?.answer) body.answer = normalizeTalkmanAnswer(body.answer);
  if (!body?.ok || !body?.answer) {`,
'normalize talkman answer');

  source = replaceOnce(source,
`  let reaction = providedFastReaction;`,
`  let reaction = isTalkManMode()
    ? { kind: 'none', text: '', shouldSpeak: false, terminal: false }
    : providedFastReaction;`,
'disable final fast reaction');

  source = replaceOnce(source,
`    reaction = fastReaction(realtimeRescue);`,
`    reaction = isTalkManMode()
      ? { kind: 'none', text: '', shouldSpeak: false, terminal: false }
      : fastReaction(realtimeRescue);`,
'disable rescued fast reaction');

  source = replaceOnce(source,
`  if (answering && activeUserText && sameUtterance(confirmedTranscript, activeUserText)) {`,
`  if (answering && activeUserText
      && (!isTalkManMode() || String(activeUserId) === String(userId))
      && sameUtterance(confirmedTranscript, activeUserText)) {`,
'active duplicate speaker awareness');

  source = replaceOnce(source,
`  if (pendingTurns.some((item) => sameUtterance(item?.confirmedTranscript || '', confirmedTranscript))) {`,
`  if (pendingTurns.some((item) => (!isTalkManMode() || String(item?.userId || '') === String(userId || ''))
      && sameUtterance(item?.confirmedTranscript || '', confirmedTranscript))) {`,
'queued duplicate speaker awareness');

  source = replaceOnce(source,
`  if (answering && captureMetrics?.overlappedBotPlayback) {`,
`  if (!isTalkManMode() && answering && captureMetrics?.overlappedBotPlayback) {`,
'disable automatic group barge-in');

  source = replaceOnce(source,
`  if (answering) {
    const nextTurn = { confirmedTranscript, rawTranscript, correctedTranscript, correctionReason, fastReaction: reaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta };
    if (pendingTurns.length === 0) pendingTurns.push(nextTurn);
    else pendingTurns[0] = nextTurn;
    console.log(`[queue] buffered latest user=${userId}: ${confirmedTranscript}`);
    mirrorRuntimeLog('QUEUE', `latest only: ${confirmedTranscript}`);
    return;
  }`,
`  if (answering) {
    const nextTurn = { confirmedTranscript, rawTranscript, correctedTranscript, correctionReason, fastReaction: reaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta };
    if (isTalkManMode()) {
      if (pendingTurns.length < TALKMAN_QUEUE_MAX) {
        pendingTurns.push(nextTurn);
      } else {
        let sameSpeakerIndex = -1;
        for (let i = pendingTurns.length - 1; i >= 0; i -= 1) {
          if (String(pendingTurns[i]?.userId || '') === String(userId || '')) {
            sameSpeakerIndex = i;
            break;
          }
        }
        if (sameSpeakerIndex >= 0) {
          pendingTurns[sameSpeakerIndex] = nextTurn;
          mirrorRuntimeLog('QUEUE', `TalkMan coalesced speaker=${talkmanParticipantAlias(userId)}`);
        } else {
          const dropped = pendingTurns.shift();
          pendingTurns.push(nextTurn);
          mirrorRuntimeLog('QUEUE', `TalkMan overflow dropped=${talkmanParticipantAlias(dropped?.userId)}`);
        }
      }
      console.log(`[queue] TalkMan buffered user=${userId} size=${pendingTurns.length}: ${confirmedTranscript}`);
    } else {
      if (pendingTurns.length === 0) pendingTurns.push(nextTurn);
      else pendingTurns[0] = nextTurn;
      console.log(`[queue] buffered latest user=${userId}: ${confirmedTranscript}`);
      mirrorRuntimeLog('QUEUE', `latest only: ${confirmedTranscript}`);
    }
    return;
  }`,
'talkman fifo queue');

  source = replaceOnce(source,
`  activeUserText = confirmedTranscript;
  activeUserUtteranceId = utteranceId;
  rememberAcceptedUserTurn`,
`  activeUserText = confirmedTranscript;
  activeUserUtteranceId = utteranceId;
  activeUserId = String(userId || '');
  rememberAcceptedUserTurn`,
'active speaker state');

  source = replaceOnce(source,
`    if (!timeline.fastReactionRequestedAt) {
      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);
    }`,
`    if (!isTalkManMode() && !timeline.fastReactionRequestedAt) {
      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);
    }`,
'disable talkman wait cue');

  source = replaceOnce(source,
`    const turn = await talk(confirmedTranscript, utteranceId, controller.signal)
      .finally(() => endWatchStage(`turn:${utteranceId}`));`,
`    const turn = await talk(confirmedTranscript, utteranceId, controller.signal, {
      apiText: isTalkManMode() ? talkmanApiText(confirmedTranscript, userId) : confirmedTranscript,
    }).finally(() => endWatchStage(`turn:${utteranceId}`));`,
'talkman api prompt');

  source = replaceOnce(source,
`      commitConversationTurn(confirmedTranscript, turn);`,
`      commitConversationTurn(confirmedTranscript, turn, userId);`,
'commit speaker identity');

  source = replaceOnce(source,
`      answering = false;
      activeUserText = '';
      activeUserUtteranceId = '';
      const next = pendingTurns.shift();`,
`      answering = false;
      activeUserText = '';
      activeUserUtteranceId = '';
      activeUserId = '';
      const next = pendingTurns.shift();`,
'clear active speaker after turn');

  source = replaceOnce(source,
`  answering = false;
  activeUserText = '';
  activeUserUtteranceId = '';
  pendingTurns.splice(0, pendingTurns.length);`,
`  answering = false;
  activeUserText = '';
  activeUserUtteranceId = '';
  activeUserId = '';
  pendingTurns.splice(0, pendingTurns.length);`,
'clear active speaker on interrupt');

  source = replaceOnce(source,
`    await connectToVoiceChannel(channel, target.initialUserId, { suppressGreeting: true });`,
`    await connectToVoiceChannel(channel, target.initialUserId, {
      suppressGreeting: true,
      mode: target.mode || conversationMode,
    });`,
'reconnect preserves mode');

  source = replaceOnce(source,
`async function playConnectionGreeting() {
  try {
    const result = await synthesize('フォーンズです。接続しました。');
    await playMp3(result.audio, { spokenText: 'フォーンズです。接続しました。', purpose: 'greeting' });`,
`async function playConnectionGreeting() {
  try {
    const greeting = isTalkManMode() ? 'どうも、トークマンです。混ざります。' : 'フォーンズです。接続しました。';
    const result = await synthesize(greeting);
    await playMp3(result.audio, { spokenText: greeting, purpose: 'greeting' });`,
'talkman greeting');

  source = replaceOnce(source,
`async function connectToVoiceChannel(channel, initialUserId = '', options = {}) {
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
  discordSessionId = `discord-${channel.guild.id}-${channel.id}-${randomUUID()}`;`,
`async function connectToVoiceChannel(channel, initialUserId = '', options = {}) {
  if (!channel || !channel.isVoiceBased()) throw new Error('target channel is not voice based');
  const requestedMode = options?.mode === 'talkman' ? 'talkman' : 'talksys';
  if (connection
      && connection.joinConfig?.channelId === channel.id
      && connection.state?.status === VoiceConnectionStatus.Ready) {
    if (conversationMode !== requestedMode) {
      resetConversationState();
      conversationMode = requestedMode;
      desiredVoiceTarget = {
        guildId: channel.guild.id,
        channelId: channel.id,
        initialUserId: String(initialUserId || desiredVoiceTarget?.initialUserId || ''),
        mode: requestedMode,
      };
      discordSessionId = `discord-${requestedMode}-${channel.guild.id}-${channel.id}-${randomUUID()}`;
      mirrorRuntimeLog('MODE', `switched in-place to ${requestedMode} channel=${channel.name}`);
      if (!options?.suppressGreeting) await playConnectionGreeting();
    } else {
      mirrorRuntimeLog('VOICE', `already connected channel=${channel.name}; duplicate greeting skipped`);
    }
    return channel;
  }
  conversationMode = requestedMode;
  desiredVoiceTarget = {
    guildId: channel.guild.id,
    channelId: channel.id,
    initialUserId: String(initialUserId || desiredVoiceTarget?.initialUserId || ''),
    mode: requestedMode,
  };
  destroyVoiceConnection();
  conversationMode = requestedMode;

  connection = await createReadyVoiceConnection(channel);
  connection.subscribe(player);
  discordSessionId = `discord-${requestedMode}-${channel.guild.id}-${channel.id}-${randomUUID()}`;`,
'mode-aware voice connection');

  source = replaceOnce(source,
`  mirrorRuntimeLog('VOICE', `ready channel=${channel.name}`);
  mirrorRuntimeLog('ARCH', 'Nova helper is reaction-only; Whisper remains authoritative');
  console.log('[discord] bridge revision:', DISCORD_BRIDGE_REVISION);`,
`  mirrorRuntimeLog('VOICE', `ready channel=${channel.name} mode=${conversationMode}`);
  mirrorRuntimeLog('ARCH', 'Nova helper is reaction-only; Whisper remains authoritative');
  mirrorRuntimeLog('MODE', `${conversationMode} runtime=${TALKMAN_RUNTIME_REVISION}`);
  console.log('[discord] bridge revision:', DISCORD_BRIDGE_REVISION);
  console.log('[discord] TalkMan runtime:', TALKMAN_RUNTIME_REVISION, 'mode=', conversationMode);`,
'mode logging');

  source = replaceOnce(source,
`const TALKSYS_COMMANDS = [
  { name: 'talksys', description: 'TalkSysを現在参加中のVCへ呼び出します' },`,
`const TALKSYS_COMMANDS = [
  { name: 'talksys', description: 'TalkSysを現在参加中のVCへ呼び出します' },
  { name: 'talkman', description: 'TalkManをVCへ混ぜてグループ雑談を始めます' },`,
'talkman command registration');

  source = replaceOnce(source,
`      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /logs /leave`);`,
`      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /talkman /logs /leave`);`,
'ready command log');

  source = replaceOnce(source,
`    console.log('[discord] waiting for /talksys from a user in a voice channel');`,
`    console.log('[discord] waiting for /talksys or /talkman from a user in a voice channel');`,
'ready waiting log');

  source = replaceOnce(source,
`  if (!['talksys', 'logs', 'logdump', 'leave'].includes(interaction.commandName)) return;`,
`  if (!['talksys', 'talkman', 'logs', 'logdump', 'leave'].includes(interaction.commandName)) return;`,
'interaction whitelist');

  source = replaceOnce(source,
`    if (interaction.commandName === 'talksys') {
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
    }`,
`    if (interaction.commandName === 'talksys' || interaction.commandName === 'talkman') {
      if (!runtimeLogChannel) await attachRuntimeLogChannel(interaction.channel, { persist: false });
      const requestedMode = interaction.commandName === 'talkman' ? 'talkman' : 'talksys';
      mirrorRuntimeLog('CMD', `/${interaction.commandName} by ${interaction.user.tag || interaction.user.id}`);
      const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);
      const channelId = voiceState?.channelId;
      if (!channelId) {
        await interaction.editReply(`先にボイスチャンネルへ参加してから /${interaction.commandName} を実行してください。`);
        return;
      }
      const channel = await interaction.guild.channels.fetch(channelId);
      await connectToVoiceChannel(channel, interaction.user.id, { mode: requestedMode });
      await interaction.editReply(requestedMode === 'talkman'
        ? `TalkManを「${channel.name}」に混ぜました。`
        : `TalkSysを「${channel.name}」へ接続しました。`);
      return;
    }`,
'talksys talkman command handling');

  source = replaceOnce(source,
`    mirrorRuntimeLog('CMD', '/leave');
    destroyVoiceConnection({ clearIntent: true });
    await interaction.editReply('TalkSysをボイスチャンネルから退出させました。');`,
`    mirrorRuntimeLog('CMD', '/leave');
    const leavingName = isTalkManMode() ? 'TalkMan' : 'TalkSys';
    destroyVoiceConnection({ clearIntent: true });
    await interaction.editReply(`${leavingName}をボイスチャンネルから退出させました。`);`,
'mode-aware leave');

  return source;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.join(here, 'index.mjs');
const outputPath = path.join(here, '.generated-talkman-index.mjs');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const original = fs.readFileSync(inputPath, 'utf8');
  const generated = buildTalkmanSource(original);
  fs.writeFileSync(outputPath, generated, 'utf8');
  console.log(`[talkman-build] ${TALKMAN_BUILD_REVISION}`);
  console.log(`[talkman-build] source=${inputPath}`);
  console.log(`[talkman-build] output=${outputPath}`);
}
