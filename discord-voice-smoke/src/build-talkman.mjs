import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'index.mjs');
const outputPath = path.join(here, 'index-talkman.generated.mjs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) throw new Error(`TalkMan build anchor missing: ${label}`);
  if (first !== last) throw new Error(`TalkMan build anchor is not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceExpected(source, before, after, label, expectedCount) {
  if (!before) throw new Error(`TalkMan build anchor is empty: ${label}`);
  const parts = source.split(before);
  const actualCount = parts.length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(`TalkMan build anchor count mismatch: ${label} expected=${expectedCount} actual=${actualCount}`);
  }
  return parts.join(after);
}

export function buildTalkmanSource(input) {
  let source = String(input || '');

  source = replaceOnce(
    source,
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5';",
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5-talkman-v1';",
    'revision',
  );

  source = replaceOnce(
    source,
    "let activeUserText = '';\nlet activeUserUtteranceId = '';",
    "let activeUserText = '';\nlet activeUserId = '';\nlet activeUserUtteranceId = '';",
    'active user id',
  );

  source = replaceOnce(
    source,
    "const pendingTurns = [];\nlet activeTurnAbortController = null;",
    "const pendingTurns = [];\nlet conversationMode = 'talksys';\nconst TALKMAN_QUEUE_LIMIT = 12;\nlet activeTurnAbortController = null;",
    'mode globals',
  );

  source = replaceExpected(
    source,
    "  activeUserText = '';\n  activeUserUtteranceId = '';",
    "  activeUserText = '';\n  activeUserId = '';\n  activeUserUtteranceId = '';",
    'reset active user id',
    3,
  );

  const helpers = `
function sanitizeTalkmanSpeakerName(value = '', userId = '') {
  const safe = String(value || '')
    .normalize('NFKC')
    .replace(/[^\\p{L}\\p{N}_.-]/gu, '')
    .slice(0, 24);
  return safe || ('member-' + String(userId || '').slice(-4));
}

async function resolveTalkmanSpeakerName(userId = '') {
  const cached = client.users.cache.get(String(userId || ''));
  if (cached?.username) return sanitizeTalkmanSpeakerName(cached.username, userId);
  try {
    const user = await client.users.fetch(String(userId || ''));
    return sanitizeTalkmanSpeakerName(user?.username || '', userId);
  } catch {
    return sanitizeTalkmanSpeakerName('', userId);
  }
}

function buildTalkmanInput(text = '', speakerName = '') {
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
}

function enqueueTalkmanTurn(nextTurn) {
  if (pendingTurns.length >= TALKMAN_QUEUE_LIMIT) {
    const sameSpeakerIndex = pendingTurns.findIndex((item) => String(item?.userId || '') === String(nextTurn?.userId || ''));
    if (sameSpeakerIndex >= 0) pendingTurns.splice(sameSpeakerIndex, 1);
    else pendingTurns.shift();
  }
  pendingTurns.push(nextTurn);
}

`;

  source = replaceOnce(
    source,
    '\nfunction pruneRecentBotSpeech(now = Date.now()) {',
    helpers + 'function pruneRecentBotSpeech(now = Date.now()) {',
    'TalkMan helpers',
  );

  source = replaceOnce(
    source,
    "function triggerWebFastReaction(helper, text, source = 'realtime') {\n  const active = helper?.active;",
    "function triggerWebFastReaction(helper, text, source = 'realtime') {\n  if (conversationMode === 'talkman') return false;\n  const active = helper?.active;",
    'disable realtime reaction in TalkMan',
  );

  source = replaceOnce(
    source,
    '  let reaction = providedFastReaction;',
    "  let reaction = conversationMode === 'talkman' ? null : providedFastReaction;",
    'disable provided reaction in TalkMan',
  );

  source = replaceOnce(
    source,
    '    reaction = fastReaction(realtimeRescue);',
    "    reaction = conversationMode === 'talkman' ? null : fastReaction(realtimeRescue);",
    'disable rescued reaction in TalkMan',
  );

  source = replaceOnce(
    source,
    "  if (answering && activeUserText && sameUtterance(confirmedTranscript, activeUserText)) {",
    "  if (answering && activeUserText && sameUtterance(confirmedTranscript, activeUserText)\n      && (conversationMode !== 'talkman' || String(activeUserId || '') === String(userId || ''))) {",
    'speaker-aware in-flight dedupe',
  );

  source = replaceOnce(
    source,
    "  if (pendingTurns.some((item) => sameUtterance(item?.confirmedTranscript || '', confirmedTranscript))) {",
    "  if (pendingTurns.some((item) => sameUtterance(item?.confirmedTranscript || '', confirmedTranscript)\n      && (conversationMode !== 'talkman' || String(item?.userId || '') === String(userId || '')))) {",
    'speaker-aware queued dedupe',
  );

  source = replaceOnce(
    source,
    '  if (answering && captureMetrics?.overlappedBotPlayback) {',
    "  if (conversationMode !== 'talkman' && answering && captureMetrics?.overlappedBotPlayback) {",
    'TalkMan non-preemptive overlap',
  );

  source = replaceOnce(
    source,
    `  if (answering) {
    const nextTurn = { confirmedTranscript, rawTranscript, correctedTranscript, correctionReason, fastReaction: reaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta };
    if (pendingTurns.length === 0) pendingTurns.push(nextTurn);
    else pendingTurns[0] = nextTurn;
    console.log(\`[queue] buffered latest user=\${userId}: \${confirmedTranscript}\`);
    mirrorRuntimeLog('QUEUE', \`latest only: \${confirmedTranscript}\`);
    return;
  }`,
    `  if (answering) {
    const nextTurn = { confirmedTranscript, rawTranscript, correctedTranscript, correctionReason, fastReaction: reaction, userId, sessionEpoch, utteranceId, timeline, captureMetrics, sttMeta };
    if (conversationMode === 'talkman') {
      enqueueTalkmanTurn(nextTurn);
      console.log(\`[queue] TalkMan FIFO user=\${userId} queued=\${pendingTurns.length}: \${confirmedTranscript}\`);
      mirrorRuntimeLog('QUEUE', \`talkman fifo size=\${pendingTurns.length}: \${confirmedTranscript}\`);
    } else {
      if (pendingTurns.length === 0) pendingTurns.push(nextTurn);
      else pendingTurns[0] = nextTurn;
      console.log(\`[queue] buffered latest user=\${userId}: \${confirmedTranscript}\`);
      mirrorRuntimeLog('QUEUE', \`latest only: \${confirmedTranscript}\`);
    }
    return;
  }`,
    'TalkMan FIFO queue',
  );

  source = replaceOnce(
    source,
    "  activeUserText = confirmedTranscript;\n  activeUserUtteranceId = utteranceId;\n  rememberAcceptedUserTurn(confirmedTranscript, userId, timeline);\n  const pipelineStarted = Date.now();",
    "  activeUserText = confirmedTranscript;\n  activeUserId = String(userId || '');\n  activeUserUtteranceId = utteranceId;\n  rememberAcceptedUserTurn(confirmedTranscript, userId, timeline);\n  const talkmanSpeaker = conversationMode === 'talkman' ? await resolveTalkmanSpeakerName(userId) : '';\n  const conversationalInput = conversationMode === 'talkman' ? buildTalkmanInput(confirmedTranscript, talkmanSpeaker) : confirmedTranscript;\n  if (conversationMode === 'talkman') mirrorRuntimeLog('TALKMAN', `speaker=${talkmanSpeaker}: ${confirmedTranscript}`);\n  const pipelineStarted = Date.now();",
    'TalkMan attributed input',
  );

  source = replaceOnce(
    source,
    '    if (!timeline.fastReactionRequestedAt) {\n      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);\n    }',
    "    if (conversationMode !== 'talkman' && !timeline.fastReactionRequestedAt) {\n      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);\n    }",
    'disable wait cue in TalkMan',
  );

  source = replaceOnce(
    source,
    '    const turn = await talk(confirmedTranscript, utteranceId, controller.signal)',
    '    const turn = await talk(conversationalInput, utteranceId, controller.signal)',
    'TalkMan attributed turn request',
  );

  source = replaceOnce(
    source,
    '      commitConversationTurn(confirmedTranscript, turn);',
    '      commitConversationTurn(conversationalInput, turn);',
    'TalkMan attributed history',
  );

  source = replaceOnce(
    source,
    "    const result = await synthesize('フォーンズです。接続しました。');\n    await playMp3(result.audio, { spokenText: 'フォーンズです。接続しました。', purpose: 'greeting' });",
    "    const greetingText = conversationMode === 'talkman' ? 'トークマンです。みんなの話に混ざります。' : 'フォーンズです。接続しました。';\n    const result = await synthesize(greetingText);\n    await playMp3(result.audio, { spokenText: greetingText, purpose: 'greeting' });",
    'mode greeting',
  );

  source = replaceOnce(
    source,
    "  { name: 'talksys', description: 'TalkSysを現在参加中のVCへ呼び出します' },",
    "  { name: 'talksys', description: 'TalkSysを現在参加中のVCへ呼び出します' },\n  { name: 'talkman', description: 'TalkManグループ雑談モードを現在参加中のVCで開始します' },",
    'TalkMan slash command',
  );

  source = replaceOnce(
    source,
    "      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /logs /leave`);",
    "      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /talkman /logs /leave`);",
    'ready command log',
  );

  source = replaceOnce(
    source,
    "    console.log('[discord] waiting for /talksys from a user in a voice channel');",
    "    console.log('[discord] waiting for /talksys or /talkman from a user in a voice channel');",
    'waiting command log',
  );

  source = replaceOnce(
    source,
    "  if (!['talksys', 'logs', 'logdump', 'leave'].includes(interaction.commandName)) return;",
    "  if (!['talksys', 'talkman', 'logs', 'logdump', 'leave'].includes(interaction.commandName)) return;",
    'interaction allowlist',
  );

  source = replaceOnce(
    source,
    "    if (interaction.commandName === 'talksys') {\n      if (!runtimeLogChannel) await attachRuntimeLogChannel(interaction.channel, { persist: false });\n      mirrorRuntimeLog('CMD', `/talksys by ${interaction.user.tag || interaction.user.id}`);\n      const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);\n      const channelId = voiceState?.channelId;\n      if (!channelId) {\n        await interaction.editReply('先にボイスチャンネルへ参加してから /talksys を実行してください。');\n        return;\n      }\n      const channel = await interaction.guild.channels.fetch(channelId);\n      await connectToVoiceChannel(channel, interaction.user.id);\n      await interaction.editReply(`TalkSysを「${channel.name}」へ接続しました。`);\n      return;\n    }",
    "    if (interaction.commandName === 'talksys' || interaction.commandName === 'talkman') {\n      if (!runtimeLogChannel) await attachRuntimeLogChannel(interaction.channel, { persist: false });\n      const requestedMode = interaction.commandName === 'talkman' ? 'talkman' : 'talksys';\n      const modeChanged = conversationMode !== requestedMode;\n      conversationMode = requestedMode;\n      if (modeChanged) resetConversationState();\n      mirrorRuntimeLog('CMD', `/${interaction.commandName} by ${interaction.user.tag || interaction.user.id} mode=${conversationMode}`);\n      const voiceState = interaction.guild.voiceStates.cache.get(interaction.user.id);\n      const channelId = voiceState?.channelId;\n      if (!channelId) {\n        await interaction.editReply(`先にボイスチャンネルへ参加してから /${interaction.commandName} を実行してください。`);\n        return;\n      }\n      const channel = await interaction.guild.channels.fetch(channelId);\n      await connectToVoiceChannel(channel, interaction.user.id);\n      if (conversationMode === 'talkman') {\n        await interaction.editReply(`TalkManグループ雑談モードを「${channel.name}」で開始しました。/talksys で通常モードへ戻せます。`);\n      } else {\n        await interaction.editReply(`TalkSys通常モードを「${channel.name}」で開始しました。`);\n      }\n      return;\n    }",
    'mode command handler',
  );

  source = replaceOnce(
    source,
    "    mirrorRuntimeLog('CMD', '/leave');\n    destroyVoiceConnection({ clearIntent: true });",
    "    mirrorRuntimeLog('CMD', '/leave');\n    conversationMode = 'talksys';\n    destroyVoiceConnection({ clearIntent: true });",
    'leave resets mode',
  );

  return source;
}

export function buildTalkmanFile() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const built = buildTalkmanSource(source);
  fs.writeFileSync(outputPath, built, 'utf8');
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builtPath = buildTalkmanFile();
  console.log(`[talkman-build] generated ${builtPath}`);
}
