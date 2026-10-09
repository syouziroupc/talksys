import { normalizeJapaneseTtsText } from '../cloudflare-japanese-tts.js';
import { base64ToBytes, bytesToBase64, decodeMuLawByte } from './codec.js';

export const PHONE_TTS_MODEL = 'xai/grok-tts';
export const PHONE_TTS_DEFAULT_VOICE = 'ara';
export const PHONE_TTS_SAMPLE_RATE = 8000;
export const PHONE_TTS_FRAME_MS = 20;
export const PHONE_TTS_FRAME_BYTES = 160;
export const PHONE_TTS_MAX_SECONDS = 120;

const EXPLICIT_RAW_PCMU_CONTENT_TYPES = new Set([
  'audio/basic',
  'audio/mulaw',
  'audio/x-mulaw',
]);
const AMBIGUOUS_BINARY_CONTENT_TYPES = new Set(['', 'application/octet-stream']);
const WAV_CONTENT_TYPES = new Set(['audio/wav', 'audio/wave', 'audio/x-wav']);

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

function looksLikeMp3(bytes) {
  if (bytes.byteLength >= 3 && ascii(bytes, 0, 3) === 'ID3') return true;
  return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function looksLikeTextOrJson(bytes) {
  if (!bytes.byteLength) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(96, bytes.byteLength))).trimStart();
  return head.startsWith('{') || head.startsWith('[') || head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.startsWith('<?xml');
}

export function phoneTtsVoice(env = {}) {
  const configured = String(env?.TELEPHONY_TTS_VOICE || '').trim().toLowerCase();
  return PHONE_TTS_VOICES.has(configured) ? configured : PHONE_TTS_DEFAULT_VOICE;
}

export function phoneTtsAudioUrl(result) {
  const candidates = [
    result?.result?.audio,
    result?.audio,
    result?.response?.result?.audio,
    result?.response?.audio,
  ];
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

  if (type === 'audio/mpeg' || type === 'audio/mp3') {
    throw new Error('phone_tts_unexpected_mp3');
  }
  if (type === 'application/json' || type.startsWith('text/')) {
    throw new Error('phone_tts_unexpected_text_payload');
  }

  const riff = bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
  if (!riff) {
    if (WAV_CONTENT_TYPES.has(type)) throw new Error('phone_tts_expected_wav_container');
    if (EXPLICIT_RAW_PCMU_CONTENT_TYPES.has(type)) return { bytes, container: 'raw' };
    if (AMBIGUOUS_BINARY_CONTENT_TYPES.has(type)) {
      if (looksLikeMp3(bytes)) throw new Error('phone_tts_unexpected_mp3');
      if (looksLikeTextOrJson(bytes)) throw new Error('phone_tts_unexpected_text_payload');
      return { bytes, container: 'raw' };
    }
    throw new Error(`phone_tts_unexpected_content_type_${type || 'empty'}`);
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
  if (fmt.format !== 7 || fmt.channels !== 1 || fmt.sampleRate !== PHONE_TTS_SAMPLE_RATE || fmt.bitsPerSample !== 8) {
    throw new Error(`phone_tts_unexpected_wav_format_${fmt.format}_${fmt.channels}_${fmt.sampleRate}_${fmt.bitsPerSample}`);
  }
  if (!data.byteLength) throw new Error('phone_tts_empty_audio');
  return { bytes: data, container: 'wav-mulaw' };
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
  const silenceRatio = silent / bytes.byteLength;
  return {
    byteLength: bytes.byteLength,
    durationMs,
    rms: Number(rms.toFixed(6)),
    peak: Number(peak.toFixed(6)),
    silenceRatio: Number(silenceRatio.toFixed(6)),
  };
}

export function validatePcmuResponse(input, contentType = '') {
  const extracted = extractMulawPayload(input, contentType);
  return {
    bytes: extracted.bytes,
    metadata: {
      codec: 'PCMU',
      sampleRate: PHONE_TTS_SAMPLE_RATE,
      channels: 1,
      container: extracted.container,
      contentType: normalizedContentType(contentType),
      ...inspectPcmu(extracted.bytes),
    },
  };
}

function gatewayId(env = {}) {
  return String(env?.TELEPHONY_AI_GATEWAY_ID || 'default').trim() || 'default';
}

export async function synthesizeGrokPhonePcmu(env, text, options = {}) {
  if (!env?.AI || typeof env.AI.run !== 'function') throw new Error('workers_ai_unavailable');
  const spoken = normalizeJapaneseTtsText(text);
  if (!spoken) return null;
  const signal = options?.signal;
  const fetchImpl = options?.fetchImpl || fetch;
  const result = await env.AI.run(
    PHONE_TTS_MODEL,
    {
      text: spoken,
      voice_id: phoneTtsVoice(env),
      language: 'ja',
      output_format: { codec: 'mulaw', sample_rate: PHONE_TTS_SAMPLE_RATE },
      text_normalization: false,
    },
    { gateway: { id: gatewayId(env) }, signal },
  );
  const audioUrl = phoneTtsAudioUrl(result);
  if (!audioUrl) throw new Error('phone_tts_audio_url_missing');
  const response = await fetchImpl(audioUrl, signal ? { signal } : undefined);
  if (!response?.ok) throw new Error(`phone_tts_audio_fetch_${Number(response?.status || 0) || 'error'}`);
  const contentType = response.headers?.get?.('content-type') || '';
  const validated = validatePcmuResponse(await response.arrayBuffer(), contentType);
  return {
    ...validated,
    metadata: {
      ...validated.metadata,
      provider: 'cloudflare-ai-gateway',
      model: PHONE_TTS_MODEL,
      voice: phoneTtsVoice(env),
      language: 'ja',
      gatewayKeySource: String(result?.gatewayMetadata?.keySource || result?.response?.gatewayMetadata?.keySource || ''),
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
    return {
      ...validated,
      metadata: { ...validated.metadata, provider: 'injected-test-tts', model: 'injected', voice: '', language: 'ja', gatewayKeySource: '' },
    };
  }
  return synthesizeGrokPhonePcmu(env, text, deps);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
