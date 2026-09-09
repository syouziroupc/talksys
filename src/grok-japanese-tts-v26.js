import { MeloJapaneseTTS } from './voice-helpers.js';
import { normalizeJapaneseTtsText } from './cloudflare-japanese-tts.js';

export const GROK_TTS_MODEL_V26 = 'xai/grok-tts';
export const GROK_TTS_VOICE_V26 = 'ara';
export const GROK_TTS_LANGUAGE_V26 = 'ja';

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

function audioValue(result) {
  if (!result) return null;
  if (result instanceof Response || result instanceof ArrayBuffer || result instanceof Uint8Array || result instanceof ReadableStream) return result;
  if (typeof result === 'string') return result;
  const candidates = [
    result.audio,
    result.result?.audio,
    result.response?.audio,
    result.output?.audio,
    result.data?.audio,
  ];
  return candidates.find((item) => item != null) ?? null;
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

function timeoutSignal(parentSignal, timeoutMs = 9000) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeout]) : parentSignal;
}

export class GrokJapaneseTTSV26 {
  constructor(ai) {
    this.ai = ai;
    this.melo = new MeloJapaneseTTS(ai);
    this.preferredProvider = 'grok-tts-ja-ara';
    this.lastProvider = '';
  }

  async synthesize(text, signal) {
    const spoken = normalizeJapaneseTtsText(text);
    if (!spoken) return null;
    const bounded = timeoutSignal(signal, 9000);

    try {
      const result = await this.ai.run(
        GROK_TTS_MODEL_V26,
        {
          text: spoken,
          language: GROK_TTS_LANGUAGE_V26,
          voice_id: GROK_TTS_VOICE_V26,
          text_normalization: true,
          output_format: {
            codec: 'mp3',
            sample_rate: 24000,
            bit_rate: 64000,
          },
        },
        bounded ? { signal: bounded } : undefined,
      );
      const audio = await toAudioBuffer(audioValue(result), bounded);
      if (audio && audio.byteLength > 0) {
        this.preferredProvider = 'grok-tts-ja-ara';
        this.lastProvider = 'grok-tts';
        return audio;
      }
      throw new Error('Grok TTS returned no playable audio');
    } catch {
      // Voice must remain available even when third-party Unified Billing or Grok has
      // a transient failure. The fallback is Cloudflare-hosted and very inexpensive.
      this.preferredProvider = 'melotts-ja-fallback';
      this.lastProvider = 'melotts';
      return this.melo.synthesize(spoken, signal);
    }
  }
}
