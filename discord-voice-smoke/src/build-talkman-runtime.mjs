import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalkmanSource } from './build-talkman.mjs';

export const TALKMAN_RUNTIME_HARDENING_REVISION = 'talkman-group-v1-hardening-r4-fast-compact';

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

function talkmanFastReaction(text = '') {
  const value = String(text || '').normalize('NFKC').replace(/\\s+/g, ' ').trim();
  if (!value) return { kind: 'none', text: '', shouldSpeak: false, terminal: false };
  if (/^(?:もしもし|おはよう(?:ございます)?|こんにちは|こんばんは|やあ|どうも)[。！!？?…\\s]*$/iu.test(value)) {
    return { kind: 'talkman-greeting', text: 'お、どうも。', shouldSpeak: true, terminal: true };
  }
  if (/^(?:ありがとう(?:ございます|ございました)?|ありがと|助かった)[。！!？?…\\s]*$/iu.test(value)) {
    return { kind: 'talkman-thanks', text: 'どういたしまして。', shouldSpeak: true, terminal: true };
  }
  if (/(?:迷う|迷って|どっち|どちら|か[、,].{1,40}か)/u.test(value)) {
    return { kind: 'talkman-choice', text: 'その二択、悩むな。', shouldSpeak: true, terminal: false };
  }
  if (/(?:行こうかな|行ってこようかな|やろうかな|しようかな|アリかな)/u.test(value)) {
    return { kind: 'talkman-plan', text: 'それアリ。', shouldSpeak: true, terminal: false };
  }
  if (/[？?]/u.test(value) || /(?:どう|なぜ|なんで|何|どこ|いつ|誰|どれ|ですか|ますか)$/u.test(value)) {
    return { kind: 'talkman-question', text: 'お、そこ来たか。', shouldSpeak: true, terminal: false };
  }
  if (value.length >= 8) {
    return { kind: 'talkman-listening', text: 'うん、聞いてる。', shouldSpeak: true, terminal: false };
  }
  return { kind: 'none', text: '', shouldSpeak: false, terminal: false };
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
    'TalkMan fast reaction and final-answer normalizer',
  );

  source = replaceOnce(
    source,
    `function triggerWebFastReaction(helper, text, source = 'realtime') {
  if (conversationMode === 'talkman') return false;
  const active = helper?.active;`,
    `function triggerWebFastReaction(helper, text, source = 'realtime') {
  const active = helper?.active;`,
    'enable realtime reaction in TalkMan',
  );

  source = replaceOnce(
    source,
    '  const reaction = fastReaction(value);',
    "  const reaction = conversationMode === 'talkman' ? talkmanFastReaction(value) : fastReaction(value);",
    'TalkMan realtime reaction policy',
  );

  source = replaceOnce(
    source,
    "  let reaction = conversationMode === 'talkman' ? null : providedFastReaction;",
    "  let reaction = conversationMode === 'talkman' ? talkmanFastReaction(confirmedTranscript) : providedFastReaction;",
    'TalkMan confirmed reaction policy',
  );

  source = replaceOnce(
    source,
    "    reaction = conversationMode === 'talkman' ? null : fastReaction(realtimeRescue);",
    "    reaction = conversationMode === 'talkman' ? talkmanFastReaction(realtimeRescue) : fastReaction(realtimeRescue);",
    'TalkMan rescued reaction policy',
  );

  source = replaceOnce(
    source,
    "  if (conversationMode !== 'talkman' && answering && captureMetrics?.overlappedBotPlayback) {",
    '  if (answering && captureMetrics?.overlappedBotPlayback) {',
    'TalkMan confirmed overlap preemption',
  );

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

  source = replaceOnce(
    source,
    `  const samples = ['こんにちは', 'ありがとう', '今日の天気を教えて', 'これを調べて', '何時？', 'この内容について詳しく相談したいです'];
  const texts = [...new Set(samples.map((sample) => fastReaction(sample)).filter((r) => r?.shouldSpeak && r?.text).map((r) => r.text))];`,
    `  const samples = ['こんにちは', 'ありがとう', '今日の天気を教えて', 'これを調べて', '何時？', 'この内容について詳しく相談したいです'];
  const talkmanTexts = ['お、どうも。', 'どういたしまして。', 'その二択、悩むな。', 'それアリ。', 'お、そこ来たか。', 'うん、聞いてる。'];
  const texts = [...new Set([...samples.map((sample) => fastReaction(sample)).filter((r) => r?.shouldSpeak && r?.text).map((r) => r.text), ...talkmanTexts])];`,
    'warm TalkMan reaction audio',
  );

  source = replaceOnce(
    source,
    `    if (conversationMode !== 'talkman' && !timeline.fastReactionRequestedAt) {
      activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);
    }`,
    `    if (!timeline.fastReactionRequestedAt) {
      if (conversationMode === 'talkman' && reaction?.shouldSpeak) {
        playWebFastReaction(reaction, utteranceId, sessionEpoch, timeline, confirmedTranscript);
      } else if (conversationMode !== 'talkman') {
        activeWaitCue = startWaitCue(confirmedTranscript, utteranceId, controller.signal, reaction);
      }
    }`,
    'TalkMan confirmed fallback reaction',
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
