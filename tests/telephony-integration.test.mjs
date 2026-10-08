import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeMuLawByte, pcmuBase64ToSamples, samplesToWav } from '../src/telephony/codec.js';
import { buildTexml } from '../src/telephony/protocol.js';
import {
  PHONE_TTS_BIT_RATE,
  PHONE_TTS_DEFAULT_VOICE,
  PHONE_TTS_MODEL,
  PHONE_TTS_SAMPLE_RATE,
  phoneTtsVoice,
  synthesizeGrokPhoneMp3,
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


test('telephone transport shares the 900ms voice end policy and duplicate suppression', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /WEB_VOICE_CAPTURE_POLICY\.silenceMs/);
  assert.match(source, /sameUtterance\(stt\.text, lastAcceptedUserText\)/);
  assert.match(source, /phone_duplicate_suppressed/);
  assert.match(source, /talksys-telephony-v85-grok-phone-tts/);
});

test('telephone outbound TTS is pluggable without replacing Telnyx media transport', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /typeof deps\?\.synthesize === 'function'/);
  assert.match(source, /synthesizeMp3\(env, text, deps\)/);
  assert.match(source, /pluggableTts: true/);
});

test('phone TTS uses Cloudflare Grok with the MP3 format proven compatible with Telnyx', async () => {
  assert.equal(PHONE_TTS_MODEL, 'xai/grok-tts');
  assert.equal(PHONE_TTS_SAMPLE_RATE, 24000);
  assert.equal(PHONE_TTS_BIT_RATE, 64000);
  assert.equal(PHONE_TTS_DEFAULT_VOICE, 'ara');
  assert.equal(phoneTtsVoice({}), 'ara');
  assert.equal(phoneTtsVoice({ TELEPHONY_TTS_VOICE: 'REX' }), 'rex');
  assert.equal(phoneTtsVoice({ TELEPHONY_TTS_VOICE: 'unknown' }), 'ara');

  const aiCalls = [];
  const fetchCalls = [];
  const env = {
    AI: {
      async run(model, input) {
        aiCalls.push({ model, input });
        return { state: 'Completed', result: { audio: 'https://audio.example.test/phone.mp3' } };
      },
    },
  };
  const fakeAudio = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const result = await synthesizeGrokPhoneMp3(env, 'PCは128GBです。', async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeAudio.buffer.slice(0),
    };
  });

  assert.equal(result.byteLength, fakeAudio.byteLength);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].model, 'xai/grok-tts');
  assert.equal(aiCalls[0].input.language, 'ja');
  assert.equal(aiCalls[0].input.voice_id, 'ara');
  assert.deepEqual(aiCalls[0].input.output_format, {
    codec: 'mp3',
    sample_rate: 24000,
    bit_rate: 64000,
  });
  assert.equal(aiCalls[0].input.text_normalization, false);
  assert.match(aiCalls[0].input.text, /パソコン/);
  assert.match(aiCalls[0].input.text, /128ギガバイト/);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://audio.example.test/phone.mp3');
  assert.equal(fetchCalls[0].options.headers.accept, 'audio/mpeg');
});

test('phone TTS no longer depends on direct Deepgram credentials or Melo output', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /DEEPGRAM_API_KEY/);
  assert.doesNotMatch(source, /new CloudflareJapaneseTTS/);
  assert.match(source, /normalizeJapaneseTtsText/);
  assert.match(source, /Cloudflare Grok TTS MP3 24kHz\/64kbps/);
});
