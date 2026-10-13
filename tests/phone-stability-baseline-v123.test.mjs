import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PHONE_STT_CONTEXT_PROMPT,
  STT_REVISION,
  analyzeWav,
  normalizeQuietPhoneWav,
} from '../src/stt-v45.js';
import {
  PHONE_ADAPTIVE_VAD_REVISION,
  PHONE_RELEASE_VERSION,
  PHONE_VAD_PREROLL_FRAMES,
  PHONE_VAD_START_HITS,
  PHONE_VAD_START_NOISE_RATIO,
  phoneVadFrameIsSpeech,
  phoneVadStartThreshold,
} from '../src/telephony/index.js';
import {
  PHONE_TTS_OUTPUT_PEAK_CEILING,
  phoneTtsDeliveryMode,
  phoneTtsOutputGainDb,
  phoneTtsVoice,
} from '../src/telephony/phone-tts.js';

function pcm16Wav(samples, sampleRate = 8000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return buffer;
}

test('v123 locks the high-sensitivity adaptive-noise phone VAD', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v125');
  assert.equal(PHONE_ADAPTIVE_VAD_REVISION, 'talksys-phone-adaptive-vad-v123-r1');
  assert.equal(PHONE_VAD_START_NOISE_RATIO, 2.7);
  assert.equal(PHONE_VAD_START_HITS, 3);
  assert.equal(PHONE_VAD_PREROLL_FRAMES, 12);
  assert.equal(phoneVadFrameIsSpeech(0.0065, 0.0015, 0.0045), true);
  assert.equal(phoneVadFrameIsSpeech(0.0060, 0.0045, 0.0045), false);
  assert.ok(phoneVadStartThreshold(0.0045, 0.006) > 0.015);
});

test('v123 restores weak phone speech normalization without clipping', () => {
  const samples = Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 190));
  const wav = pcm16Wav(samples);
  const before = analyzeWav(wav);
  const normalized = normalizeQuietPhoneWav(wav, before);
  const after = analyzeWav(normalized.buffer);
  assert.equal(before.valid, true);
  assert.ok(normalized.gain > 1 && normalized.gain <= 2.5);
  assert.ok(after.rms > before.rms);
  assert.ok(after.peak <= 0.90 + 1e-6);
  assert.ok(PHONE_TTS_OUTPUT_PEAK_CEILING <= 0.94);
});

test('v123 phone STT uses generic phonetic proper-noun guidance', () => {
  assert.equal(STT_REVISION, 'talksys-v123-phone-accessibility-phonetic-r1');
  assert.match(PHONE_STT_CONTEXT_PROMPT, /地名/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /駅名/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /施設名/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /発音/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /ひらがなまたはカタカナ/);
  assert.doesNotMatch(PHONE_STT_CONTEXT_PROMPT, /べっぷえき|別府駅/);
});

test('v123 locks bright Eve output and bounded gain in deployment config', () => {
  const config = fs.readFileSync('wrangler.jsonc', 'utf8');
  assert.match(config, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"/);
  assert.match(config, /"TELEPHONY_TTS_VOICE"\s*:\s*"eve"/);
  assert.match(config, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"/);
  assert.match(config, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"3\.0"/);
  const env = { TELEPHONY_TTS_VOICE: 'eve', TELEPHONY_TTS_DELIVERY: 'loud-bright', TELEPHONY_TTS_OUTPUT_GAIN_DB: '3.0' };
  assert.equal(phoneTtsVoice(env), 'eve');
  assert.equal(phoneTtsDeliveryMode(env), 'loud-bright');
  assert.equal(phoneTtsOutputGainDb(env), 3);
});

test('v123 generic search path has no JMA special-case and no citation-metadata blanket refusal', () => {
  const source = fs.readFileSync('src/integrated-entry.js', 'utf8');
  const start = source.indexOf('export async function runGeminiTurn');
  const end = source.indexOf('export async function commonTalkSysTurn', start);
  const run = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source, /structured-jma-weather|deterministicJmaWeatherResult|JMA_WEATHER_REVISION/);
  assert.match(source, /検索で一部しか確認できなくても/);
  assert.doesNotMatch(source, /質問の中心となる事実を検索で確認できない場合/);
  assert.match(run, /recoverySearched \|\| recoveryAnswer/);
  assert.doesNotMatch(run, /groundingEvidenceUsable\(|evidenceFailureClarification\(text\)/);
  assert.doesNotMatch(run, /確認できない内容は推測で補いません/);
});

test('v123 keeps profile dirty protection and caller-scoped history UI', () => {
  const telephony = fs.readFileSync('src/telephony/index.js', 'utf8');
  assert.match(telephony, /profileDirty=true/);
  assert.match(telephony, /refreshProfile:false/);
  assert.match(telephony, /\/phone-profiles/);
  assert.match(telephony, /profileCallsMatch=url\.pathname\.match/);
  assert.match(telephony, /loadProfileCalls\(selectedPhone\)/);
});
