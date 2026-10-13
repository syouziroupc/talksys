import { loadSpeexModule, SpeexPreprocessor } from '@sapphi-red/speex-preprocess-wasm';
import { SPEEX_WASM_BASE64 } from './speex-wasm-binary.js';

export const PHONE_NOISE_SUPPRESSION_REVISION = 'talksys-phone-speex-v124-r1';

let modulePromise = null;

function nowMs() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

async function speexModule() {
  if (!modulePromise) {
    const decoded = atob(SPEEX_WASM_BASE64);
    const wasmBinary = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) wasmBinary[i] = decoded.charCodeAt(i);
    modulePromise = loadSpeexModule({ wasmBinary });
  }
  return modulePromise;
}

export async function createPhoneNoiseSuppressor({ frameSize = 160, sampleRate = 8000, noiseSuppressDb = -12, probStart = 42, probContinue = 20 } = {}) {
  const mod = await speexModule();
  const pre = new SpeexPreprocessor(mod, frameSize, sampleRate);
  pre.denoise = true;
  pre.agc = false; // Keep TalkSys' existing post-capture weak-speech normalization unchanged.
  pre.vad = true;
  pre.noiseSuppress = noiseSuppressDb;
  pre.probStart = probStart;
  pre.probContinue = probContinue;
  let destroyed = false;

  return {
    revision: PHONE_NOISE_SUPPRESSION_REVISION,
    process(frame) {
      const started = nowMs();
      if (destroyed || !(frame instanceof Int16Array) || frame.length !== frameSize) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: 'invalid-frame' };
      }
      try {
        const samples = Int16Array.from(frame);
        const speech = pre.processInt16(samples);
        return { ok: true, samples, speech, elapsedMs: nowMs() - started, fallback: '' };
      } catch (error) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: String(error?.message || error || 'speex-error').slice(0, 120) };
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pre.destroy();
    },
  };
}
