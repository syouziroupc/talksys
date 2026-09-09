import { normalizeJapaneseTtsText } from './cloudflare-japanese-tts.js';

export const GROK_TTS_MODEL_V29 = 'xai/grok-tts';
export const GROK_TTS_VOICE_V29 = 'ara';
export const GROK_TTS_LANGUAGE_V29 = 'ja';

function timeoutSignal(parentSignal, timeoutMs = 9000) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeout]) : parentSignal;
}

function audioValue(result) {
  if (!result) return null;
  if (result instanceof Response || result instanceof ArrayBuffer || result instanceof Uint8Array || result instanceof ReadableStream) return result;
  if (typeof result === 'string') return result;
  return result.audio ?? result.result?.audio ?? result.response?.audio ?? result.output?.audio ?? result.data?.audio ?? null;
}

function decodeBase64(value) {
  const source = String(value || '').trim().replace(/^data:audio\/[^;]+;base64,/i, '');
  if (!source) return null;
  try {
    const binary = atob(source);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

async function toAudioBuffer(value, signal) {
  if (!value) return null;
  if (value instanceof Response) {
    if (!value.ok) throw new Error(`Grok TTS audio response ${value.status}`);
    return value.arrayBuffer();
  }
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (value instanceof ReadableStream) return new Response(value).arrayBuffer();
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^https:\/\//i.test(text)) {
    const response = await fetch(text, { signal });
    if (!response.ok) throw new Error(`Grok TTS audio fetch ${response.status}`);
    return response.arrayBuffer();
  }
  return decodeBase64(text);
}

function stripWaveHeaderIfPresent(buffer) {
  const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
  if (bytes.length < 12) return buffer;
  const ascii = (start, len) => String.fromCharCode(...bytes.slice(start, start + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return buffer;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset, 4);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    const dataStart = offset + 8;
    if (id === 'data' && size >= 0 && dataStart + size <= bytes.length) {
      return bytes.slice(dataStart, dataStart + size).buffer;
    }
    offset = dataStart + Math.max(0, size) + (size % 2);
  }
  throw new Error('Grok telephony WAV contained no data chunk');
}

function ensureRawMulaw(buffer) {
  const raw = stripWaveHeaderIfPresent(buffer);
  const bytes = new Uint8Array(raw || new ArrayBuffer(0));
  if (!bytes.length) throw new Error('Grok TTS returned empty telephony audio');
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    throw new Error('Grok TTS returned MP3 instead of raw mulaw');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    throw new Error('Grok TTS returned MPEG audio instead of raw mulaw');
  }
  return raw;
}

export class GrokJapaneseTTSV29 {
  constructor(ai) {
    this.ai = ai;
    this.preferredProvider = 'grok-tts-ja-ara';
    this.lastProvider = '';
  }

  async run(spoken, outputFormat, signal) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bounded = timeoutSignal(signal, attempt === 0 ? 8500 : 10000);
      try {
        const result = await this.ai.run(
          GROK_TTS_MODEL_V29,
          {
            text: spoken,
            language: GROK_TTS_LANGUAGE_V29,
            voice_id: GROK_TTS_VOICE_V29,
            text_normalization: true,
            output_format: outputFormat,
          },
          bounded ? { signal: bounded } : undefined,
        );
        const audio = await toAudioBuffer(audioValue(result), bounded);
        if (!audio || !audio.byteLength) throw new Error('Grok TTS returned no playable audio');
        this.lastProvider = 'grok-tts';
        return audio;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    throw lastError || new Error('Grok TTS failed');
  }

  async synthesize(text, signal) {
    const spoken = normalizeJapaneseTtsText(text);
    if (!spoken) return null;
    return this.run(spoken, { codec: 'mp3', sample_rate: 24000, bit_rate: 64000 }, signal);
  }

  async synthesizeTelephony(text, signal) {
    const spoken = normalizeJapaneseTtsText(text);
    if (!spoken) return null;
    const audio = await this.run(spoken, { codec: 'mulaw', sample_rate: 8000 }, signal);
    return ensureRawMulaw(audio);
  }
}

export const __test = { stripWaveHeaderIfPresent, ensureRawMulaw };
