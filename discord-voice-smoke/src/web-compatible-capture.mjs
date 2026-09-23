import {
  WEB_VOICE_CAPTURE_POLICY,
  adaptVoiceNoise,
  pcm16Level,
  voiceVadThresholds,
} from '../../src/voice-capture-policy.js';

export class WebCompatibleCapture {
  constructor({ policy = WEB_VOICE_CAPTURE_POLICY, now = () => Date.now() } = {}) {
    this.policy = policy;
    this.now = now;
    this.frameBytes = Math.round(policy.targetRate * policy.frameMs / 1000) * 2;
    this.noise = policy.initialNoise;
    this.noiseBoost = 1;
    this.carry = Buffer.alloc(0);
    this.chunks = [];
    this.totalBytes = 0;
    this.firstPcmAt = 0;
    this.lastPcmAt = 0;
    this.lastVoicedAt = 0;
    this.durationMs = 0;
    this.voicedMs = 0;
    this.maxRms = 0;
    this.maxPeak = 0;
    this.lastRms = 0;
    this.lastPeak = 0;
    this.silenceMs = 0;
    this.frameCount = 0;
  }

  push(chunk, at = this.now()) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    if (!input.length) return;
    if (!this.firstPcmAt) this.firstPcmAt = at;
    this.lastPcmAt = at;
    this.chunks.push(Buffer.from(input));
    this.totalBytes += input.length;

    let data = this.carry.length ? Buffer.concat([this.carry, input]) : input;
    let offset = 0;
    while (offset + this.frameBytes <= data.length) {
      this.#processFrame(data.subarray(offset, offset + this.frameBytes), at);
      offset += this.frameBytes;
    }
    this.carry = offset < data.length ? Buffer.from(data.subarray(offset)) : Buffer.alloc(0);
  }

  #processFrame(frame, at) {
    const level = pcm16Level(frame);
    this.frameCount += 1;
    this.durationMs += this.policy.frameMs;
    this.lastRms = level.rms;
    this.lastPeak = level.peak;
    this.maxRms = Math.max(this.maxRms, level.rms);
    this.maxPeak = Math.max(this.maxPeak, level.peak);

    const { endTh } = voiceVadThresholds(this.noise, this.noiseBoost, this.policy);
    if (level.rms > endTh) {
      this.silenceMs = 0;
      this.voicedMs += this.policy.frameMs;
      this.lastVoicedAt = at;
    } else {
      this.silenceMs += this.policy.frameMs;
      // Discord already supplies a speaking candidate. Only low-energy frames
      // are allowed to teach the ambient floor so quiet speech is not normalized away.
      this.noise = adaptVoiceNoise(this.noise, level.rms, false, this.policy);
    }
  }

  shouldFinalize(at = this.now()) {
    if (!this.firstPcmAt) return false;
    if (this.durationMs >= this.policy.maxUtteranceMs) return true;
    if (this.durationMs < this.policy.minSpeechMs) return false;
    if (this.silenceMs >= this.policy.silenceMs) return true;
    // Discord may stop sending Opus packets during silence. Mirror the web
    // 650 ms end window with wall-clock silence instead of waiting 1600 ms.
    return this.lastPcmAt > 0 && at - this.lastPcmAt >= this.policy.silenceMs;
  }

  finalize(at = this.now()) {
    const pcm = Buffer.concat(this.chunks);
    const exactDurationMs = pcm.length / 2 / this.policy.targetRate * 1000;
    const snr = this.maxRms / Math.max(0.001, this.noise);
    return {
      pcm,
      metrics: {
        firstPcmAt: this.firstPcmAt,
        lastPcmAt: this.lastPcmAt,
        utteranceEndAt: at,
        durationMs: Math.round(exactDurationMs),
        voicedMs: Math.round(this.voicedMs),
        maxRms: Number(this.maxRms.toFixed(5)),
        maxPeak: Number(this.maxPeak.toFixed(5)),
        noiseFloor: Number(this.noise.toFixed(5)),
        snr: Number(snr.toFixed(2)),
        silenceMs: Math.round(this.silenceMs),
        frameCount: this.frameCount,
      },
    };
  }
}

export const __test = {
  policy: WEB_VOICE_CAPTURE_POLICY,
};
