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
    this.pre = [];
    this.frames = [];
    this.speech = false;
    this.startHits = 0;
    this.firstPcmAt = 0;
    this.speechStartAt = 0;
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
    this.rawPcmBytes = 0;
  }

  push(chunk, at = this.now()) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    if (!input.length) return;
    if (!this.firstPcmAt) this.firstPcmAt = at;
    this.lastPcmAt = at;
    this.rawPcmBytes += input.length;

    let data = this.carry.length ? Buffer.concat([this.carry, input]) : input;
    let offset = 0;
    while (offset + this.frameBytes <= data.length) {
      this.#processFrame(Buffer.from(data.subarray(offset, offset + this.frameBytes)), at);
      offset += this.frameBytes;
    }
    this.carry = offset < data.length ? Buffer.from(data.subarray(offset)) : Buffer.alloc(0);
  }

  #processFrame(frame, at) {
    const level = pcm16Level(frame);
    this.frameCount += 1;
    this.lastRms = level.rms;
    this.lastPeak = level.peak;

    const { startTh, endTh } = voiceVadThresholds(this.noise, this.noiseBoost, this.policy);
    const snr = level.rms / Math.max(0.001, this.noise);

    if (!this.speech) {
      this.pre.push(frame);
      if (this.pre.length > this.policy.preRollFrames) this.pre.shift();

      const peakGate = Math.max(
        this.policy.peakGateMin,
        startTh * this.policy.peakGateStartMultiplier,
      );
      if (level.rms < startTh || level.peak < peakGate || snr < this.policy.startSnr) {
        this.noise = adaptVoiceNoise(this.noise, level.rms, false, this.policy);
        this.startHits = 0;
        return;
      }

      this.startHits += 1;
      if (this.startHits < this.policy.startHits) return;

      this.speech = true;
      this.speechStartAt = at;
      this.frames = this.pre.splice(0);
      this.durationMs = this.frames.length * this.policy.frameMs;
      this.voicedMs = this.policy.startHits * this.policy.frameMs;
      this.maxRms = level.rms;
      this.maxPeak = level.peak;
      this.silenceMs = 0;
      this.lastVoicedAt = at;
      return;
    }

    this.frames.push(frame);
    this.durationMs += this.policy.frameMs;
    this.maxRms = Math.max(this.maxRms, level.rms);
    this.maxPeak = Math.max(this.maxPeak, level.peak);

    if (level.rms > endTh) {
      this.silenceMs = 0;
      this.voicedMs += this.policy.frameMs;
      this.lastVoicedAt = at;
    } else {
      this.silenceMs += this.policy.frameMs;
    }
  }

  shouldFinalize(at = this.now()) {
    if (!this.speech) return false;
    if (this.durationMs >= this.policy.maxUtteranceMs) return true;
    if (this.durationMs < this.policy.minSpeechMs) return false;
    if (this.silenceMs >= this.policy.silenceMs) return true;
    // Discord may stop emitting packets during silence. Use the same 650 ms
    // end window against wall time instead of relying on the 1600 ms transport guard.
    return this.lastPcmAt > 0 && at - this.lastPcmAt >= this.policy.silenceMs;
  }

  finalize(at = this.now()) {
    // Do not discard any PCM that belongs to the accepted utterance. The
    // pre-roll copied at speech start is included in frames.
    const pcm = this.speech ? Buffer.concat(this.frames) : Buffer.alloc(0);
    const exactDurationMs = pcm.length / 2 / this.policy.targetRate * 1000;
    const snr = this.maxRms / Math.max(0.001, this.noise);
    return {
      pcm,
      metrics: {
        firstPcmAt: this.firstPcmAt,
        speechStartAt: this.speechStartAt,
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
        preRollFrames: this.policy.preRollFrames,
        rawPcmBytes: this.rawPcmBytes,
        acceptedPcmBytes: pcm.length,
        speechDetected: this.speech,
      },
    };
  }
}

export const __test = {
  policy: WEB_VOICE_CAPTURE_POLICY,
};
