import { loadSpeexModule } from '@sapphi-red/speex-preprocess-wasm';
import { SPEEX_WASM_BASE64 } from './speex-wasm-binary.js';

export const SPEEX_RUNTIME_KIND = 'node-wasm-binary';
let modulePromise = null;

export function loadSpeexRuntimeModule() {
  if (!modulePromise) {
    const decoded = atob(SPEEX_WASM_BASE64);
    const wasmBinary = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) wasmBinary[i] = decoded.charCodeAt(i);
    modulePromise = loadSpeexModule({ wasmBinary }).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}
