import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneNoiseSuppressor, PHONE_NOISE_SUPPRESSION_REVISION } from '../src/telephony/phone-noise-suppressor.js';

function frame(seed = 1, voice = 0) {
  let x = seed >>> 0;
  const out = new Int16Array(160);
  for (let i = 0; i < out.length; i += 1) {
    x = (1664525 * x + 1013904223) >>> 0;
    const noise = ((x / 0xffffffff) * 2 - 1) * 650;
    const tone = voice ? Math.sin(2 * Math.PI * 220 * i / 8000) * voice : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(noise + tone)));
  }
  return out;
}

function rms(v) { let sum = 0; for (const n of v) sum += n * n; return Math.sqrt(sum / Math.max(1, v.length)); }

test('Speex phone suppressor keeps the v124 8 kHz / 20 ms, fail-open, and low-latency contract', async () => {
  assert.match(PHONE_NOISE_SUPPRESSION_REVISION, /^talksys-phone-speex-v\d+/);
  const ns = await createPhoneNoiseSuppressor();
  const invalid = ns.process(new Int16Array(80));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.samples.length, 80);

  // Warm state before timing.
  for (let i = 0; i < 80; i += 1) ns.process(frame(i, i > 40 ? 1200 : 0));
  let elapsed = 0;
  let max = 0;
  let noiseBefore = 0;
  let noiseAfter = 0;
  for (let i = 0; i < 1200; i += 1) {
    const input = frame(i + 1000, i % 5 === 0 ? 900 : 0);
    if (i < 200) noiseBefore += rms(input);
    const out = ns.process(input);
    assert.equal(out.ok, true);
    assert.equal(out.samples.length, 160);
    elapsed += out.elapsedMs;
    max = Math.max(max, out.elapsedMs);
    if (i < 200) noiseAfter += rms(out.samples);
  }
  const avg = elapsed / 1200;
  assert.ok(avg < 2.0, `average frame CPU ${avg.toFixed(3)} ms exceeds 2ms budget`);
  assert.ok(max < 20, `single frame CPU ${max.toFixed(3)} ms exceeds one 20ms frame`);
  assert.ok(noiseAfter < noiseBefore, 'stationary noise should be attenuated after warm-up');
  ns.destroy();
});

test('telephony source keeps answer/TTS path untouched and isolates suppression before VAD', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile('src/telephony/index.js', 'utf8'));
  assert.match(source, /createPhoneNoiseSuppressor/);
  assert.match(source, /answerWithTalkSys\(deps,stt\.text,history,controller\.signal,spokenBackchannel/);
  assert.match(source, /speak\(turn\.answer, \{ purpose: 'answer'/);
  assert.match(source, /if\(assistantPlaying\).*bargeThreshold/);
  assert.match(source, /const speechCandidate=noiseProcessed\?\(speexSpeech\|\|cleanSpeech\|\|\(rawSpeech&&rawSnr>=3\.2\)\):rawSpeech/);
  assert.match(source, /phoneActiveVoiceEvidence/);
});
