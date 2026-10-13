import { SpeexPreprocessor } from '@sapphi-red/speex-preprocess-wasm';
import { loadSpeexRuntimeModule, SPEEX_RUNTIME_KIND } from '#speex-runtime-loader';

export const PHONE_NOISE_SUPPRESSION_REVISION = 'talksys-phone-speex-v126-worker-r1';

function nowMs() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function configure(pre, { noiseSuppressDb, probStart, probContinue }) {
  pre.denoise = true;
  pre.agc = false;
  pre.vad = true;
  pre.noiseSuppress = noiseSuppressDb;
  pre.probStart = probStart;
  pre.probContinue = probContinue;
}

function destroyPreprocessor(pre, mod) {
  if (!pre) return;
  const state = pre.state;
  if (state && typeof mod?._speex_preprocess_state_destroy === 'function') {
    mod._speex_preprocess_state_destroy(state);
    pre.state = 0;
  }
  pre.destroy();
}

let selfTestPromise = null;
export function phoneNoiseSuppressionSelfTest() {
  if (!selfTestPromise) {
    selfTestPromise = (async () => {
      const mod = await loadSpeexRuntimeModule();
      const pre = new SpeexPreprocessor(mod, 160, 8000);
      try {
        configure(pre, { noiseSuppressDb: -12, probStart: 42, probContinue: 20 });
        let x = 0x12345678;
        let processedFrames = 0;
        for (let f = 0; f < 24; f += 1) {
          const samples = new Int16Array(160);
          for (let i = 0; i < samples.length; i += 1) {
            x = (1664525 * x + 1013904223) >>> 0;
            const noise = ((x / 0xffffffff) * 2 - 1) * 420;
            const voice = f >= 12 ? Math.sin(2 * Math.PI * 220 * i / 8000) * 900 : 0;
            samples[i] = Math.round(noise + voice);
          }
          pre.processInt16(samples);
          processedFrames += 1;
        }
        return {
          ok: true,
          revision: PHONE_NOISE_SUPPRESSION_REVISION,
          runtimeKind: SPEEX_RUNTIME_KIND,
          processedFrames,
          probability: Math.max(0, Math.min(100, Number(pre.prob) || 0)),
        };
      } finally {
        destroyPreprocessor(pre, mod);
      }
    })().catch((error) => ({
      ok: false,
      revision: PHONE_NOISE_SUPPRESSION_REVISION,
      runtimeKind: SPEEX_RUNTIME_KIND,
      error: String(error?.message || error || 'speex-self-test-failed').slice(0, 240),
    }));
  }
  return selfTestPromise;
}

export async function createPhoneNoiseSuppressor({ frameSize = 160, sampleRate = 8000, noiseSuppressDb = -12, probStart = 42, probContinue = 20 } = {}) {
  const mod = await loadSpeexRuntimeModule();
  const pre = new SpeexPreprocessor(mod, frameSize, sampleRate);
  configure(pre, { noiseSuppressDb, probStart, probContinue });
  let destroyed = false;

  return {
    revision: PHONE_NOISE_SUPPRESSION_REVISION,
    runtimeKind: SPEEX_RUNTIME_KIND,
    process(frame) {
      const started = nowMs();
      if (destroyed || !(frame instanceof Int16Array) || frame.length !== frameSize) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: 'invalid-frame' };
      }
      try {
        const samples = Int16Array.from(frame);
        const speech = pre.processInt16(samples);
        const probability = Math.max(0, Math.min(100, Number(pre.prob) || 0));
        return { ok: true, samples, speech, probability, elapsedMs: nowMs() - started, fallback: '' };
      } catch (error) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: String(error?.message || error || 'speex-error').slice(0, 120) };
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyPreprocessor(pre, mod);
    },
  };
}
