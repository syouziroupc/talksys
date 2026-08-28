const START_MARKER = new Uint8Array([0x54,0x53,0x59,0x53,0x01,0x53,0x54,0x41]);
const COMMIT_MARKER = new Uint8Array([0x54,0x53,0x59,0x53,0x01,0x45,0x4e,0x44]);

export const TURN_START_MARKER = START_MARKER;
export const TURN_COMMIT_MARKER = COMMIT_MARKER;
export const FINAL_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const SECONDARY_STT_MODEL = '@cf/deepgram/nova-3';
export const STT_RESOLVER_MODEL = '@cf/qwen/qwen3.8-27b';

const DEFAULT_TERMS = [
  'TalkSys', 'Cloudflare', 'Workers', 'GitHub', 'OpenAI', 'Gemini', 'Windows', 'Android',
  'iPhone', 'Linux', 'CPU', 'GPU', 'Wi-Fi', 'HIFU', 'EMS', 'API', 'WebSocket', 'STT', 'TTS',
];

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

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return btoa(binary);
}

function extractWhisperTranscript(result) {
  return String(result?.text || result?.transcription_info?.text || result?.transcript || '').trim();
}

function extractNovaTranscript(result) {
  return String(
    result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    result?.channel?.alternatives?.[0]?.transcript ||
    result?.transcript ||
    result?.text ||
    '',
  ).trim();
}

function normalizeJapanese(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s。、，,.！？!?「」『』（）()・ー~〜]/g, '');
}

function bigramDice(a, b) {
  const x = normalizeJapanese(a);
  const y = normalizeJapanese(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const counts = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const gram = x.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const gram = y.slice(i, i + 2);
    const count = counts.get(gram) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / ((x.length - 1) + (y.length - 1));
}

function historyText(provider) {
  try {
    const history = typeof provider === 'function' ? provider() : [];
    if (!Array.isArray(history)) return '';
    return history.slice(-6)
      .map((item) => `${item?.role || 'user'}: ${String(item?.content || '').replace(/\s+/g, ' ').slice(0, 180)}`)
      .join('\n')
      .slice(0, 900);
  } catch {
    return '';
  }
}

function buildInitialPrompt(config) {
  const context = historyText(config.contextProvider);
  const parts = [
    '自然な日本語の日常会話を、聞こえた通りに正確に文字起こしする。',
    '固有名詞や技術用語を勝手に一般語へ置き換えない。',
    `用語候補: ${config.terms.join(', ')}`,
  ];
  if (context) parts.push(`直近の会話文脈:\n${context}`);
  return parts.join('\n').slice(0, 1500);
}

async function resolveDisagreement(ai, whisper, nova, context) {
  const prompt = `あなたは日本語音声認識の校正器です。候補A/Bは同じ音声から得た文字起こしです。\n原則としてAかBのどちらかを採用してください。直近会話は固有名詞・同音異義語の判断にだけ使い、候補に存在しない新しい内容を追加してはいけません。必要なら助詞・句読点・固有名詞表記だけ最小修正できます。説明せず、最終的な文字起こし本文だけ返してください。\n\n直近会話:\n${context || '(なし)'}\n\n候補A (Whisper):\n${whisper}\n\n候補B (Nova-3):\n${nova}`;
  try {
    const result = await ai.run(STT_RESOLVER_MODEL, {
      messages: [
        { role: 'system', content: '日本語音声認識の候補選択と最小校正だけを行う。推測で内容を足さない。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 140,
      temperature: 0,
      top_p: 0.8,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
    });
    const text = String(result?.response || result?.choices?.[0]?.message?.content || result?.output_text || '').trim();
    if (text && text.length <= Math.max(whisper.length, nova.length) * 1.45 + 12) return text;
  } catch {}
  return whisper || nova;
}

export class FinalizableNova3STT {
  constructor(ai, options = {}) {
    this.ai = ai;
    this.options = {
      language: options.language || 'ja',
      sampleRate: options.sampleRate ?? 16000,
      serverSilenceFallbackMs: options.serverSilenceFallbackMs ?? 1400,
      maxTurnMs: options.maxTurnMs ?? 30000,
      preRollFrames: options.preRollFrames ?? 8,
      minSpeechMs: options.minSpeechMs ?? 180,
      beamSize: options.beamSize ?? 7,
      terms: Array.isArray(options.terms) && options.terms.length ? options.terms : DEFAULT_TERMS,
      contextProvider: options.contextProvider,
    };
  }

  createSession(callbacks = {}) {
    return new BufferedHighAccuracySession(this.ai, this.options, callbacks);
  }
}

class BufferedHighAccuracySession {
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
    this.ready = Promise.resolve();
  }

  waitUntilReady() { return this.ready; }

  feed(chunk) {
    if (this.closed || !(chunk instanceof ArrayBuffer)) return;
    if (matchesMarker(chunk, START_MARKER)) { this.startExplicitTurn(); return; }
    if (matchesMarker(chunk, COMMIT_MARKER)) { this.commitTurn('client_marker'); return; }
    if (chunk.byteLength < 2 || chunk.byteLength % 2 !== 0) return;

    const frameMs = (chunk.byteLength / 2 / this.config.sampleRate) * 1000;
    const level = rms16(chunk);

    if (this.explicitTurn || this.speechActive) {
      this.currentFrames.push(chunk.slice(0));
      this.currentDurationMs += frameMs;
      if (level >= Math.max(0.0035, this.noiseFloor * 1.5)) this.silenceMs = 0;
      else this.silenceMs += frameMs;
      if (!this.explicitTurn && this.silenceMs >= this.config.serverSilenceFallbackMs) this.commitTurn('server_vad');
      else if (this.currentDurationMs >= this.config.maxTurnMs) this.commitTurn('max_duration');
      return;
    }

    this.preRoll.push(chunk.slice(0));
    if (this.preRoll.length > this.config.preRollFrames) this.preRoll.shift();
    const startThreshold = Math.max(0.0045, this.noiseFloor * 1.9);
    if (level < startThreshold) {
      this.noiseFloor = Math.min(0.03, Math.max(0.001, this.noiseFloor * 0.985 + level * 0.015));
      this.speechFrames = 0;
      return;
    }
    this.speechFrames += 1;
    if (this.speechFrames >= 2) {
      this.speechActive = true;
      this.silenceMs = 0;
      this.currentFrames = this.preRoll.splice(0);
      this.currentDurationMs = this.currentFrames.reduce((sum, frame) => sum + (frame.byteLength / 2 / this.config.sampleRate) * 1000, 0);
      this.callbacks.onSpeechStart?.();
    }
  }

  startExplicitTurn() {
    if (this.closed) return;
    if (!this.explicitTurn && !this.speechActive) {
      this.currentFrames = this.preRoll.splice(0);
      this.currentDurationMs = this.currentFrames.reduce((sum, frame) => sum + (frame.byteLength / 2 / this.config.sampleRate) * 1000, 0);
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
    this.processing = this.processing.catch(() => {}).then(() => this.transcribeTurn(frames, reason));
    return true;
  }

  async transcribeTurn(frames, reason) {
    if (this.closed) return;
    const wav = makeWav(frames, this.config.sampleRate);
    const base64 = bytesToBase64(wav);
    const context = historyText(this.config.contextProvider);
    const initialPrompt = buildInitialPrompt(this.config);

    const whisperTask = this.ai.run(FINAL_STT_MODEL, {
      audio: base64,
      task: 'transcribe',
      language: this.config.language,
      vad_filter: true,
      initial_prompt: initialPrompt,
      beam_size: this.config.beamSize,
      condition_on_previous_text: false,
      no_speech_threshold: 0.48,
      compression_ratio_threshold: 2.35,
      log_prob_threshold: -1.0,
      hallucination_silence_threshold: 0.8,
    });
    const novaTask = this.ai.run(SECONDARY_STT_MODEL, {
      audio: { body: new Response(wav).body, contentType: 'audio/wav' },
      language: this.config.language,
      smart_format: true,
      punctuate: true,
      numerals: true,
      utterances: true,
      keyterm: this.config.terms.join(','),
    });

    const [whisperResult, novaResult] = await Promise.allSettled([whisperTask, novaTask]);
    if (this.closed) return;
    const whisper = whisperResult.status === 'fulfilled' ? extractWhisperTranscript(whisperResult.value) : '';
    const nova = novaResult.status === 'fulfilled' ? extractNovaTranscript(novaResult.value) : '';

    if (!whisper && !nova) {
      const reasons = [whisperResult, novaResult]
        .filter((item) => item.status === 'rejected')
        .map((item) => String(item.reason?.message || item.reason || ''))
        .filter(Boolean)
        .join(' / ');
      this.callbacks.onFatalError?.(new Error(`Japanese dual-ASR failed (${reason})${reasons ? `: ${reasons}` : ''}`));
      return;
    }

    let transcript = whisper || nova;
    if (whisper && nova) {
      const similarity = bigramDice(whisper, nova);
      if (similarity < 0.82) transcript = await resolveDisagreement(this.ai, whisper, nova, context);
      else if (nova.length > whisper.length * 1.8 && whisper.length < 8) transcript = nova;
    }

    transcript = String(transcript || '').trim();
    if (transcript) {
      this.callbacks.onUtterance?.(transcript);
      return;
    }
    this.callbacks.onFatalError?.(new Error(`Japanese dual-ASR returned an empty transcript (${reason})`));
  }

  close() {
    this.closed = true;
    this.preRoll = [];
    this.currentFrames = [];
    this.explicitTurn = false;
    this.speechActive = false;
  }
}

export { bigramDice, normalizeJapanese };
