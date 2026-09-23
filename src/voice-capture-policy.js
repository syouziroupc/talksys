export const WEB_VOICE_CAPTURE_POLICY = Object.freeze({
  targetRate: 16000,
  frameMs: 40,
  silenceMs: 650,
  maxUtteranceMs: 12000,
  minSpeechMs: 260,
  preRollFrames: 8,
  minVoicedMs: 240,
  minSnr: 1.55,
  initialNoise: 0.0035,
  noiseMin: 0.0015,
  noiseMax: 0.04,
  startRmsMin: 0.012,
  startRmsMax: 0.095,
  startNoiseMultiplier: 3.2,
  endRmsMin: 0.007,
  endStartRatio: 0.70,
  endNoiseMultiplier: 2.0,
  peakGateMin: 0.027,
  peakGateStartMultiplier: 1.50,
  startSnr: 1.60,
  startHits: 3,
  ambientFastAlpha: 0.08,
  ambientRisingAlpha: 0.012,
  ambientFallingAlpha: 0.035,
  highpassHz: 90,
});

export function voiceVadThresholds(noise, noiseBoost = 1, policy = WEB_VOICE_CAPTURE_POLICY) {
  const safeNoise = Math.max(policy.noiseMin, Math.min(policy.noiseMax, Number(noise) || policy.initialNoise));
  const safeBoost = Math.max(1, Number(noiseBoost) || 1);
  const startTh = Math.max(
    policy.startRmsMin,
    Math.min(policy.startRmsMax, safeNoise * policy.startNoiseMultiplier * safeBoost),
  );
  const endTh = Math.max(
    policy.endRmsMin,
    Math.min(startTh * policy.endStartRatio, safeNoise * policy.endNoiseMultiplier * Math.sqrt(safeBoost)),
  );
  return { startTh, endTh };
}

export function adaptVoiceNoise(noise, rms, fast = false, policy = WEB_VOICE_CAPTURE_POLICY) {
  const current = Math.max(policy.noiseMin, Math.min(policy.noiseMax, Number(noise) || policy.initialNoise));
  const value = Math.max(0.001, Math.min(policy.noiseMax, Number(rms) || 0));
  const alpha = fast
    ? policy.ambientFastAlpha
    : (value > current ? policy.ambientRisingAlpha : policy.ambientFallingAlpha);
  return Math.max(policy.noiseMin, Math.min(policy.noiseMax, current * (1 - alpha) + value * alpha));
}

export function pcm16Level(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const usable = input.length - (input.length % 2);
  if (!usable) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  const samples = usable / 2;
  for (let offset = 0; offset < usable; offset += 2) {
    const sample = input.readInt16LE(offset) / 32768;
    const abs = Math.abs(sample);
    sum += sample * sample;
    if (abs > peak) peak = abs;
  }
  return { rms: Math.sqrt(sum / samples), peak };
}
