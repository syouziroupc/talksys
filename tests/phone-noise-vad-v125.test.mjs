import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPhoneNoiseSuppressor } from '../src/telephony/phone-noise-suppressor.js';
import {
  PHONE_NOISE_VAD_REVISION,
  PHONE_RELEASE_VERSION,
  PHONE_VAD_RAW_RESCUE_MS,
  phoneActiveVoiceEvidence,
} from '../src/telephony/index.js';

function frame(seed = 1, voice = 0) {
  let x = seed >>> 0;
  const out = new Int16Array(160);
  for (let i = 0; i < out.length; i += 1) {
    x = (1664525 * x + 1013904223) >>> 0;
    const noise = ((x / 0xffffffff) * 2 - 1) * 700;
    const tone = voice ? Math.sin(2 * Math.PI * 220 * i / 8000) * voice : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(noise + tone)));
  }
  return out;
}

test('v125 exposes bounded Speex speech probability within the existing CPU budget', async () => {
  const ns = await createPhoneNoiseSuppressor();
  for (let i = 0; i < 80; i += 1) ns.process(frame(i, i > 40 ? 1000 : 0));
  let elapsed = 0;
  let max = 0;
  for (let i = 0; i < 800; i += 1) {
    const out = ns.process(frame(i + 5000, i % 4 === 0 ? 950 : 0));
    assert.equal(out.ok, true);
    assert.ok(Number.isFinite(out.probability));
    assert.ok(out.probability >= 0 && out.probability <= 100);
    elapsed += out.elapsedMs;
    max = Math.max(max, out.elapsedMs);
  }
  assert.ok(elapsed / 800 < 2.0, `average frame CPU ${(elapsed / 800).toFixed(3)} ms exceeds 2ms budget`);
  assert.ok(max < 20, `single frame CPU ${max.toFixed(3)} ms exceeds one 20ms frame`);
  ns.destroy();
});

test('v125 active VAD behavior cannot be held open indefinitely by raw high-RMS noise', () => {
  assert.match(PHONE_RELEASE_VERSION, /^v\d+$/);
  assert.match(PHONE_NOISE_VAD_REVISION, /^talksys-phone-noise-vad-v\d+/);
  assert.equal(PHONE_VAD_RAW_RESCUE_MS, 240);
  assert.equal(phoneActiveVoiceEvidence({ speexSpeech: true, speechProbability: 60 }).voice, true);
  assert.equal(phoneActiveVoiceEvidence({ cleanSpeech: true, speechProbability: 45 }).denoisedSpeech, true);
  const rescue = phoneActiveVoiceEvidence({ rawSpeech: true, rawSnr: 5, msSinceDenoisedSpeech: 120 });
  assert.equal(rescue.rawRescue, true);
  assert.equal(rescue.voice, true);
  const expired = phoneActiveVoiceEvidence({ rawSpeech: true, rawSnr: 20, msSinceDenoisedSpeech: 260 });
  assert.equal(expired.rawRescue, false);
  assert.equal(expired.voice, false);
  assert.equal(phoneActiveVoiceEvidence({ speechProbability: 10, cleanSpeech: false, rawSpeech: false, rawSnr: 100, msSinceDenoisedSpeech: 0 }).voice, false);
});

test('v125 media continuation uses voice evidence instead of the removed RMS-only hold-open rule', () => {
  const source = fs.readFileSync('src/telephony/index.js', 'utf8');
  assert.match(source, /phoneActiveVoiceEvidence\(\{speexSpeech,speechProbability,cleanSpeech,rawSpeech,rawSnr,msSinceDenoisedSpeech:activeDenoisedSpeechAgeMs\}\)/);
  assert.match(source, /if\(evidence\.voice\)silentFor=0;else silentFor\+=FRAME_MS/);
  assert.match(source, /finishUtterance\('hangover'\)/);
  assert.match(source, /finishUtterance\('max-utterance'\)/);
  assert.doesNotMatch(source, /if\(rms>=Math\.max\(\(phoneNoiseSuppressor\?noiseCleanFloor:noiseFloor\)\*1\.65,speechThreshold\*0\.62\)\)silentFor=0/);
  assert.match(source, /noise_suppression_summary/);
});
