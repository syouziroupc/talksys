import loadSpeexWorkerModule from './vendor/speex-worker.js';
import speexWasmModule from './vendor/speex-worker.wasm';

export const SPEEX_RUNTIME_KIND = 'workerd-compiled-wasm';
let modulePromise = null;

export function loadSpeexRuntimeModule() {
  if (!modulePromise) {
    modulePromise = loadSpeexWorkerModule({
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(speexWasmModule, imports);
        receiveInstance(instance, speexWasmModule);
        return instance.exports;
      },
    }).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}
