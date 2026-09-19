import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeMuLawByte, pcmuBase64ToSamples, samplesToWav } from '../src/telephony/codec.js';
import { buildTexml } from '../src/telephony/protocol.js';

test('PCMU silence decodes and produces valid 8 kHz WAV', () => {
  assert.equal(decodeMuLawByte(0xff), 0);
  const samples = pcmuBase64ToSamples(Buffer.from([0xff, 0xff, 0xff]).toString('base64'));
  assert.equal(samples.length, 3);
  const wav = Buffer.from(samplesToWav(samples, 8000));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 8000);
});

test('TeXML receives PCMU and returns MP3 on the same Telnyx stream', () => {
  const xml = buildTexml({
    host: 'talksys.example.test',
    token: 'secret',
    callId: 'call-1',
    from: '+819012345678',
    to: '+815012345678',
  });
  assert.match(xml, /codec="PCMU"/);
  assert.match(xml, /bidirectionalMode="mp3"/);
  assert.doesNotMatch(xml, /bidirectionalCodec=/);
  assert.match(xml, /wss:\/\/talksys\.example\.test\/telnyx\/media\?token=secret/);
  assert.match(xml, /name="call_id" value="call-1"/);
});

test('integrated entry keeps Telnyx transport but routes phone turns through the shared personalized Gemini runner', () => {
  const source = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
  assert.match(source, /import talksys from '\.\/entry\.js'/);
  assert.match(source, /turn: \(body, signal\) => runTalkSysTurn\(request, env, body, signal \|\| request\.signal, ctx\)/);
  assert.match(source, /const result = await runGeminiTurn\(body \|\| \{\}, env, signal\)/);
  assert.match(source, /scheduleConversationLog\(ctx, env, request, body, result, 'turn', 200\)/);
  assert.match(source, /return talksys\.fetch\(request, env, ctx\)/);
  assert.doesNotMatch(source, /gemini-3\.8-live/i);
  assert.doesNotMatch(source, /BidiGenerateContent/i);
});


test('phone message logging stays off the answer critical path', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /const queueMessageLog = \(role, content\) => trackTask/);
  assert.match(source, /queueMessageLog\('user', stt\.text\);\s*history\.push/);
  assert.match(source, /queueMessageLog\('assistant', turn\.answer\);\s*if \(myVersion !== turnVersion\) return;\s*const spoken = await speak/);
  assert.doesNotMatch(source, /await appendMessage\(env, callId, 'user', stt\.text\)/);
  assert.doesNotMatch(source, /await appendMessage\(env, callId, 'assistant', turn\.answer\)/);
});


test('phone turn sends only prior history and never duplicates the current STT text', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /const lastIsCurrent = last\?\.role === 'user'/);
  assert.match(source, /const priorHistory = \(lastIsCurrent \? history\.slice\(0, -1\) : history\)\.slice\(-16\)/);
  assert.match(source, /deps\.turn\(\{ text: current, history: priorHistory/);
  assert.doesNotMatch(source, /deps\.turn\(\{ text, history: history\.slice\(-16\)/);
});
