import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import {
  buildTalkmanRuntimeR6Source,
  buildZipArchive,
  crc32Zip,
} from '../discord-voice-smoke/src/build-talkman-runtime-r6.mjs';

const classicBase = fs.readFileSync(
  path.resolve('discord-voice-smoke/src/index-classic-base.mjs'),
  'utf8',
);

function readFirstZipEntry(zip) {
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature');
  const method = zip.readUInt16LE(8);
  const crc = zip.readUInt32LE(14);
  const compressedBytes = zip.readUInt32LE(18);
  const rawBytes = zip.readUInt32LE(22);
  const nameBytes = zip.readUInt16LE(26);
  const extraBytes = zip.readUInt16LE(28);
  const nameStart = 30;
  const dataStart = nameStart + nameBytes + extraBytes;
  const payload = zip.subarray(dataStart, dataStart + compressedBytes);
  const raw = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
  return {
    method,
    crc,
    rawBytes,
    name: zip.subarray(nameStart, nameStart + nameBytes).toString('utf8'),
    raw,
  };
}

test('CRC32 matches the standard ZIP known vector', () => {
  assert.equal(crc32Zip(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP builder emits a readable local entry and central directory', () => {
  const original = Buffer.from('TalkSys runtime log\n'.repeat(200));
  const zip = buildZipArchive([
    { name: 'discord-runtime.log', data: original },
  ], new Date('2026-10-10T12:34:56Z'));

  const entry = readFirstZipEntry(zip);
  assert.equal(entry.name, 'discord-runtime.log');
  assert.deepEqual(entry.raw, original);
  assert.equal(entry.rawBytes, original.length);
  assert.equal(entry.crc, crc32Zip(original));
  assert.ok(entry.method === 0 || entry.method === 8);

  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50, 'end of central directory signature');
  assert.equal(zip.readUInt16LE(eocdOffset + 10), 1, 'central directory entry count');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50, 'central directory signature');
});

test('R6 generated runtime preserves R5 safety and adds bounded log controls', () => {
  const generated = buildTalkmanRuntimeR6Source(classicBase);

  assert.match(generated, /talksys-discord-bridge-v92-resilience-r5-talkman-v1-r6/);
  assert.match(generated, /const confirmMs = conversationMode === 'talkman' \? 600 : BARGE_IN_CONFIRM_MS;/);
  assert.match(generated, /recovery=\$\{recovery\.count\}\/3/);
  assert.match(generated, /scheduleFullReconnect\('decoder-invalid-packet', 250\)/);
  assert.match(generated, /conversationMode !== 'talkman'\) await playConnectionGreeting\(\)/);

  assert.match(generated, /MAX_DISCORD_LOG_PENDING = 240/);
  assert.match(generated, /if \(runtimeLogChannel\) discordLogQueue\.push\(line\)/);
  assert.doesNotMatch(generated, /mirrorRuntimeLog\('LOG-ERROR', 'Discord log send failed code='/);
  assert.match(generated, /runtimeLogChannel = null;/);
  assert.match(generated, /Run \/logs to reattach/);

  assert.match(generated, /name: 'logclear'/);
  assert.match(generated, /exportRuntimeLogsZip\(\)/);
  assert.match(generated, /\.zip'/);
  assert.match(generated, /supervisor\.log/);

  assert.match(generated, /if \(member\?\.user\?\.bot\)/);
  assert.match(generated, /if \(conversationMode !== 'talkman'\) startReceiverSession\(initialUserId, false\)/);
  assert.match(generated, /if \(conversationMode === 'talkman'\) ensureRealtimeHelper\(interaction\.user\.id\)/);
  assert.match(generated, /MessageFlags\.Ephemeral/);
});

test('R6 generated runtime passes node syntax check', () => {
  const generated = buildTalkmanRuntimeR6Source(classicBase);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talksys-r6-'));
  const file = path.join(dir, 'index-talkman.generated.mjs');
  fs.writeFileSync(file, generated, 'utf8');
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'node --check failed');
});
