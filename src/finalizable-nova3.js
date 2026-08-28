const START_MARKER = new Uint8Array([0x54,0x53,0x59,0x53,0x01,0x53,0x54,0x41]);
const COMMIT_MARKER = new Uint8Array([0x54,0x53,0x59,0x53,0x01,0x45,0x4e,0x44]);

export const TURN_START_MARKER = START_MARKER;
export const TURN_COMMIT_MARKER = COMMIT_MARKER;

function matchesMarker(buffer, marker) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== marker.byteLength) return false;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < marker.length; i++) if (bytes[i] !== marker[i]) return false;
  return true;
}

function rms16(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return 0;
  const samples = new Int16Array(buffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function makeWav(frames, sampleRate) {
  const pcmBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const wav = new Uint8Array(44 + pcmBytes);
  const view = new DataView(wav.buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcmBytes, true);
  let offset = 44;
  for (const frame of frames) {
    const bytes = new Uint8Array(frame);
    wav.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return wav;
}

function extractBatchTranscript(result) {
  return String(
    result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    result?.channel?.alternatives?.[0]?.transcript ||
    result?.transcript ||
    result?.text ||
    '',
  ).trim();
}

export class FinalizableNova3STT {
  constructor(ai, options = {}) {
    this.ai = ai;
    this.options = {
      language: options.language || 'ja',
      sampleRate: options.sampleRate ?? 16000,
      smartFormat: options.smartFormat ?? true,
      punctuate: options.punctuate ?? true,
      serverSilenceFallbackMs: options.serverSilenceFallbackMs ?? 1400,
      maxTurnMs: options.maxTurnMs ?? 30000,
      preRollFrames: options.preRollFrames ?? 6,
      minSpeechMs: options.minSpeechMs ?? 160,
    };
  }

  createSession(callbacks = {}) {
    return new BufferedNova3Session(this.ai, this.options, callbacks);
  }
}

class BufferedNova3Session {
  constructor(ai, config, callbacks) {
    this.ai = ai;
    this.config = config;
    this.callbacks = callbacks;
    this.closed = false;
    this.explicitTurn = false;
    this.speechActive = false;
    this.speechFrames = 0;
    this.noiseFloor = 0.004;
    this.silenceMs = 0;
    this.preRoll = [];
    this.currentFrames = [];
    this.currentDurationMs = 0;
    this.processing = Promise.resolve();
    this.turnSequence = 0;
    this.ready = Promise.resolve();
  }

  waitUntilReady() {
    return this.ready;
  }

  feed(chunk) {
    if (this.closed || !(chunk instanceof ArrayBuffer)) return;
    if (matchesMarker(chunk, START_MARKER)) {
      this.startExplicitTurn();
      return;
    }
    if (matchesMarker(chunk, COMMIT_MARKER)) {
      this.commitTurn('client_marker');
      return;
    }
    if (chunk.byteLength < 2 || chunk.byteLength % 2 !== 0) return;

    const frameMs = (chunk.byteLength / 2 / this.config.sampleRate) * 1000;
    const level = rms16(chunk);

    if (this.explicitTurn || this.speechActive) {
      this.currentFrames.push(chunk.slice(0));
      this.currentDurationMs += frameMs;
      if (level >= Math.max(0.0035, this.noiseFloor * 1.55)) this.silenceMs = 0;
      else this.silenceMs += frameMs;

      if (!this.explicitTurn && this.silenceMs >= this.config.serverSilenceFallbackMs) {
        this.commitTurn('server_vad');
      } else if (this.currentDurationMs >= this.config.maxTurnMs) {
        this.commitTurn('max_duration');
      }
      return;
    }

    this.preRoll.push(chunk.slice(0));
    if (this.preRoll.length > this.config.preRollFrames) this.preRoll.shift();

    const startThreshold = Math.max(0.005, this.noiseFloor * 2.0);
    if (level < startThreshold) {
      this.noiseFloor = Math.min(0.03, Math.max(0.0012, this.noiseFloor * 0.985 + level * 0.015));
      this.speechFrames = 0;
      return;
    }

    this.speechFrames += 1;
    if (this.speechFrames >= 2) {
      this.speechActive = true;
      this.silenceMs = 0;
      this.currentFrames = this.preRoll.splice(0);
      this.currentDurationMs = this.currentFrames.reduce(
        (sum, frame) => sum + (frame.byteLength / 2 / this.config.sampleRate) * 1000,
        0,
      );
      this.callbacks.onSpeechStart?.();
    }
  }

  startExplicitTurn() {
    if (this.closed) return;
    if (!this.explicitTurn && !this.speechActive) {
      this.currentFrames = this.preRoll.splice(0);
      this.currentDurationMs = this.currentFrames.reduce(
        (sum, frame) => sum + (frame.byteLength / 2 / this.config.sampleRate) * 1000,
        0,
      );
      this.callbacks.onSpeechStart?.();
    }
    this.explicitTurn = true;
    this.speechActive = true;
    this.speechFrames = 0;
    this.silenceMs = 0;
  }

  commitTurn(reason) {
    if (this.closed) return false;
    const frames = this.currentFrames;
    const durationMs = this.currentDurationMs;
    this.currentFrames = [];
    this.currentDurationMs = 0;
    this.explicitTurn = false;
    this.speechActive = false;
    this.speechFrames = 0;
    this.silenceMs = 0;
    this.preRoll = [];

    if (!frames.length || durationMs < this.config.minSpeechMs) return false;
    const turnId = ++this.turnSequence;
    this.processing = this.processing
      .catch(() => {})
      .then(() => this.transcribeTurn(frames, turnId, reason));
    return true;
  }

  async transcribeTurn(frames, turnId, reason) {
    if (this.closed) return;
    const wav = makeWav(frames, this.config.sampleRate);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = new Response(wav).body;
        const result = await this.ai.run('@cf/deepgram/nova-3', {
          audio: { body, contentType: 'audio/wav' },
          language: this.config.language,
          smart_format: this.config.smartFormat,
          punctuate: this.config.punctuate,
        });
        if (this.closed || turnId !== this.turnSequence) return;
        const transcript = extractBatchTranscript(result);
        if (transcript) {
          this.callbacks.onUtterance?.(transcript);
          return;
        }
        lastError = new Error(`Nova-3 returned an empty transcript (${reason})`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!this.closed) this.callbacks.onFatalError?.(lastError || new Error('Nova-3 turn transcription failed'));
  }

  close() {
    this.closed = true;
    this.preRoll = [];
    this.currentFrames = [];
    this.explicitTurn = false;
    this.speechActive = false;
  }
}
