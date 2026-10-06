import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeMuLawByte, pcmuBase64ToSamples, samplesToWav } from '../src/telephony/codec.js';
import { buildTexml } from '../src/telephony/protocol.js';
import {
  DEFAULT_DEEPGRAM_PHONE_VOICE,
  DEEPGRAM_PHONE_BIT_RATE,
  DEEPGRAM_PHONE_SAMPLE_RATE,
  deepgramPhoneTtsConfigured,
  deepgramPhoneTtsModel,
  synthesizeDeepgramPhoneMp3,
} from '../src/telephony/index.js';

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
  assert.match(source, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.match(source, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(source, /scheduleConversationLog\(ctx, env, request, commonBody, result, 'turn', 200\)/);
  assert.match(source, /return talksys\.fetch\(request, env, ctx\)/);
  assert.doesNotMatch(source, /gemini-3\.8-live/i);
  assert.doesNotMatch(source, /BidiGenerateContent/i);
});


test('phone message logging stays off the answer critical path', () => {
  const source = fs.readFileSync(new URL('../src/telephony/runtime.js', import.meta.url), 'utf8');
  assert.match(source, /const queueMessageLog = \(role, content\) => trackTask/);
  assert.match(source, /queueMessageLog\('user', stt\.text\);\s*history\.push/);
  assert.match(source, /queueMessageLog\('assistant', turn\.answer\);\s*if \(myVersion !== turnVersion\) return;\s*const spoken = await speak/);
  assert.doesNotMatch(source, /await appendMessage\(env, callId, 'user', stt\.text\)/);
  assert.doesNotMatch(source, /await appendMessage\(env, callId, 'assistant', turn\.answer\)/);
});


test('phone turn sends only prior history and never duplicates the current STT text', () => {
  const source = fs.readFileSync(new URL('../src/telephony/runtime.js', import.meta.url), 'utf8');
  assert.match(source, /const lastIsCurrent = last\?\.role === 'user'/);
  assert.match(source, /const priorHistory = \(lastIsCurrent \? history\.slice\(0, -1\) : history\)\.slice\(-16\)/);
  assert.match(source, /deps\.turn\(\{ text: current, history: priorHistory/);
  assert.doesNotMatch(source, /deps\.turn\(\{ text, history: history\.slice\(-16\)/);
});


test('telephone transport shares the voice end policy and duplicate suppression', () => {
  const runtime = fs.readFileSync(new URL('../src/telephony/runtime.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(runtime, /WEB_VOICE_CAPTURE_POLICY\.silenceMs/);
  assert.match(runtime, /sameUtterance\(stt\.text, lastAcceptedUserText\)/);
  assert.match(runtime, /phone_duplicate_suppressed/);
  assert.match(entry, /talksys-telephony-v85-deepgram-phone-tts/);
});

test('telephone outbound TTS remains pluggable without replacing Telnyx media transport', () => {
  const runtime = fs.readFileSync(new URL('../src/telephony/runtime.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(runtime, /typeof deps\?\.synthesize === 'function'/);
  assert.match(runtime, /synthesizeMp3\(env, text, deps\)/);
  assert.match(runtime, /pluggableTts: true/);
  assert.match(entry, /runtime\.handleTelephonyRequest\(request, env, ctx, effectiveDeps\)/);
});

test('Deepgram phone TTS is disabled until the Worker secret exists', () => {
  assert.equal(deepgramPhoneTtsConfigured({}), false);
  assert.equal(deepgramPhoneTtsConfigured({ DEEPGRAM_API_KEY: '  test-key  ' }), true);
  assert.equal(deepgramPhoneTtsModel({}), DEFAULT_DEEPGRAM_PHONE_VOICE);
  assert.equal(deepgramPhoneTtsModel({ TELEPHONY_TTS_MODEL: 'aura-2-uzume-ja' }), 'aura-2-uzume-ja');
});

test('Deepgram phone TTS requests 24 kHz low-bitrate MP3 without exposing the key in the URL', async () => {
  const calls = [];
  const fakeMp3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const audio = await synthesizeDeepgramPhoneMp3(
    { DEEPGRAM_API_KEY: 'secret-test-key' },
    'もしもし。音声テストです。',
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeMp3.buffer.slice(0),
      };
    },
  );

  assert.equal(audio.byteLength, fakeMp3.byteLength);
  assert.equal(calls.length, 1);
  const call = calls[0];
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v1/speak');
  assert.equal(url.searchParams.get('model'), DEFAULT_DEEPGRAM_PHONE_VOICE);
  assert.equal(url.searchParams.get('encoding'), 'mp3');
  assert.equal(url.searchParams.get('sample_rate'), String(DEEPGRAM_PHONE_SAMPLE_RATE));
  assert.equal(url.searchParams.get('bit_rate'), String(DEEPGRAM_PHONE_BIT_RATE));
  assert.equal(url.href.includes('secret-test-key'), false);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, 'Token secret-test-key');
  assert.deepEqual(JSON.parse(call.options.body), { text: 'もしもし。音声テストです。' });
});

test('Deepgram phone TTS fails closed instead of silently falling back to broken Melo audio', async () => {
  await assert.rejects(
    () => synthesizeDeepgramPhoneMp3({}, 'test', async () => { throw new Error('fetch must not run'); }),
    /deepgram_api_key_missing/,
  );
  await assert.rejects(
    () => synthesizeDeepgramPhoneMp3(
      { DEEPGRAM_API_KEY: 'secret-test-key' },
      'test',
      async () => ({ ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) }),
    ),
    /deepgram_tts_http_401/,
  );
});
