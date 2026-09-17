import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMuLawByte, encodeMuLawSample, pcmuBase64ToSamples, rmsOfSamples, samplesToWav } from './src/codec.js';
import { buildTexml } from './src/protocol.js';

test('mu-law silence decodes near zero and round-trips to silence', () => {
  assert.equal(decodeMuLawByte(0xff), 0);
  assert.equal(encodeMuLawSample(0), 0xff);
  const samples = pcmuBase64ToSamples(Buffer.from([0xff, 0xff]).toString('base64'));
  assert.equal(samples.length, 2);
  assert.equal(samples[0], 0);
  assert.equal(rmsOfSamples(samples), 0);
});

test('PCM samples become a valid 8 kHz mono WAV for TalkSys STT', () => {
  const wav = samplesToWav(Int16Array.from([0, 1000, -1000, 0]), 8000);
  const view = new DataView(wav);
  const ascii = (offset, length) => Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(34, true), 16);
});

test('TeXML sends inbound PCMU media to isolated TalkSys gateway', () => {
  const xml = buildTexml({ host: 'phone.example.test', protocol: 'https:', token: 'abc', callSid: 'call-1', from: '+8190123', to: '+8150123' });
  assert.match(xml, /<Connect><Stream/);
  assert.match(xml, /bidirectionalMode="rtp"/);
  assert.match(xml, /bidirectionalCodec="PCMU"/);
  assert.match(xml, /bidirectionalSamplingRate="8000"/);
  assert.match(xml, /wss:\/\/phone\.example\.test\/telnyx\/media\?token=abc/);
  assert.match(xml, /name="call_sid" value="call-1"/);
  assert.match(xml, /name="from" value="\+8190123"/);
  assert.match(xml, /name="to" value="\+8150123"/);
});
