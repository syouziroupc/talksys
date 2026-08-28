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

export class FinalizableNova3STT {
  constructor(ai, options = {}) {
    this.ai = ai;
    this.options = {
      language: options.language || 'ja',
      endpointingMs: options.endpointingMs ?? 480,
      utteranceEndMs: options.utteranceEndMs ?? 1000,
      smartFormat: options.smartFormat ?? true,
      punctuate: options.punctuate ?? true,
      keyterms: options.keyterms || [],
      sampleRate: options.sampleRate ?? 16000,
      forceFinalizeSilenceMs: options.forceFinalizeSilenceMs ?? 650,
      explicitCommitGraceMs: options.explicitCommitGraceMs ?? 450,
      explicitCommitMaxWaitMs: options.explicitCommitMaxWaitMs ?? 1800,
    };
    this.activeSession = null;
  }

  createSession(callbacks = {}) {
    const session = new FinalizableNova3Session(this.ai, this.options, callbacks, () => {
      if (this.activeSession === session) this.activeSession = null;
    });
    this.activeSession = session;
    return session;
  }

  forceFinalize(reason = 'external') {
    return this.activeSession?.forceFinalize(reason) ?? false;
  }

  diagnostics() {
    return this.activeSession?.diagnostics() || { active: false };
  }
}

class FinalizableNova3Session {
  constructor(ai, config, callbacks, onClosed) {
    this.callbacks = callbacks;
    this.config = config;
    this.onClosed = onClosed;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingChunks = [];
    this.pendingFinalize = false;
    this.finalizedSegments = [];
    this.latestInterim = '';
    this.lastEmitted = '';
    this.lastEmittedAt = 0;

    this.noiseFloor = 0.004;
    this.speechActive = false;
    this.speechFrames = 0;
    this.silenceMs = 0;
    this.lastFinalizeAt = 0;

    this.commitRequested = false;
    this.commitRequestedAt = 0;
    this.commitReason = '';
    this.commitTimer = null;
    this.audioFrames = 0;
    this.resultFrames = 0;

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.connect(ai);
  }

  waitUntilReady() {
    return this.ready;
  }

  async connect(ai) {
    try {
      const input = {
        encoding: 'linear16',
        sample_rate: String(this.config.sampleRate),
        language: this.config.language,
        interim_results: 'true',
        vad_events: 'true',
        endpointing: String(this.config.endpointingMs),
        utterance_end_ms: String(Math.max(1000, this.config.utteranceEndMs)),
        smart_format: String(this.config.smartFormat),
        punctuate: String(this.config.punctuate),
      };
      if (this.config.keyterms.length) input.keyterm = this.config.keyterms;

      const response = await ai.run('@cf/deepgram/nova-3', input, { websocket: true });
      const ws = response?.webSocket;
      if (!ws) throw new Error('Nova-3 did not return a WebSocket');
      if (this.closed) {
        try { ws.accept(); } catch {}
        try { ws.close(); } catch {}
        this.resolveReadiness();
        return;
      }

      ws.accept();
      this.ws = ws;
      this.connected = true;
      ws.addEventListener('message', (event) => this.handleMessage(event));
      ws.addEventListener('close', () => {
        this.connected = false;
        if (!this.closed) this.callbacks.onFatalError?.(new Error('Nova-3 WebSocket closed unexpectedly'));
      });
      ws.addEventListener('error', () => {
        this.connected = false;
        if (!this.closed) this.callbacks.onFatalError?.(new Error('Nova-3 WebSocket error'));
      });

      for (const chunk of this.pendingChunks) ws.send(chunk);
      this.pendingChunks = [];
      if (this.pendingFinalize) {
        this.pendingFinalize = false;
        this.sendFinalize();
      }
      this.resolveReadiness();
    } catch (error) {
      this.callbacks.onFatalError?.(error instanceof Error ? error : new Error(String(error)));
      this.rejectReadiness(error);
    }
  }

  feed(chunk) {
    if (this.closed || !(chunk instanceof ArrayBuffer)) return;
    this.audioFrames += 1;
    this.trackVoiceBoundary(chunk);
    if (this.connected && this.ws) this.ws.send(chunk);
    else this.pendingChunks.push(chunk);
  }

  trackVoiceBoundary(chunk) {
    const level = rms16(chunk);
    const samples = Math.floor(chunk.byteLength / 2);
    const frameMs = (samples / this.config.sampleRate) * 1000;
    const startThreshold = Math.max(0.005, this.noiseFloor * 2.0);
    const continueThreshold = Math.max(0.0035, startThreshold * 0.68);

    if (!this.speechActive) {
      if (level < startThreshold) {
        this.noiseFloor = Math.min(0.035, Math.max(0.0012, this.noiseFloor * 0.985 + level * 0.015));
      }
      if (level >= startThreshold) {
        this.speechFrames += 1;
        if (this.speechFrames >= 2) {
          this.speechActive = true;
          this.silenceMs = 0;
          this.callbacks.onSpeechStart?.();
        }
      } else {
        this.speechFrames = 0;
      }
      return;
    }

    if (level >= continueThreshold) {
      this.silenceMs = 0;
      return;
    }

    this.silenceMs += frameMs;
    if (this.silenceMs >= this.config.forceFinalizeSilenceMs) {
      this.speechActive = false;
      this.speechFrames = 0;
      this.silenceMs = 0;
      const now = Date.now();
      if (now - this.lastFinalizeAt > 300) {
        this.lastFinalizeAt = now;
        this.forceFinalize('server_vad');
      }
    }
  }

  forceFinalize(reason = 'external') {
    if (this.closed) return false;
    this.commitRequested = true;
    this.commitRequestedAt = Date.now();
    this.commitReason = reason;
    this.sendFinalize();
    this.scheduleCommitFallback();
    return true;
  }

  sendFinalize() {
    if (this.closed) return false;
    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'Finalize' }));
        return true;
      } catch {
        return false;
      }
    }
    this.pendingFinalize = true;
    return true;
  }

  scheduleCommitFallback() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.commitFallback();
    }, this.config.explicitCommitGraceMs);
  }

  commitFallback() {
    if (this.closed || !this.commitRequested) return;
    const text = this.bestTranscript();
    if (text) {
      this.finishUtterance(text);
      return;
    }

    const waited = Date.now() - this.commitRequestedAt;
    if (waited < this.config.explicitCommitMaxWaitMs) {
      this.sendFinalize();
      this.commitTimer = setTimeout(() => {
        this.commitTimer = null;
        this.commitFallback();
      }, Math.min(450, this.config.explicitCommitMaxWaitMs - waited));
      return;
    }

    this.commitRequested = false;
    this.commitReason = '';
  }

  bestTranscript(extra = '') {
    const pieces = [...this.finalizedSegments];
    const interim = String(extra || this.latestInterim || '').trim();
    if (interim) {
      const prefix = pieces.join(' ').trim();
      if (!prefix || interim !== prefix) {
        if (!prefix || !interim.startsWith(prefix)) pieces.push(interim);
        else pieces.push(interim.slice(prefix.length).trim());
      }
    }
    return pieces.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  resetTranscriptState() {
    this.finalizedSegments = [];
    this.latestInterim = '';
    this.commitRequested = false;
    this.commitReason = '';
    this.commitRequestedAt = 0;
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }

  finishUtterance(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    this.resetTranscriptState();
    this.emitUtterance(normalized);
  }

  emitUtterance(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    const now = Date.now();
    if (normalized === this.lastEmitted && now - this.lastEmittedAt < 1800) return;
    this.lastEmitted = normalized;
    this.lastEmittedAt = now;
    this.callbacks.onUtterance?.(normalized);
  }

  handleMessage(event) {
    if (this.closed || typeof event.data !== 'string') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'SpeechStarted') {
      this.callbacks.onSpeechStart?.();
      return;
    }
    if (data.type !== 'Results') return;
    this.resultFrames += 1;

    const transcript = String(data.channel?.alternatives?.[0]?.transcript || '').trim();
    if (data.is_final && transcript) {
      const last = this.finalizedSegments.at(-1);
      if (last !== transcript) this.finalizedSegments.push(transcript);
    }

    if (data.speech_final === true || data.from_finalize === true) {
      const full = this.bestTranscript(transcript);
      if (full) this.finishUtterance(full);
      return;
    }

    // Deepgram documents that from_finalize is not guaranteed. If the client has
    // explicitly ended the turn, an is_final segment is sufficient to commit it.
    if (this.commitRequested && data.is_final && transcript) {
      const full = this.bestTranscript();
      if (full) this.finishUtterance(full);
      return;
    }

    if (!data.is_final && transcript) {
      const prefix = this.finalizedSegments.join(' ').trim();
      this.latestInterim = prefix ? `${prefix} ${transcript}` : transcript;
      this.callbacks.onInterim?.(this.latestInterim);
    } else if (data.is_final) {
      this.latestInterim = this.finalizedSegments.join(' ').trim();
    }
  }

  diagnostics() {
    return {
      active: !this.closed,
      connected: this.connected,
      audioFrames: this.audioFrames,
      resultFrames: this.resultFrames,
      speechActive: this.speechActive,
      commitRequested: this.commitRequested,
      hasTranscript: Boolean(this.bestTranscript()),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    this.pendingFinalize = false;
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.resolveReadiness();
    this.onClosed?.();
  }

  resolveReadiness() {
    if (!this.resolveReady) return;
    const resolve = this.resolveReady;
    this.resolveReady = null;
    this.rejectReady = null;
    resolve();
  }

  rejectReadiness(error) {
    if (!this.rejectReady) return;
    const reject = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;
    reject(error);
  }
}
