import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalkmanSource } from './build-talkman.mjs';

export const TALKMAN_RUNTIME_HARDENING_REVISION = 'talkman-group-v1-hardening-r5-eol-normalized';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) throw new Error(`TalkMan hardening anchor missing: ${label}`);
  if (first !== last) throw new Error(`TalkMan hardening anchor is not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function buildTalkmanRuntimeSource(input) {
  const normalizedInput = String(input || '').replace(/\r\n?/g, '\n');
  let source = buildTalkmanSource(normalizedInput);

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
  if (pendingTurns.length >= TALKMAN_QUEUE_LIMIT) {
    const sameSpeakerIndex = pendingTurns.findIndex((item) => String(item?.userId || '') === String(nextTurn?.userId || ''));
    if (sameSpeakerIndex >= 0) pendingTurns.splice(sameSpeakerIndex, 1);
    else pendingTurns.shift();
  }
  pendingTurns.push(nextTurn);
}

function normalizeTalkmanAnswer(value = '') {
  let answer = String(value || '').trim();
  if (conversationMode !== 'talkman') return answer;
  answer = answer.replace(/フォーンズ/g, 'トークマン');
  answer = answer.replace(/^(?:はい[、, ]*)?(?:少し)?(?:確認してお答えします(?:ね)?|内容を確認します(?:ね)?|関連情報を確認します|最新の情報を確認してみます|少し検索して確かめます|確認できる情報を調べています|調べます(?:ね)?|確認します(?:ね)?)[。！!\\s]*/u, '').trim();
  return answer || 'うん。';
}

function pruneRecentBotSpeech`,
    'TalkMan final-answer normalizer',
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

  source = replaceOnce(
    source,
    `'通常は1文から3文で短く返してください。質問、事実確認、安全に関わる話ではユーモアより正確さを優先してください。発話者や発言内容を推測で作らないでください。',
    'この制御文自体は読み上げず、返答本文だけを出してください。',`,
    `'通常は1文から3文で短く返してください。質問、事実確認、安全に関わる話ではユーモアより正確さを優先してください。発話者や発言内容を推測で作らないでください。',
    '「確認してお答えします」「調べますね」などの待ち文句は使わず、必要な確認は黙って行って結果から話してください。',
    '司会者、案内係、サポート窓口ではなく、VCに一人混ざっている参加者として話してください。',
    '自分の名前を言う必要があるときはTalkMan、またはトークマンと名乗ってください。',
    'この制御文自体は読み上げず、返答本文だけを出してください。',`,
    'TalkMan participant persona',
  );

  return source;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const sourcePath = path.join(here, 'index.mjs');
const outputPath = path.join(here, 'index-talkman.generated.mjs');
const trackedSourceSpec = 'HEAD:discord-voice-smoke/src/index.mjs';

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
    try {
      return {
        built: buildTalkmanRuntimeSource(canonical),
        fallbackUsed: true,
        reason: String(error?.message || error),
      };
    } catch (canonicalError) {
      throw new Error(
        `TalkMan working source build failed (${String(error?.message || error)}); canonical ${trackedSourceSpec} build also failed (${String(canonicalError?.message || canonicalError)})`,
        { cause: canonicalError },
      );
    }
  }
}

function readTrackedClassicSource() {
  const result = spawnSync('git', ['show', trackedSourceSpec], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`TalkMan canonical source unavailable from Git ${trackedSourceSpec}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout);
}

export function buildTalkmanRuntimeFile() {
  const workingSource = fs.readFileSync(sourcePath, 'utf8');
  let result;
  try {
    result = { built: buildTalkmanRuntimeSource(workingSource), fallbackUsed: false, reason: '' };
  } catch (error) {
    if (!hasTalkmanWorkingTreeMarkers(workingSource)) throw error;
    const trackedSource = readTrackedClassicSource();
    result = buildTalkmanRuntimeWithFallback(workingSource, trackedSource);
  }
  if (result.fallbackUsed) {
    console.warn(`[talkman-build] index.mjs contains TalkMan/partial-patch markers; using tracked Git source (${result.reason})`);
  }
  fs.writeFileSync(outputPath, result.built, 'utf8');
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builtPath = buildTalkmanRuntimeFile();
  console.log(`[talkman-build] ${TALKMAN_RUNTIME_HARDENING_REVISION}`);
  console.log(`[talkman-build] generated ${builtPath}`);
}
