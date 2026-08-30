export const REALTIME_STT_MODEL = '@cf/deepgram/nova-3';
export const ACCURATE_STT_MODEL = 'openai/gpt-4o-transcribe';
export const FALLBACK_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';

const DEFAULT_TERMS = [
  'TalkSys', 'Cloudflare', 'Workers AI', 'AI Gateway', 'GitHub', 'OpenAI', 'Gemini',
  'Windows', 'Android', 'iPhone', 'Linux', 'CPU', 'GPU', 'Wi-Fi', 'HIFU', 'EMS',
  'WebSocket', 'STT', 'TTS', 'API', 'Cloudflare Workers',
];

function rms16(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return 0;
  const samples = new Int16Array(buffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function makeWav(frames, sampleRate) {
  const pcmBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const wav = new Uint8Array(44 + pcmBytes);
  const view = new DataView(wav.buffer);
  const write = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) wav[offset + i] = value.charCodeAt(i);
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

function bytesToBase64(bytes) {
  let value = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    value += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + size)));
  }
  return btoa(value);
}

function readText(result) {
  const candidates = [
    result?.result?.text,
    result?.text,
    result?.transcript,
    result?.response,
    result?.output_text,
    result?.choices?.[0]?.message?.content,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeForCompare(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s。、，,.！？!?「」『』（）()・ー~〜]/g, '');
}

function similarity(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const longer = x.length >= y.length ? x : y;
  const shorter = x.length >= y.length ? y : x;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  const grams = new Set();
  for (let i = 0; i < x.length - 1; i += 1) grams.add(x.slice(i, i + 2));
  if (!grams.size) return 0;
  let hit = 0;
  for (let i = 0; i < y.length - 1; i += 1) if (grams.has(y.slice(i, i + 2))) hit += 1;
  return (2 * hit) / Math.max(1, (x.length - 1) + (y.length - 1));
}

function recentContext(provider) {
  try {
    const history = typeof provider === 'function' ? provider() : [];
    if (!Array.isArray(history)) return '';
    return history.slice(-6)
      .map((item) => `${item?.role || 'user'}: ${String(item?.content || '').replace(/\s+/g, ' ').slice(0, 180)}`)
      .join('\n')
      .slice(0, 1000);
  } catch {
    return '';
  }
}

function guidePrompt(config) {
  const context = recentContext(config.contextProvider);
  const parts = [
    '日本語の自然な会話の文字起こし。聞こえた内容を勝手に言い換えない。',
    '固有名詞・製品名・技術用語・英数字をできるだけ正確に保持する。',
    `用語候補: ${config.keyterms.join(', ')}`,
  ];
  if (context) parts.push(`直近の会話（同音異義語と固有名詞の参考のみ）:\n${context}`);
  return parts.join('\n').slice(0, 1600);
}

async function accurateTranscribe(ai, wav, config, novaText, signal) {
  const base64 = bytesToBase64(wav);
  const dataUri = `data:audio/wav;base64,${base64}`;
  try {
    const result = await ai.run(
      ACCURATE_STT_MODEL,
      {
        file: dataUri,
        language: 'ja',
        prompt: guidePrompt(config),
        temperature: 0,
      },
      {
        gateway: { id: 'default' },
        ...(signal ? { signal } : {}),
      },
    );
    const text = readText(result);
    if (text) return { text, provider: 'gpt-4o-transcribe' };
  } catch {
    // Unified Billing may not be enabled. Fall through to Workers AI.
  }

  try {
    const result = await ai.run(
      FALLBACK_STT_MODEL,
      {
        audio: base64,
        task: 'transcribe',
        language: 'ja',
        vad_filter: true,
        initial_prompt: guidePrompt(config),
        beam_size: 7,
        condition_on_previous_text: false,
        no_speech_threshold: 0.5,
        compression_ratio_threshold: 2.35,
        log_prob_threshold: -1.0,
        hallucination_silence_threshold: 0.8,
      },
      signal ? { signal } : undefined,
    );
    const text = readText(result);
    if (text) return { text, provider: 'whisper-large-v3-turbo' };
  } catch {
    // Last-resort realtime transcript below.
  }

  return { text: String(novaText || '').trim(), provider: 'nova-3-fallback' };
}

export class CloudflareJapaneseSTT {
  constructor(ai, options = {}) {
    this.ai = ai;
    this.options = {
      sampleRate: options.sampleRate ?? 16000,
      language: options.language || 'ja',
      endpointingMs: options.endpointingMs ?? 400,
      utteranceEndMs: options.utteranceEndMs ?? 850,
      silenceMs: options.silenceMs ?? 520,
      minSpeechMs: options.minSpeechMs ?? 160,
      maxTurnMs: options.maxTurnMs ?? 30000,
      preRollFrames: options.preRollFrames ?? 6,
      keyterms: Array.isArray(options.keyterms) && options.keyterms.length ? options.keyterms : DEFAULT_TERMS,
      contextProvider: options.contextProvider,
    };
  }

  createSession(callbacks = {}) {
    return new CloudflareJapaneseSession(this.ai, this.options, callbacks);
  }
}

class CloudflareJapaneseSession {
  constructor(ai, config, callbacks) {
    this.ai = ai;
    this.config = config;
    this.callbacks = callbacks;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pending = [];
    this.preRoll = [];
    this.frames = [];
    this.speechActive = false;
    this.startFrames = 0;
    this.silenceMs = 0;
    this.durationMs = 0;
    this.noiseFloor = 0.004;
    this.latestNova = '';
    this.finalNova = [];
    this.processing = Promise.resolve();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.connect();
  }

  waitUntilReady() { return this.ready; }

  async connect() {
    try {
      const input = {
        encoding: 'linear16',
        sample_rate: String(this.config.sampleRate),
        language: this.config.language,
        interim_results: 'true',
        vad_events: 'true',
        endpointing: String(this.config.endpointingMs),
        utterance_end_ms: String(this.config.utteranceEndMs),
        smart_format: 'true',
        punctuate: 'true',
        keyterm: this.config.keyterms,
      };
      const result = await this.ai.run(REALTIME_STT_MODEL, input, { websocket: true });
      const ws = result?.webSocket;
      if (!ws) throw new Error('Nova-3 did not return a WebSocket');
      if (this.closed) {
        try { ws.accept(); ws.close(); } catch {}
        this.resolveReady?.();
        return;
      }
      ws.accept();
      this.ws = ws;
      this.connected = true;
      ws.addEventListener('message', (event) => this.handleNova(event));
      ws.addEventListener('close', () => {
        this.connected = false;
        if (!this.closed) this.callbacks.onFatalError?.(new Error('Nova-3 STT connection closed'));
      });
      ws.addEventListener('error', () => {
        this.connected = false;
        if (!this.closed) this.callbacks.onFatalError?.(new Error('Nova-3 STT WebSocket error'));
      });
      for (const frame of this.pending) ws.send(frame);
      this.pending = [];
      this.resolveReady?.();
    } catch (error) {
      this.rejectReady?.(error);
      this.callbacks.onFatalError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  handleNova(event) {
    if (this.closed || typeof event.data !== 'string') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type !== 'Results') return;
    const text = String(data?.channel?.alternatives?.[0]?.transcript || '').trim();
    if (!text) return;
    if (data.is_final) {
      this.finalNova.push(text);
      this.latestNova = this.finalNova.join(' ').trim();
    } else {
      const prefix = this.finalNova.join(' ').trim();
      this.latestNova = `${prefix}${prefix ? ' ' : ''}${text}`.trim();
      this.callbacks.onInterim?.(this.latestNova);
    }
  }

  feed(chunk) {
    if (this.closed || !(chunk instanceof ArrayBuffer) || chunk.byteLength < 2 || chunk.byteLength % 2) return;
    if (this.connected && this.ws) this.ws.send(chunk);
    else this.pending.push(chunk.slice(0));

    const frameMs = (chunk.byteLength / 2 / this.config.sampleRate) * 1000;
    const level = rms16(chunk);
    const startThreshold = Math.max(0.006, Math.min(0.07, this.noiseFloor * 2.4));
    const endThreshold = Math.max(0.0045, Math.min(startThreshold * 0.7, this.noiseFloor * 1.7));

    if (!this.speechActive) {
      this.preRoll.push(chunk.slice(0));
      if (this.preRoll.length > this.config.preRollFrames) this.preRoll.shift();
      if (level < startThreshold) {
        this.noiseFloor = Math.max(0.001, Math.min(0.025, this.noiseFloor * 0.985 + level * 0.015));
        this.startFrames = 0;
        return;
      }
      this.startFrames += 1;
      if (this.startFrames < 2) return;
      this.speechActive = true;
      this.frames = this.preRoll.splice(0);
      this.durationMs = this.frames.reduce((sum, frame) => sum + (frame.byteLength / 2 / this.config.sampleRate) * 1000, 0);
      this.silenceMs = 0;
      this.finalNova = [];
      this.latestNova = '';
      this.callbacks.onSpeechStart?.();
      return;
    }

    this.frames.push(chunk.slice(0));
    this.durationMs += frameMs;
    if (level > endThreshold) this.silenceMs = 0;
    else this.silenceMs += frameMs;

    if (this.durationMs >= this.config.maxTurnMs) this.commit('max_duration');
    else if (this.silenceMs >= this.config.silenceMs) this.commit('server_vad');
  }

  commit(reason) {
    if (!this.speechActive) return;
    const frames = this.frames;
    const durationMs = this.durationMs;
    const novaText = this.latestNova || this.finalNova.join(' ').trim();
    this.speechActive = false;
    this.startFrames = 0;
    this.silenceMs = 0;
    this.durationMs = 0;
    this.frames = [];
    this.preRoll = [];
    this.finalNova = [];
    this.latestNova = '';
    if (!frames.length || durationMs < this.config.minSpeechMs) return;

    this.processing = this.processing.catch(() => {}).then(async () => {
      const wav = makeWav(frames, this.config.sampleRate);
      const result = await accurateTranscribe(this.ai, wav, this.config, novaText);
      if (this.closed) return;
      let text = String(result.text || '').trim();
      if (!text) return;
      // When the high-accuracy result is wildly shorter than a stable Nova transcript,
      // prefer Nova rather than silently dropping most of the utterance.
      if (novaText && text.length < Math.max(3, novaText.length * 0.35) && similarity(text, novaText) < 0.35) text = novaText;
      this.callbacks.onUtterance?.(text);
    }).catch((error) => {
      if (!this.closed) this.callbacks.onFatalError?.(error instanceof Error ? error : new Error(`${reason}: ${String(error)}`));
    });
  }

  updateAgentContext() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.preRoll = [];
    this.frames = [];
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connected = false;
    this.resolveReady?.();
  }
}

export { makeWav, similarity, normalizeForCompare };
