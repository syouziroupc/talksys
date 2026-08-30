export const REALTIME_STT_MODEL = '@cf/deepgram/nova-3';
export const ACCURATE_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const RESOLVER_MODEL = '@cf/qwen/qwen3.8-27b';

const DEFAULT_TERMS = [
  'TalkSys', 'Cloudflare', 'Workers AI', 'AI Gateway', 'GitHub', 'OpenAI', 'Gemini',
  'Windows', 'Android', 'iPhone', 'Linux', 'CPU', 'GPU', 'Wi-Fi', 'HIFU', 'EMS',
  'WebSocket', 'STT', 'TTS', 'API', 'Cloudflare Workers', 'GPT', 'Qwen',
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
  const write = (offset, value) => { for (let i = 0; i < value.length; i += 1) wav[offset + i] = value.charCodeAt(i); };
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
  for (let i = 0; i < bytes.length; i += size) value += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + size)));
  return btoa(value);
}

function readWhisper(result) {
  return String(result?.text || result?.transcription_info?.text || result?.transcript || result?.response || '').trim();
}

export function normalizeForCompare(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s。、，,.！？!?「」『』（）()・ー~〜]/g, '');
}

export function similarity(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const aCounts = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const g = x.slice(i, i + 2);
    aCounts.set(g, (aCounts.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const g = y.slice(i, i + 2);
    const n = aCounts.get(g) || 0;
    if (n > 0) { hit += 1; aCounts.set(g, n - 1); }
  }
  return (2 * hit) / Math.max(1, (x.length - 1) + (y.length - 1));
}

function recentContext(provider) {
  try {
    const history = typeof provider === 'function' ? provider() : [];
    if (!Array.isArray(history)) return '';
    return history.slice(-8)
      .map((item) => `${item?.role || 'user'}: ${String(item?.content || '').replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n')
      .slice(0, 1400);
  } catch { return ''; }
}

function initialPrompt(config) {
  const context = recentContext(config.contextProvider);
  const parts = [
    '日本語の日常会話を、聞こえた内容のまま正確に文字起こしする。勝手な要約や言い換えをしない。',
    '固有名詞・製品名・技術用語・英数字をできるだけ保持する。',
    `用語候補: ${config.keyterms.join(', ')}`,
  ];
  if (context) parts.push(`直近会話（同音異義語と固有名詞の表記判断だけに使用）:\n${context}`);
  return parts.join('\n').slice(0, 1800);
}

async function whisperTranscribe(ai, wav, config, signal) {
  const result = await ai.run(
    ACCURATE_STT_MODEL,
    {
      audio: bytesToBase64(wav),
      task: 'transcribe',
      language: 'ja',
      vad_filter: true,
      initial_prompt: initialPrompt(config),
      beam_size: 8,
      condition_on_previous_text: false,
      no_speech_threshold: 0.5,
      compression_ratio_threshold: 2.3,
      log_prob_threshold: -1.0,
      hallucination_silence_threshold: 0.75,
    },
    signal ? { signal } : undefined,
  );
  return readWhisper(result);
}

function readResolver(result) {
  return String(result?.response || result?.choices?.[0]?.message?.content || result?.output_text || '').trim()
    .replace(/^```(?:text)?\s*/i, '').replace(/```$/i, '').trim();
}

async function resolveCandidates(ai, whisper, nova, config, signal) {
  if (!whisper) return nova;
  if (!nova) return whisper;
  const score = similarity(whisper, nova);
  if (score >= 0.78) return whisper;

  const context = recentContext(config.contextProvider);
  const prompt = `同じ日本語音声から得た文字起こし候補A/Bを比較し、実際に話した可能性が高い最終文字列だけを返してください。
候補にない意味内容を追加してはいけません。会話文脈は固有名詞・同音異義語・助詞の選択にだけ使ってください。説明、引用符、ラベルは不要です。

直近会話:
${context || '(なし)'}

候補A（Whisper）:
${whisper}

候補B（Nova-3）:
${nova}`;
  try {
    const result = await ai.run(RESOLVER_MODEL, {
      messages: [
        { role: 'system', content: '日本語ASR候補の選択と最小校正だけを行う。候補にない内容は作らない。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 160,
      temperature: 0,
      top_p: 0.8,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
    }, signal ? { signal } : undefined);
    const text = readResolver(result);
    const maxLength = Math.max(whisper.length, nova.length) * 1.45 + 16;
    if (text && text.length <= maxLength) return text;
  } catch {}

  // Prefer Whisper except where it appears to have dropped most of a stable Nova sentence.
  if (whisper.length < nova.length * 0.42 && nova.length >= 10) return nova;
  return whisper;
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
      preRollFrames: options.preRollFrames ?? 7,
      keyterms: Array.isArray(options.keyterms) && options.keyterms.length ? options.keyterms : DEFAULT_TERMS,
      contextProvider: options.contextProvider,
    };
  }

  createSession(callbacks = {}) { return new CloudflareJapaneseSession(this.ai, this.options, callbacks); }
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
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.connect();
  }

  waitUntilReady() { return this.ready; }

  async connect() {
    try {
      const result = await this.ai.run(REALTIME_STT_MODEL, {
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
      }, { websocket: true });
      const ws = result?.webSocket;
      if (!ws) throw new Error('Nova-3 did not return a WebSocket');
      if (this.closed) { try { ws.accept(); ws.close(); } catch {} this.resolveReady?.(); return; }
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
    if (this.connected && this.ws) this.ws.send(chunk); else this.pending.push(chunk.slice(0));

    const frameMs = (chunk.byteLength / 2 / this.config.sampleRate) * 1000;
    const level = rms16(chunk);
    const startThreshold = Math.max(0.006, Math.min(0.07, this.noiseFloor * 2.35));
    const endThreshold = Math.max(0.0045, Math.min(startThreshold * 0.72, this.noiseFloor * 1.75));

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
    if (level > endThreshold) this.silenceMs = 0; else this.silenceMs += frameMs;
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
      let whisper = '';
      try { whisper = await whisperTranscribe(this.ai, wav, this.config); } catch {}
      if (this.closed) return;
      const text = String(await resolveCandidates(this.ai, whisper, novaText, this.config)).trim();
      if (text) this.callbacks.onUtterance?.(text);
      else this.callbacks.onFatalError?.(new Error(`Japanese STT returned empty transcript (${reason})`));
    }).catch((error) => {
      if (!this.closed) this.callbacks.onFatalError?.(error instanceof Error ? error : new Error(String(error)));
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

export { makeWav };
