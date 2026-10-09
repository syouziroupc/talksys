import { normalizeJapaneseTtsText } from '../cloudflare-japanese-tts.js';
import { base64ToBytes, bytesToBase64, decodeMuLawByte, encodeMuLawSample } from './codec.js';

export const PHONE_TTS_MODEL = 'xai/grok-tts';
export const PHONE_TTS_DEFAULT_VOICE = 'ara';
export const PHONE_TTS_SAMPLE_RATE = 8000;
export const PHONE_TTS_FRAME_MS = 20;
export const PHONE_TTS_FRAME_BYTES = 160;
export const PHONE_TTS_MAX_SECONDS = 120;

const PHONE_TTS_VOICES = new Set(['eve', 'ara', 'rex', 'sal', 'leo']);
const EXPLICIT_RAW_PCMU_CONTENT_TYPES = new Set(['audio/basic', 'audio/mulaw', 'audio/x-mulaw']);
const EXPLICIT_RAW_PCM_CONTENT_TYPES = new Set(['audio/pcm', 'audio/l16', 'audio/x-pcm']);
const AMBIGUOUS_BINARY_CONTENT_TYPES = new Set(['', 'application/octet-stream']);
const WAV_CONTENT_TYPES = new Set(['audio/wav', 'audio/wave', 'audio/x-wav']);
const MP3_CONTENT_TYPES = new Set(['audio/mpeg', 'audio/mp3']);

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('phone_tts_invalid_audio_type');
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function normalizedContentType(value = '') {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function looksLikeTextOrJson(bytes) {
  if (!bytes.byteLength) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(96, bytes.byteLength))).trimStart();
  return head.startsWith('{') || head.startsWith('[') || head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.startsWith('<?xml');
}

function mpegFrameLength(bytes, offset = 0) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return 0;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return 0;

  const sampleRates = version === 3 ? [44100, 48000, 32000]
    : version === 2 ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const mpeg1Rates = {
    3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  };
  const mpeg2Rates = {
    3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const bitrate = (version === 3 ? mpeg1Rates : mpeg2Rates)[layer][bitrateIndex] * 1000;
  const sampleRate = sampleRates[sampleRateIndex];
  if (!bitrate || !sampleRate) return 0;
  if (layer === 3) return Math.floor(((12 * bitrate) / sampleRate + padding) * 4);
  const coefficient = layer === 1 && version !== 3 ? 72 : 144;
  return Math.floor((coefficient * bitrate) / sampleRate + padding);
}

export function detectAudioKind(input) {
  const bytes = asBytes(input);
  if (!bytes.byteLength) return 'empty';
  if (bytes.byteLength >= 3 && ascii(bytes, 0, 3) === 'ID3') return 'mp3-id3';
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (looksLikeTextOrJson(bytes)) return 'text';
  const firstFrame = mpegFrameLength(bytes, 0);
  if (firstFrame > 0) {
    const secondOffset = firstFrame;
    if (secondOffset + 4 <= bytes.byteLength && mpegFrameLength(bytes, secondOffset) > 0) return 'mp3-frames';
  }
  return 'binary';
}

function parseWav(bytes) {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('phone_tts_expected_wav_container');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.byteLength) throw new Error('phone_tts_bad_wav');
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    }
    if (id === 'data') data = bytes.slice(start, end);
    offset = end + (size & 1);
  }
  if (!fmt || !data) throw new Error('phone_tts_wav_structure_invalid');
  return { fmt, data };
}

function isActualMp3Kind(kind) {
  return kind === 'mp3-id3' || kind === 'mp3-frames';
}

export function phoneTtsVoice(env = {}) {
  const configured = String(env?.TELEPHONY_TTS_VOICE || '').trim().toLowerCase();
  return PHONE_TTS_VOICES.has(configured) ? configured : PHONE_TTS_DEFAULT_VOICE;
}

export function phoneTtsAudioUrl(result) {
  const candidates = [result?.result?.audio, result?.audio, result?.response?.result?.audio, result?.response?.audio];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (/^https:\/\//i.test(value)) return value;
  }
  return '';
}

export function extractMulawPayload(input, contentType = '') {
  const bytes = asBytes(input);
  const type = normalizedContentType(contentType);
  if (!bytes.byteLength) throw new Error('phone_tts_empty_audio');
  const kind = detectAudioKind(bytes);
  if (kind === 'text' || type === 'application/json' || type.startsWith('text/')) {
    throw new Error('phone_tts_unexpected_text_payload');
  }
  if (isActualMp3Kind(kind)) throw new Error('phone_tts_actual_mp3');

  if (kind === 'wav') {
    const { fmt, data } = parseWav(bytes);
    if (fmt.format !== 7 || fmt.channels !== 1 || fmt.sampleRate !== PHONE_TTS_SAMPLE_RATE || fmt.bitsPerSample !== 8) {
      throw new Error(`phone_tts_unexpected_wav_format_${fmt.format}_${fmt.channels}_${fmt.sampleRate}_${fmt.bitsPerSample}`);
    }
    if (!data.byteLength) throw new Error('phone_tts_empty_audio');
    return { bytes: data, container: WAV_CONTENT_TYPES.has(type) ? 'wav-mulaw' : 'wav-mulaw-mime-mismatch' };
  }

  if (WAV_CONTENT_TYPES.has(type)) throw new Error('phone_tts_expected_wav_container');
  if (EXPLICIT_RAW_PCMU_CONTENT_TYPES.has(type)) return { bytes, container: 'raw' };
  if (AMBIGUOUS_BINARY_CONTENT_TYPES.has(type)) return { bytes, container: 'raw' };
  if (MP3_CONTENT_TYPES.has(type)) return { bytes, container: 'raw-mime-mismatch' };
  throw new Error(`phone_tts_unexpected_content_type_${type || 'empty'}`);
}

export function inspectPcmu(bytesInput) {
  const bytes = asBytes(bytesInput);
  if (!bytes.byteLength) throw new Error('phone_tts_empty_audio');
  const durationMs = Math.round((bytes.byteLength / PHONE_TTS_SAMPLE_RATE) * 1000);
  if (durationMs < PHONE_TTS_FRAME_MS) throw new Error('phone_tts_audio_too_short');
  if (durationMs > PHONE_TTS_MAX_SECONDS * 1000) throw new Error('phone_tts_audio_too_long');
  let sumSquares = 0;
  let peak = 0;
  let silent = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const sample = decodeMuLawByte(bytes[i]);
    const normalized = sample / 32768;
    const absolute = Math.abs(normalized);
    sumSquares += normalized * normalized;
    peak = Math.max(peak, absolute);
    if (absolute < 0.001) silent += 1;
  }
  const rms = Math.sqrt(sumSquares / bytes.byteLength);
  return {
    byteLength: bytes.byteLength,
    durationMs,
    rms: Number(rms.toFixed(6)),
    peak: Number(peak.toFixed(6)),
    silenceRatio: Number((silent / bytes.byteLength).toFixed(6)),
  };
}

export function validatePcmuResponse(input, contentType = '') {
  const extracted = extractMulawPayload(input, contentType);
  return {
    bytes: extracted.bytes,
    metadata: {
      codec: 'PCMU', sampleRate: PHONE_TTS_SAMPLE_RATE, channels: 1,
      container: extracted.container, contentType: normalizedContentType(contentType),
      ...inspectPcmu(extracted.bytes),
    },
  };
}

function extractPcm16LePayload(input, contentType = '') {
  const bytes = asBytes(input);
  const type = normalizedContentType(contentType);
  if (!bytes.byteLength) throw new Error('phone_tts_pcm_fallback_empty_audio');
  const kind = detectAudioKind(bytes);
  if (kind === 'text' || type === 'application/json' || type.startsWith('text/')) throw new Error('phone_tts_pcm_fallback_text_payload');
  if (isActualMp3Kind(kind)) throw new Error('phone_tts_pcm_fallback_actual_mp3');
  let data = bytes;
  let container = 'raw-pcm16le';
  if (kind === 'wav') {
    const parsed = parseWav(bytes);
    const { fmt } = parsed;
    if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== PHONE_TTS_SAMPLE_RATE || fmt.bitsPerSample !== 16) {
      throw new Error(`phone_tts_pcm_fallback_wav_format_${fmt.format}_${fmt.channels}_${fmt.sampleRate}_${fmt.bitsPerSample}`);
    }
    data = parsed.data;
    container = 'wav-pcm16le';
  } else if (WAV_CONTENT_TYPES.has(type)) {
    throw new Error('phone_tts_pcm_fallback_expected_wav');
  } else if (!EXPLICIT_RAW_PCM_CONTENT_TYPES.has(type) && !AMBIGUOUS_BINARY_CONTENT_TYPES.has(type) && !MP3_CONTENT_TYPES.has(type)) {
    throw new Error(`phone_tts_pcm_fallback_content_type_${type || 'empty'}`);
  } else if (MP3_CONTENT_TYPES.has(type)) {
    container = 'raw-pcm16le-mime-mismatch';
  }
  if (!data.byteLength || data.byteLength % 2 !== 0) throw new Error('phone_tts_pcm_fallback_invalid_length');
  const durationMs = Math.round((data.byteLength / 2 / PHONE_TTS_SAMPLE_RATE) * 1000);
  if (durationMs < PHONE_TTS_FRAME_MS) throw new Error('phone_tts_pcm_fallback_too_short');
  if (durationMs > PHONE_TTS_MAX_SECONDS * 1000) throw new Error('phone_tts_pcm_fallback_too_long');
  return { bytes: data, container, durationMs };
}

export function pcm16LeToMulaw(input) {
  const bytes = asBytes(input);
  if (bytes.byteLength % 2 !== 0) throw new Error('phone_tts_pcm_fallback_invalid_length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = encodeMuLawSample(view.getInt16(i * 2, true));
  return out;
}

function logObservedFormat(requestedCodec, bytes, contentType, extra = {}) {
  const kind = detectAudioKind(bytes);
  console.info(JSON.stringify({
    type: 'phone_tts_format_observed', requestedCodec,
    contentType: normalizedContentType(contentType), byteLength: bytes.byteLength,
    detectedKind: kind, ...extra,
  }));
  return kind;
}

function gatewayId(env = {}) {
  return String(env?.TELEPHONY_AI_GATEWAY_ID || 'default').trim() || 'default';
}

async function requestGrokAudio(env, spoken, outputFormat, options = {}) {
  const signal = options?.signal;
  const fetchImpl = options?.fetchImpl || fetch;
  const result = await env.AI.run(
    PHONE_TTS_MODEL,
    { text: spoken, voice_id: phoneTtsVoice(env), language: 'ja', output_format: outputFormat, text_normalization: false },
    { gateway: { id: gatewayId(env) }, signal },
  );
  const audioUrl = phoneTtsAudioUrl(result);
  if (!audioUrl) throw new Error('phone_tts_audio_url_missing');
  const response = await fetchImpl(audioUrl, signal ? { signal } : undefined);
  if (!response?.ok) throw new Error(`phone_tts_audio_fetch_${Number(response?.status || 0) || 'error'}`);
  const contentType = response.headers?.get?.('content-type') || '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error('phone_tts_empty_audio');
  return { bytes, contentType, result };
}

export async function synthesizeGrokPhonePcmu(env, text, options = {}) {
  if (!env?.AI || typeof env.AI.run !== 'function') throw new Error('workers_ai_unavailable');
  const spoken = normalizeJapaneseTtsText(text);
  if (!spoken) return null;

  const primary = await requestGrokAudio(env, spoken, { codec: 'mulaw', sample_rate: PHONE_TTS_SAMPLE_RATE }, options);
  const primaryKind = logObservedFormat('mulaw', primary.bytes, primary.contentType);
  try {
    const validated = validatePcmuResponse(primary.bytes, primary.contentType);
    return {
      ...validated,
      metadata: {
        ...validated.metadata, provider: 'cloudflare-ai-gateway', model: PHONE_TTS_MODEL,
        voice: phoneTtsVoice(env), language: 'ja', requestedCodec: 'mulaw', detectedKind: primaryKind,
        fallbackCodec: '', gatewayKeySource: String(primary.result?.gatewayMetadata?.keySource || primary.result?.response?.gatewayMetadata?.keySource || ''),
      },
    };
  } catch (error) {
    if (error?.message !== 'phone_tts_actual_mp3') throw error;
    console.warn(JSON.stringify({ type: 'phone_tts_codec_fallback', from: 'mulaw', to: 'pcm', reason: 'actual_mp3' }));
  }

  const fallback = await requestGrokAudio(env, spoken, { codec: 'pcm', sample_rate: PHONE_TTS_SAMPLE_RATE }, options);
  const fallbackKind = logObservedFormat('pcm', fallback.bytes, fallback.contentType, { fallback: true });
  const pcm = extractPcm16LePayload(fallback.bytes, fallback.contentType);
  const mulaw = pcm16LeToMulaw(pcm.bytes);
  const metrics = inspectPcmu(mulaw);
  return {
    bytes: mulaw,
    metadata: {
      codec: 'PCMU', sampleRate: PHONE_TTS_SAMPLE_RATE, channels: 1, container: pcm.container,
      contentType: normalizedContentType(fallback.contentType), ...metrics,
      provider: 'cloudflare-ai-gateway', model: PHONE_TTS_MODEL, voice: phoneTtsVoice(env), language: 'ja',
      requestedCodec: 'mulaw', detectedKind: fallbackKind, fallbackCodec: 'pcm',
      gatewayKeySource: String(fallback.result?.gatewayMetadata?.keySource || fallback.result?.response?.gatewayMetadata?.keySource || ''),
    },
  };
}

export async function synthesizePhonePcmu(env, text, deps = {}) {
  if (typeof deps?.synthesize === 'function') {
    const provided = await deps.synthesize(text);
    let bytes;
    if (typeof provided === 'string') bytes = base64ToBytes(provided.trim());
    else bytes = asBytes(provided);
    const validated = validatePcmuResponse(bytes, 'audio/basic');
    return { ...validated, metadata: { ...validated.metadata, provider: 'injected-test-tts', model: 'injected', voice: '', language: 'ja', gatewayKeySource: '' } };
  }
  return synthesizeGrokPhonePcmu(env, text, deps);
}

function defaultSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function streamPcmu20ms(bytesInput, options = {}) {
  const bytes = asBytes(bytesInput);
  const sendPayload = options?.sendPayload;
  if (typeof sendPayload !== 'function') throw new Error('phone_tts_send_missing');
  const isCancelled = typeof options?.isCancelled === 'function' ? options.isCancelled : () => false;
  const sleep = options?.sleep || defaultSleep;
  const frameMs = Number(options?.frameMs || PHONE_TTS_FRAME_MS);
  let frames = 0;
  let sentBytes = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += PHONE_TTS_FRAME_BYTES) {
    if (isCancelled()) return { completed: false, cancelled: true, frames, sentBytes };
    const chunk = bytes.subarray(offset, Math.min(offset + PHONE_TTS_FRAME_BYTES, bytes.byteLength));
    sendPayload(bytesToBase64(chunk));
    frames += 1;
    sentBytes += chunk.byteLength;
    if (offset + PHONE_TTS_FRAME_BYTES < bytes.byteLength) {
      await sleep(frameMs);
      if (isCancelled()) return { completed: false, cancelled: true, frames, sentBytes };
    }
  }
  return { completed: true, cancelled: false, frames, sentBytes };
}
