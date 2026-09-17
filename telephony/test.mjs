import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMuLawByte, encodeMuLawSample, pcmuBase64ToPcm16Base64, pcmuBase64ToPcm16kBase64 } from './src/codec.js';
import { buildGeminiSetup, buildTexml } from './src/protocol.js';

test('mu-law silence decodes near zero and round-trips to silence', () => {
  assert.equal(decodeMuLawByte(0xff), 0);
  assert.equal(encodeMuLawSample(0), 0xff);
  const pcm16 = Buffer.from(pcmuBase64ToPcm16Base64(Buffer.from([0xff, 0xff]).toString('base64')), 'base64');
  assert.equal(pcm16.length, 4);
  assert.equal(pcm16.readInt16LE(0), 0);
  const pcm16k = Buffer.from(pcmuBase64ToPcm16kBase64(Buffer.from([0xff, 0xff]).toString('base64')), 'base64');
  assert.equal(pcm16k.length, 8);
  assert.equal(pcm16k.readInt16LE(0), 0);
});

test('TeXML uses isolated PCMU bidirectional stream and preserves call metadata', () => {
  const xml = buildTexml({ host: 'phone.example.test', protocol: 'https:', token: 'abc', callSid: 'call-1', from: '+8190123', to: '+8150123' });
  assert.match(xml, /<Connect><Stream/);
  assert.match(xml, /bidirectionalMode="rtp"/);
  assert.match(xml, /bidirectionalCodec="PCMU"/);
  assert.match(xml, /bidirectionalSamplingRate="8000"/);
  assert.match(xml, /wss:\/\/phone\.example\.test\/telnyx\/media\?token=abc/);
  assert.match(xml, /name="call_sid" value="call-1"/);
});

test('Gemini raw WebSocket setup places response modalities in generationConfig', () => {
  const msg = buildGeminiSetup({ GEMINI_LIVE_MODEL: 'gemini-3.8-live' });
  assert.deepEqual(msg.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(msg.setup.model, 'models/gemini-3.8-live');
  assert.equal(msg.setup.inputAudioTranscription, undefined);
  assert.equal(msg.setup.outputAudioTranscription, undefined);
  assert.equal(msg.setup.contextWindowCompression.triggerTokens, '25000');
  assert.equal(msg.setup.contextWindowCompression.slidingWindow.targetTokens, '8000');
  assert.deepEqual(msg.setup.sessionResumption, {});
});

test('transcription is opt-in and resumption handle is passed', () => {
  const msg = buildGeminiSetup({ TELEPHONY_TRANSCRIPTION: 'true' }, 'resume-token');
  assert.deepEqual(msg.setup.inputAudioTranscription, {});
  assert.deepEqual(msg.setup.outputAudioTranscription, {});
  assert.deepEqual(msg.setup.sessionResumption, { handle: 'resume-token' });
});
