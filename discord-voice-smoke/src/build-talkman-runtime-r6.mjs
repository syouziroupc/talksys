import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { buildTalkmanRuntimeSource } from './build-talkman-runtime.mjs';

export const TALKMAN_RUNTIME_R6_REVISION = 'talkman-group-v1-hardening-r6-log-control';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) throw new Error(`TalkMan R6 anchor missing: ${label}`);
  if (first !== last) throw new Error(`TalkMan R6 anchor is not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const ZIP_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  ZIP_CRC_TABLE[i] = value >>> 0;
}

export function crc32Zip(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  let crc = 0xffffffff;
  for (const byte of data) crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDosTimeDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = Math.max(1, date.getDate());
  const dosDate = (((year - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (day & 0x1f);
  return { time, date: dosDate };
}

export function buildZipArchive(entries, now = new Date()) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = zipDosTimeDate(now);
  let localOffset = 0;

  for (const entry of entries || []) {
    const name = Buffer.from(String(entry?.name || 'log.txt').replace(/[\\/]+/g, '_'), 'utf8');
    const raw = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(entry?.data || []);
    const deflated = deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32Zip(raw);
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const ZIP_RUNTIME_HELPERS = `
const ZIP_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  ZIP_CRC_TABLE[i] = value >>> 0;
}
function crc32Zip(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  let crc = 0xffffffff;
  for (const byte of data) crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipDosTimeDate(value = new Date()) {
  const dateValue = value instanceof Date ? value : new Date(value);
  const year = Math.max(1980, Math.min(2107, dateValue.getFullYear()));
  const time = ((dateValue.getHours() & 0x1f) << 11) | ((dateValue.getMinutes() & 0x3f) << 5) | ((Math.floor(dateValue.getSeconds() / 2)) & 0x1f);
  const day = Math.max(1, dateValue.getDate());
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((dateValue.getMonth() + 1) & 0x0f) << 5) | (day & 0x1f);
  return { time, date: dosDate };
}
function buildZipArchive(entries, now = new Date()) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = zipDosTimeDate(now);
  let localOffset = 0;
  for (const entry of entries || []) {
    const name = Buffer.from(String(entry?.name || 'log.txt').replace(/[\\\\/]+/g, '_'), 'utf8');
    const raw = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(entry?.data || []);
    const deflated = deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32Zip(raw);
    const flags = 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(localOffset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
`;

export function buildTalkmanRuntimeR6Source(input) {
  let source = buildTalkmanRuntimeSource(String(input || ''));

  source = replaceOnce(
    source,
    "import path from 'node:path';",
    "import path from 'node:path';\nimport { deflateRawSync } from 'node:zlib';",
    'zlib import',
  );
  source = replaceOnce(
    source,
    "import { AttachmentBuilder, Client, GatewayIntentBits } from 'discord.js';",
    "import { AttachmentBuilder, Client, GatewayIntentBits, MessageFlags } from 'discord.js';",
    'Discord MessageFlags import',
  );
  source = replaceOnce(
    source,
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5-talkman-v1';",
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5-talkman-v1-r6';",
    'R6 revision',
  );
  source = replaceOnce(
    source,
    'const DISK_LOG_MAX_BYTES = 5 * 1024 * 1024;',
    `const DISK_LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DISCORD_LOG_PENDING = 240;
const LOG_EXPORT_BUDGETS = Object.freeze({ current: 2_500_000, previous: 2_500_000, supervisor: 750_000 });
const supervisorLogFile = path.join(discordLogStateDir, 'supervisor.log');`,
    'bounded log constants',
  );

  source = replaceOnce(
    source,
    `async function exportRuntimeLogs() {
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
    all = Buffer.concat([Buffer.from('[Older runtime log truncated for Discord upload]\\n'), all.subarray(all.length - 6_900_000)]);
  }
  return all.length ? all : Buffer.from('No TalkSys runtime logs were available.\\n');
}`,
    `${ZIP_RUNTIME_HELPERS}
async function flushRuntimeLogsForExport() {
  if (diskLogFlushTimer) clearTimeout(diskLogFlushTimer);
  diskLogFlushTimer = null;
  for (let i = 0; i < 20 && diskLogQueue.length; i += 1) {
    if (diskLogFlushBusy) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      continue;
    }
    await flushRuntimeLogsToDisk();
  }
}
async function readLogTail(filename, maxBytes) {
  try {
    const stat = await fs.promises.stat(filename);
    const wanted = Math.min(Math.max(0, Number(maxBytes) || 0), stat.size);
    if (!wanted) return { data: Buffer.alloc(0), originalBytes: stat.size, truncated: stat.size > 0 };
    const fd = await fs.promises.open(filename, 'r');
    try {
      const data = Buffer.alloc(wanted);
      const start = Math.max(0, stat.size - wanted);
      const result = await fd.read(data, 0, wanted, start);
      return { data: data.subarray(0, result.bytesRead), originalBytes: stat.size, truncated: start > 0 };
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
async function exportRuntimeLogsZip() {
  await flushRuntimeLogsForExport();
  const specs = [
    { path: discordLogFile, name: 'discord-runtime.log', budget: LOG_EXPORT_BUDGETS.current },
    { path: discordLogPreviousFile, name: 'discord-runtime.previous.log', budget: LOG_EXPORT_BUDGETS.previous },
    { path: supervisorLogFile, name: 'supervisor.log', budget: LOG_EXPORT_BUDGETS.supervisor },
  ];
  const entries = [];
  const manifest = [];
  for (const spec of specs) {
    const read = await readLogTail(spec.path, spec.budget);
    if (!read) continue;
    entries.push({ name: spec.name, data: read.data });
    manifest.push(spec.name + ': exported=' + read.data.length + ' original=' + read.originalBytes + ' truncated=' + read.truncated);
  }
  if (!entries.length) entries.push({ name: 'no-logs.txt', data: Buffer.from('No TalkSys runtime logs were available.\\n') });
  entries.push({ name: 'log-export-info.txt', data: Buffer.from((manifest.length ? manifest.join('\\n') : 'No log files found.') + '\\n') });
  return buildZipArchive(entries);
}
async function clearRuntimeLogs() {
  await flushRuntimeLogsForExport();
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const filename of [discordLogFile, discordLogPreviousFile, supervisorLogFile]) {
    try {
      const stat = await fs.promises.stat(filename);
      deletedBytes += stat.size;
      await fs.promises.rm(filename, { force: true });
      deletedFiles += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  runtimeLogLines.splice(0, runtimeLogLines.length);
  diskLogQueue.splice(0, diskLogQueue.length);
  discordLogQueue.splice(0, discordLogQueue.length);
  return { deletedFiles, deletedBytes };
}`,
    'ZIP log export and clear',
  );

  source = replaceOnce(
    source,
    `function nextDiscordLogBatch() {
  if (!discordLogQueue.length) return { body: '', count: 0 };`,
    `function mirrorRuntimeLogDiskOnly(kind, message) {
  const value = sanitizeLogText(message).slice(0, 24000);
  if (!value) return;
  const stamp = new Date().toISOString();
  for (let i = 0; i < value.length; i += 1100) {
    const line = \`${'${stamp}'} [\${kind}\${i ? '-CONT' : ''}] \${value.slice(i, i + 1100)}\`;
    runtimeLogLines.push(line);
    if (runtimeLogLines.length > 300) runtimeLogLines.splice(0, runtimeLogLines.length - 300);
    diskLogQueue.push(line);
  }
  scheduleDiskLogFlush();
}

function nextDiscordLogBatch() {
  if (!discordLogQueue.length) return { body: '', count: 0 };`,
    'disk-only log helper',
  );

  source = replaceOnce(
    source,
    `  } catch (error) {
    discordLogSendFailCount += 1;
    mirrorRuntimeLog('LOG-ERROR', 'Discord log send failed code='
      + String(error?.code || error?.status || 'unknown')
      + ' retry=' + discordLogSendFailCount);
  } finally {`,
    `  } catch (error) {
    discordLogSendFailCount += 1;
    const errorCode = String(error?.code || error?.status || 'unknown');
    mirrorRuntimeLogDiskOnly('LOG-ERROR', 'Discord log send failed code=' + errorCode + ' retry=' + discordLogSendFailCount);
    if (discordLogSendFailCount >= 3) {
      const dropped = discordLogQueue.length;
      discordLogQueue.splice(0, discordLogQueue.length);
      runtimeLogChannel = null;
      mirrorRuntimeLogDiskOnly('LOG-DISABLED', 'Live Discord log forwarding detached after 3 failures; dropped=' + dropped + '. Disk logging continues. Run /logs to reattach.');
      process.stderr.write('[discord-log] live forwarding disabled after repeated send failures; disk logging continues\\n');
    }
  } finally {`,
    'no recursive live-log failure',
  );

  source = replaceOnce(
    source,
    `    diskLogQueue.push(line);
    discordLogQueue.push(line);
  }
  if (discordLogQueue.length > 2000) {
    discordLogQueue.splice(0, discordLogQueue.length - 1999);
    discordLogQueue.unshift('[LOG] Discord backlog exceeded 2000 lines; full retained logs in /logdump');
  }`,
    `    diskLogQueue.push(line);
    if (runtimeLogChannel) discordLogQueue.push(line);
  }
  if (discordLogQueue.length > MAX_DISCORD_LOG_PENDING) {
    const dropped = discordLogQueue.length - (MAX_DISCORD_LOG_PENDING - 1);
    discordLogQueue.splice(0, dropped);
    discordLogQueue.unshift('[LOG] dropped ' + dropped + ' old live lines; full logs retained on disk for /logdump');
  }`,
    'bounded live log queue',
  );

  source = replaceOnce(
    source,
    `connection.receiver.speaking.on('start', (userId) => {
    if (userId === client.user.id) return;`,
    `connection.receiver.speaking.on('start', (userId) => {
    if (userId === client.user.id) return;
    const member = channel.members?.get?.(userId) || channel.guild.members.cache.get(userId);
    if (member?.user?.bot) {
      mirrorRuntimeLog('CAPTURE-SKIP', \`bot user=\${userId}\`);
      return;
    }
    if (member?.voice?.channelId && member.voice.channelId !== channel.id) {
      mirrorRuntimeLog('CAPTURE-SKIP', \`other channel user=\${userId}\`);
      return;
    }`,
    'skip irrelevant decode streams',
  );

  source = replaceOnce(
    source,
    `  if (initialUserId && initialUserId !== client.user.id) {
    ensureRealtimeHelper(initialUserId);
    startReceiverSession(initialUserId, false);
  }`,
    `  if (initialUserId && initialUserId !== client.user.id) {
    ensureRealtimeHelper(initialUserId);
    if (conversationMode !== 'talkman') startReceiverSession(initialUserId, false);
  }`,
    'TalkMan no empty decoder prearm',
  );

  source = replaceOnce(
    source,
    `      const channel = await interaction.guild.channels.fetch(channelId);
      await connectToVoiceChannel(channel, interaction.user.id);
      if (modeChanged && !discordSessionId) {`,
    `      const channel = await interaction.guild.channels.fetch(channelId);
      if (conversationMode === 'talkman') ensureRealtimeHelper(interaction.user.id);
      const voiceConnectStartedAt = Date.now();
      await connectToVoiceChannel(channel, interaction.user.id);
      mirrorRuntimeLog('VOICE-CONNECT', \`command-ready=\${Date.now() - voiceConnectStartedAt}ms mode=\${conversationMode}\`);
      if (modeChanged && !discordSessionId) {`,
    'overlap TalkMan realtime helper startup',
  );

  source = replaceOnce(
    source,
    "  { name: 'logdump', description: 'TalkSysのログを1つのテキストファイルで取得します' },",
    "  { name: 'logdump', description: 'TalkSysの現在・過去ログをZIPで取得します' },\n  { name: 'logclear', description: 'TalkSysの保存済みログを削除します' },",
    'log management commands',
  );
  source = replaceOnce(
    source,
    "  if (!['talksys', 'talkman', 'logs', 'logdump', 'leave'].includes(interaction.commandName)) return;",
    "  if (!['talksys', 'talkman', 'logs', 'logdump', 'logclear', 'leave'].includes(interaction.commandName)) return;",
    'logclear allowlist',
  );
  source = replaceOnce(
    source,
    '    await interaction.deferReply({ ephemeral: true });',
    '    await interaction.deferReply({ flags: MessageFlags.Ephemeral });',
    'non-deprecated ephemeral reply',
  );
  source = replaceOnce(
    source,
    "      const data = await exportRuntimeLogs();\n      const filename = 'talksys-discord-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';",
    "      const data = await exportRuntimeLogsZip();\n      const filename = 'talksys-discord-' + new Date().toISOString().replace(/[:.]/g, '-') + '.zip';",
    'ZIP logdump output',
  );
  source = replaceOnce(
    source,
    "        content: 'ログを1つのテキストファイルにまとめました。ファイルを開けば全選択してコピーできます。',",
    "        content: '現在ログ・前回ログ・SupervisorログをZIPにまとめました。大きいログは末尾を優先して収録します。',",
    'ZIP logdump reply',
  );
  source = replaceOnce(
    source,
    `    if (interaction.commandName === 'talksys' || interaction.commandName === 'talkman') {`,
    `    if (interaction.commandName === 'logclear') {
      const owner = readPersistedRuntimeLogOwnerId();
      if (!owner) {
        await interaction.editReply('専用ログチャンネルで一度 /logs を実行してください。');
        return;
      }
      if (owner !== interaction.user.id) {
        await interaction.editReply('ログ設定者のみ削除できます。');
        return;
      }
      const cleared = await clearRuntimeLogs();
      await interaction.editReply('保存済みログを削除しました。files=' + cleared.deletedFiles + ' bytes=' + cleared.deletedBytes + '。ログ設定自体は維持しています。');
      return;
    }

    if (interaction.commandName === 'talksys' || interaction.commandName === 'talkman') {`,
    'logclear handler',
  );
  source = replaceOnce(
    source,
    "      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /talkman /logs /leave`);",
    "      console.log(`[discord] slash commands ready guild=${guild.name}: /talksys /talkman /logs /logdump /logclear /leave`);",
    'ready command list',
  );

  return source;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'index.mjs');
const canonicalSourcePath = path.join(here, 'index-classic-base.mjs');
const outputPath = path.join(here, 'index-talkman.generated.mjs');

export function buildTalkmanRuntimeR6File() {
  const workingSource = fs.readFileSync(sourcePath, 'utf8');
  const canonicalSource = fs.readFileSync(canonicalSourcePath, 'utf8');
  let built;
  try {
    built = buildTalkmanRuntimeR6Source(workingSource);
  } catch (error) {
    const workingHasTalkmanMarkers = ["let activeUserId = '';", "let conversationMode = 'talksys';", "name: 'talkman'"].some((marker) => workingSource.includes(marker));
    if (!workingHasTalkmanMarkers) throw error;
    console.warn(`[talkman-r6-build] partial TalkMan working tree detected; using canonical classic base (${String(error?.message || error)})`);
    built = buildTalkmanRuntimeR6Source(canonicalSource);
  }
  fs.writeFileSync(outputPath, built, 'utf8');
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builtPath = buildTalkmanRuntimeR6File();
  console.log(`[talkman-r6-build] ${TALKMAN_RUNTIME_R6_REVISION}`);
  console.log(`[talkman-r6-build] generated ${builtPath}`);
}
