import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { samplesToWav } from '../src/telephony/codec.js';
import { analyzeWav, normalizeQuietPhoneWav } from '../src/stt-v45.js';
import {
  phoneInputCalibrationEstimate,
  PHONE_INPUT_CALIBRATION_FRAMES,
  PHONE_INPUT_NOISY_FLOOR,
  PHONE_ACK_LATENCY_REVISION,
  PHONE_RELEASE_VERSION,
} from '../src/telephony/index.js';

function toneWav(amplitude = 200, seconds = 1, hz = 220) {
  const sampleRate = 8000;
  const samples = new Int16Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sin(2 * Math.PI * hz * i / sampleRate) * amplitude);
  return samplesToWav(samples, sampleRate);
}

test('v127 calibration waits for the full 3-second frame budget', () => {
  const result = phoneInputCalibrationEstimate(Array(149).fill(0.0012));
  assert.equal(PHONE_INPUT_CALIBRATION_FRAMES, 150);
  assert.equal(result.ready, false);
  assert.equal(result.mode, 'pending');
});

test('v127 calibration keeps a clean phone on the untouched v125 path despite speech spikes', () => {
  const frames = Array(150).fill(0).map((_, i) => i % 10 === 0 ? 0.012 : 0.0013);
  const result = phoneInputCalibrationEstimate(frames);
  assert.equal(result.ready, true);
  assert.equal(result.mode, 'clean');
  assert.ok(result.floor < PHONE_INPUT_NOISY_FLOOR);
});

test('v127 calibration classifies persistent high background as noisy', () => {
  const frames = Array(150).fill(0).map((_, i) => 0.0042 + (i % 7) * 0.00008);
  const result = phoneInputCalibrationEstimate(frames);
  assert.equal(result.ready, true);
  assert.equal(result.mode, 'noisy');
  assert.ok(result.floor >= PHONE_INPUT_NOISY_FLOOR);
});

test('clean/pending normalization preserves the v125 legacy 2.5x ceiling', () => {
  const wav = toneWav(200);
  const metrics = analyzeWav(wav);
  const legacy = normalizeQuietPhoneWav(wav, metrics, { inputMode: 'clean', noiseFloor: 0.001 });
  assert.ok(Math.abs(legacy.gain - 2.5) < 1e-9, `gain=${legacy.gain}`);
});

test('noisy low-SNR captures are never amplified', () => {
  const wav = toneWav(200);
  const metrics = analyzeWav(wav);
  const noisy = normalizeQuietPhoneWav(wav, metrics, { inputMode: 'noisy', noiseFloor: Math.max(0.0001, metrics.rms / 2) });
  assert.equal(noisy.gain, 1);
  assert.equal(noisy.gainDb, 0);
  assert.ok(noisy.snrDb < 10);
});

test('noisy but intelligible captures are capped to safe gain, never above +6 dB', () => {
  const wav = toneWav(200);
  const metrics = analyzeWav(wav);
  const noisy = normalizeQuietPhoneWav(wav, metrics, { inputMode: 'noisy', noiseFloor: 0.0005 });
  assert.ok(noisy.gainDb > 0);
  assert.ok(noisy.gainDb <= 6.01, `gainDb=${noisy.gainDb}`);
});

test('v127 keeps v125 conversation scheduling and gates Speex to noisy calls only', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.equal(PHONE_RELEASE_VERSION, 'v127');
  assert.equal(PHONE_ACK_LATENCY_REVISION, 'talksys-phone-ack-latency-v120-r1');
  assert.match(source, /slowAckArmed/);
  assert.match(source, /phoneNoiseSuppressor&&!assistantPlaying&&phoneInputMode==='noisy'/);
  assert.doesNotMatch(source, /talksys-phone-ack-latency-v126-restored-r1/);
  assert.doesNotMatch(source, /slowAckStarted/);
});
