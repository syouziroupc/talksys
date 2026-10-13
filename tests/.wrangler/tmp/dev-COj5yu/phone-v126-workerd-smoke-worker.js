var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// wrangler-modules-watch:wrangler:modules-watch
var init_wrangler_modules_watch = __esm({
  "wrangler-modules-watch:wrangler:modules-watch"() {
    init_modules_watch_stub();
  }
});

// ../node_modules/wrangler/templates/modules-watch-stub.js
var init_modules_watch_stub = __esm({
  "../node_modules/wrangler/templates/modules-watch-stub.js"() {
    init_wrangler_modules_watch();
  }
});

// ../node_modules/@sapphi-red/speex-preprocess-wasm/dist/index.js
var SpeexPreprocessCtlRequest, I16_BYTE_SIZE, I32_BYTE_SIZE, F32_BYTE_SIZE, I16_MAX_NUMBER, SpeexPreprocessor;
var init_dist = __esm({
  "../node_modules/@sapphi-red/speex-preprocess-wasm/dist/index.js"() {
    init_modules_watch_stub();
    SpeexPreprocessCtlRequest = {
      /** Set preprocessor denoiser state */
      SET_DENOISE: 0,
      /** Get preprocessor denoiser state */
      GET_DENOISE: 1,
      /** Set preprocessor Automatic Gain Control state */
      SET_AGC: 2,
      /** Get preprocessor Automatic Gain Control state */
      GET_AGC: 3,
      /** Set preprocessor Voice Activity Detection state */
      SET_VAD: 4,
      /** Get preprocessor Voice Activity Detection state */
      GET_VAD: 5,
      /** Set preprocessor Automatic Gain Control level (float) */
      SET_AGC_LEVEL: 6,
      /** Get preprocessor Automatic Gain Control level (float) */
      GET_AGC_LEVEL: 7,
      // NOTE: de-reverberation is currently disabled
      // /** Set preprocessor dereverb state */
      // SET_DEREVERB: 8,
      // /** Get preprocessor dereverb state */
      // GET_DEREVERB: 9,
      // NOTE: de-reverberation is currently disabled
      // /** Set preprocessor dereverb level */
      // SET_DEREVERB_LEVEL: 10,
      // /** Get preprocessor dereverb level */
      // GET_DEREVERB_LEVEL: 11,
      // NOTE: de-reverberation is currently disabled
      // /** Set preprocessor dereverb decay */
      // SET_DEREVERB_DECAY: 12,
      // /** Get preprocessor dereverb decay */
      // GET_DEREVERB_DECAY: 13,
      /** Set probability required for the VAD to go from silence to voice */
      SET_PROB_START: 14,
      /** Get probability required for the VAD to go from silence to voice */
      GET_PROB_START: 15,
      /** Set probability required for the VAD to stay in the voice state (integer percent) */
      SET_PROB_CONTINUE: 16,
      /** Get probability required for the VAD to stay in the voice state (integer percent) */
      GET_PROB_CONTINUE: 17,
      /** Set maximum attenuation of the noise in dB (negative number) */
      SET_NOISE_SUPPRESS: 18,
      /** Get maximum attenuation of the noise in dB (negative number) */
      GET_NOISE_SUPPRESS: 19,
      /** Set maximum attenuation of the residual echo in dB (negative number) */
      SET_ECHO_SUPPRESS: 20,
      /** Get maximum attenuation of the residual echo in dB (negative number) */
      GET_ECHO_SUPPRESS: 21,
      /** Set maximum attenuation of the residual echo in dB when near end is active (negative number) */
      SET_ECHO_SUPPRESS_ACTIVE: 22,
      /** Get maximum attenuation of the residual echo in dB when near end is active (negative number) */
      GET_ECHO_SUPPRESS_ACTIVE: 23,
      // NOTE: needs SpeexEchoState pointer
      // /** Set the corresponding echo canceller state so that residual echo suppression can be performed (NULL for no residual echo suppression) */
      // SET_ECHO_STATE: 24,
      // /** Get the corresponding echo canceller state */
      // GET_ECHO_STATE: 25,
      /** Set maximal gain increase in dB/second (int32) */
      SET_AGC_INCREMENT: 26,
      /** Get maximal gain increase in dB/second (int32) */
      GET_AGC_INCREMENT: 27,
      /** Set maximal gain decrease in dB/second (int32) */
      SET_AGC_DECREMENT: 28,
      /** Get maximal gain decrease in dB/second (int32) */
      GET_AGC_DECREMENT: 29,
      /** Set maximal gain in dB (int32) */
      SET_AGC_MAX_GAIN: 30,
      /** Get maximal gain in dB (int32) */
      GET_AGC_MAX_GAIN: 31,
      /*  Can't set loudness */
      /** Get loudness */
      GET_AGC_LOUDNESS: 33,
      /*  Can't set gain */
      /** Get current gain (int32 percent) */
      GET_AGC_GAIN: 35,
      /*  Can't set spectrum size */
      /** Get spectrum size for power spectrum (int32) */
      GET_PSD_SIZE: 37,
      /*  Can't set power spectrum */
      /** Get power spectrum (int32[] of squared values) */
      GET_PSD: 39,
      /*  Can't set noise size */
      /** Get spectrum size for noise estimate (int32)  */
      GET_NOISE_PSD_SIZE: 41,
      /*  Can't set noise estimate */
      /** Get noise estimate (int32[] of squared values) */
      GET_NOISE_PSD: 43,
      /* Can't set speech probability */
      /** Get speech probability in last frame (int32).  */
      GET_PROB: 45,
      /** Set preprocessor Automatic Gain Control level (int32) */
      SET_AGC_TARGET: 46,
      /** Get preprocessor Automatic Gain Control level (int32) */
      GET_AGC_TARGET: 47
    };
    I16_BYTE_SIZE = Int16Array.BYTES_PER_ELEMENT;
    I32_BYTE_SIZE = Int32Array.BYTES_PER_ELEMENT;
    F32_BYTE_SIZE = Float32Array.BYTES_PER_ELEMENT;
    I16_MAX_NUMBER = 2 ** 16 / 2 - 1;
    SpeexPreprocessor = class {
      static {
        __name(this, "SpeexPreprocessor");
      }
      constructor(speexModule, frameSize, samplingRate) {
        this.speexModule = speexModule;
        this.frameSize = frameSize;
        this.samplingRate = samplingRate;
        this.state = this.speexModule._speex_preprocess_state_init(
          this.frameSize,
          this.samplingRate
        );
        this.processBuffPtr = this.speexModule._malloc(
          this.frameSize * I16_BYTE_SIZE
        );
        this.processI16Buff = new Int16Array(this.frameSize);
        if (!this.processBuffPtr) {
          this.destroy();
          throw Error("Failed to allocate process buffer.");
        }
      }
      mallocCtlBuffPtr() {
        if (this.ctlBuffPtr !== void 0) return;
        this.ctlBuffPtr = this.speexModule._malloc(
          4
          /** I32_BYTE_SIZE && F32_BYTE_SIZE */
        );
        if (!this.ctlBuffPtr) {
          throw Error("Failed to allocate ctl buffer.");
        }
      }
      ctl(req, output) {
        const res = this.speexModule._speex_preprocess_ctl(this.state, req, output);
        if (res === -1) {
          throw new Error(`Unknown request: ${req}`);
        }
      }
      ctlGetI32(req) {
        this.mallocCtlBuffPtr();
        const ctlBuffIndex = this.ctlBuffPtr / I32_BYTE_SIZE;
        this.ctl(req, this.ctlBuffPtr);
        return this.speexModule.HEAP32[ctlBuffIndex];
      }
      ctlSetI32(req, value) {
        this.mallocCtlBuffPtr();
        const ctlBuffIndex = this.ctlBuffPtr / I32_BYTE_SIZE;
        this.speexModule.HEAP32[ctlBuffIndex] = value;
        this.ctl(req, this.ctlBuffPtr);
      }
      ctlGetBool(req) {
        return this.ctlGetI32(req) === 1;
      }
      ctlSetBool(req, value) {
        this.ctlSetI32(req, value ? 1 : 0);
      }
      ctlGetF32(req) {
        this.mallocCtlBuffPtr();
        const ctlBuffIndex = this.ctlBuffPtr / F32_BYTE_SIZE;
        this.ctl(req, this.ctlBuffPtr);
        return this.speexModule.HEAPF32[ctlBuffIndex];
      }
      ctlSetF32(req, value) {
        this.mallocCtlBuffPtr();
        const ctlBuffIndex = this.ctlBuffPtr / F32_BYTE_SIZE;
        this.speexModule.HEAPF32[ctlBuffIndex] = value;
        this.ctl(req, this.ctlBuffPtr);
      }
      ctlGetI32Array(req, size) {
        const buffPtr = this.speexModule._malloc(size * I32_BYTE_SIZE);
        const buffIndex = buffPtr / I32_BYTE_SIZE;
        this.ctl(req, buffPtr);
        const result = new Int32Array(size);
        const res = this.speexModule.HEAP32.subarray(buffIndex, buffIndex + size);
        result.set(res);
        this.speexModule._free(buffPtr);
        return result;
      }
      get denoise() {
        return this.ctlGetBool(SpeexPreprocessCtlRequest.GET_DENOISE);
      }
      set denoise(value) {
        this.ctlSetBool(SpeexPreprocessCtlRequest.SET_DENOISE, value);
      }
      get agc() {
        return this.ctlGetBool(SpeexPreprocessCtlRequest.GET_AGC);
      }
      set agc(value) {
        this.ctlSetBool(SpeexPreprocessCtlRequest.SET_AGC, value);
      }
      get vad() {
        return this.ctlGetBool(SpeexPreprocessCtlRequest.GET_VAD);
      }
      set vad(value) {
        this.ctlSetBool(SpeexPreprocessCtlRequest.SET_VAD, value);
      }
      get agcLevel() {
        return this.ctlGetF32(SpeexPreprocessCtlRequest.GET_AGC_LEVEL);
      }
      set agcLevel(value) {
        this.ctlSetF32(SpeexPreprocessCtlRequest.SET_AGC_LEVEL, value);
      }
      get probStart() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PROB_START);
      }
      set probStart(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_PROB_START, value);
      }
      get probContinue() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PROB_CONTINUE);
      }
      set probContinue(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_PROB_CONTINUE, value);
      }
      get noiseSuppress() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_NOISE_SUPPRESS);
      }
      set noiseSuppress(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_NOISE_SUPPRESS, value);
      }
      get echoSuppress() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_ECHO_SUPPRESS);
      }
      set echoSuppress(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_ECHO_SUPPRESS, value);
      }
      get echoSuppressActive() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_ECHO_SUPPRESS_ACTIVE);
      }
      set echoSuppressActive(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_ECHO_SUPPRESS_ACTIVE, value);
      }
      get agcIncrement() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_INCREMENT);
      }
      set agcIncrement(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_INCREMENT, value);
      }
      get agcDecrement() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_DECREMENT);
      }
      set agcDecrement(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_DECREMENT, value);
      }
      get agcMaxGain() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_MAX_GAIN);
      }
      set agcMaxGain(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_MAX_GAIN, value);
      }
      get agcLoudness() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_LOUDNESS);
      }
      get agcGain() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_GAIN);
      }
      get psdSize() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PSD_SIZE);
      }
      get psd() {
        return this.ctlGetI32Array(SpeexPreprocessCtlRequest.GET_PSD, this.psdSize);
      }
      get noisePsdSize() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_NOISE_PSD_SIZE);
      }
      get noisePsd() {
        return this.ctlGetI32Array(
          SpeexPreprocessCtlRequest.GET_NOISE_PSD,
          this.noisePsdSize
        );
      }
      get prob() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_PROB);
      }
      get agcTarget() {
        return this.ctlGetI32(SpeexPreprocessCtlRequest.GET_AGC_TARGET);
      }
      set agcTarget(value) {
        this.ctlSetI32(SpeexPreprocessCtlRequest.SET_AGC_TARGET, value);
      }
      assertFrameSize(frame) {
        if (frame.length !== this.frameSize) {
          throw new Error(
            `Frame size differs. Expected: ${this.frameSize}. Actual: ${frame.length}.`
          );
        }
      }
      processInt16(frame) {
        this.assertFrameSize(frame);
        const processBuffIndex = this.processBuffPtr / I16_BYTE_SIZE;
        this.speexModule.HEAP16.set(frame, processBuffIndex);
        const vad = this.speexModule._speex_preprocess_run(
          this.state,
          this.processBuffPtr
        );
        const processedBuff = this.speexModule.HEAP16.subarray(
          processBuffIndex,
          processBuffIndex + this.frameSize
        );
        frame.set(processedBuff);
        return vad === 1;
      }
      process(frame) {
        this.assertFrameSize(frame);
        for (let i = 0; i < frame.length; i++) {
          this.processI16Buff[i] = frame[i] * I16_MAX_NUMBER;
        }
        const vad = this.processInt16(this.processI16Buff);
        for (let i = 0; i < frame.length; i++) {
          frame[i] = this.processI16Buff[i] / I16_MAX_NUMBER;
        }
        return vad;
      }
      destroy() {
        this.speexModule._free(this.processBuffPtr);
        if (this.ctlBuffPtr !== void 0) {
          this.speexModule._free(this.ctlBuffPtr);
        }
      }
    };
  }
});

// ../src/telephony/vendor/speex-worker.js
var Module, speex_worker_default;
var init_speex_worker = __esm({
  "../src/telephony/vendor/speex-worker.js"() {
    init_modules_watch_stub();
    Module = (() => {
      var _scriptName = import.meta.url;
      return (function(moduleArg = {}) {
        var moduleRtn;
        var Module2 = moduleArg;
        var readyPromiseResolve, readyPromiseReject;
        var readyPromise = new Promise((resolve, reject) => {
          readyPromiseResolve = resolve;
          readyPromiseReject = reject;
        });
        var ENVIRONMENT_IS_WEB = typeof window == "object";
        var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
        var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
        var moduleOverrides = Object.assign({}, Module2);
        var scriptDirectory = "";
        function locateFile(path) {
          return scriptDirectory + path;
        }
        __name(locateFile, "locateFile");
        var readAsync, readBinary;
        if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
          if (ENVIRONMENT_IS_WORKER) {
            scriptDirectory = "";
          } else if (typeof document != "undefined" && document.currentScript) {
            scriptDirectory = document.currentScript.src;
          }
          if (_scriptName) {
            scriptDirectory = _scriptName;
          }
          if (scriptDirectory.startsWith("blob:")) {
            scriptDirectory = "";
          } else {
            scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
          }
          {
            if (ENVIRONMENT_IS_WORKER) {
              readBinary = /* @__PURE__ */ __name((url) => {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.responseType = "arraybuffer";
                xhr.send(null);
                return new Uint8Array(xhr.response);
              }, "readBinary");
            }
            readAsync = /* @__PURE__ */ __name(async (url) => {
              var response = await fetch(url, { credentials: "same-origin" });
              if (response.ok) {
                return response.arrayBuffer();
              }
              throw new Error(response.status + " : " + response.url);
            }, "readAsync");
          }
        } else {
        }
        var out = console.log.bind(console);
        var err = console.error.bind(console);
        Object.assign(Module2, moduleOverrides);
        moduleOverrides = null;
        var wasmBinary = Module2["wasmBinary"];
        var wasmMemory;
        var ABORT = false;
        var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
        function updateMemoryViews() {
          var b = wasmMemory.buffer;
          HEAP8 = new Int8Array(b);
          Module2["HEAP16"] = HEAP16 = new Int16Array(b);
          HEAPU8 = new Uint8Array(b);
          HEAPU16 = new Uint16Array(b);
          Module2["HEAP32"] = HEAP32 = new Int32Array(b);
          HEAPU32 = new Uint32Array(b);
          Module2["HEAPF32"] = HEAPF32 = new Float32Array(b);
          HEAPF64 = new Float64Array(b);
        }
        __name(updateMemoryViews, "updateMemoryViews");
        var __ATPRERUN__ = [];
        var __ATINIT__ = [];
        var __ATPOSTRUN__ = [];
        var runtimeInitialized = false;
        function preRun() {
          callRuntimeCallbacks(__ATPRERUN__);
        }
        __name(preRun, "preRun");
        function initRuntime() {
          runtimeInitialized = true;
          callRuntimeCallbacks(__ATINIT__);
        }
        __name(initRuntime, "initRuntime");
        function postRun() {
          callRuntimeCallbacks(__ATPOSTRUN__);
        }
        __name(postRun, "postRun");
        function addOnInit(cb) {
          __ATINIT__.unshift(cb);
        }
        __name(addOnInit, "addOnInit");
        var runDependencies = 0;
        var dependenciesFulfilled = null;
        function addRunDependency(id) {
          runDependencies++;
        }
        __name(addRunDependency, "addRunDependency");
        function removeRunDependency(id) {
          runDependencies--;
          if (runDependencies == 0) {
            if (dependenciesFulfilled) {
              var callback = dependenciesFulfilled;
              dependenciesFulfilled = null;
              callback();
            }
          }
        }
        __name(removeRunDependency, "removeRunDependency");
        function abort(what) {
          what = "Aborted(" + what + ")";
          err(what);
          ABORT = true;
          what += ". Build with -sASSERTIONS for more info.";
          var e = new WebAssembly.RuntimeError(what);
          readyPromiseReject(e);
          throw e;
        }
        __name(abort, "abort");
        var dataURIPrefix = "data:application/octet-stream;base64,";
        var isDataURI = /* @__PURE__ */ __name((filename) => filename.startsWith(dataURIPrefix), "isDataURI");
        function findWasmBinary() {
          if (Module2["locateFile"]) {
            var f = "speex.wasm";
            if (!isDataURI(f)) {
              return locateFile(f);
            }
            return f;
          }
          return new URL("speex.wasm", import.meta.url).href;
        }
        __name(findWasmBinary, "findWasmBinary");
        var wasmBinaryFile;
        function getBinarySync(file) {
          if (file == wasmBinaryFile && wasmBinary) {
            return new Uint8Array(wasmBinary);
          }
          if (readBinary) {
            return readBinary(file);
          }
          throw "both async and sync fetching of the wasm failed";
        }
        __name(getBinarySync, "getBinarySync");
        async function getWasmBinary(binaryFile) {
          if (!wasmBinary) {
            try {
              var response = await readAsync(binaryFile);
              return new Uint8Array(response);
            } catch {
            }
          }
          return getBinarySync(binaryFile);
        }
        __name(getWasmBinary, "getWasmBinary");
        async function instantiateArrayBuffer(binaryFile, imports) {
          try {
            var binary = await getWasmBinary(binaryFile);
            var instance = await WebAssembly.instantiate(binary, imports);
            return instance;
          } catch (reason) {
            err(`failed to asynchronously prepare wasm: ${reason}`);
            abort(reason);
          }
        }
        __name(instantiateArrayBuffer, "instantiateArrayBuffer");
        async function instantiateAsync(binary, binaryFile, imports) {
          if (!binary && typeof WebAssembly.instantiateStreaming == "function" && !isDataURI(binaryFile) && typeof fetch == "function") {
            try {
              var response = fetch(binaryFile, { credentials: "same-origin" });
              var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
              return instantiationResult;
            } catch (reason) {
              err(`wasm streaming compile failed: ${reason}`);
              err("falling back to ArrayBuffer instantiation");
            }
          }
          return instantiateArrayBuffer(binaryFile, imports);
        }
        __name(instantiateAsync, "instantiateAsync");
        function getWasmImports() {
          return { a: wasmImports };
        }
        __name(getWasmImports, "getWasmImports");
        async function createWasm() {
          function receiveInstance(instance, module) {
            wasmExports = instance.exports;
            wasmMemory = wasmExports["f"];
            updateMemoryViews();
            addOnInit(wasmExports["g"]);
            removeRunDependency("wasm-instantiate");
            return wasmExports;
          }
          __name(receiveInstance, "receiveInstance");
          addRunDependency("wasm-instantiate");
          function receiveInstantiationResult(result2) {
            receiveInstance(result2["instance"]);
          }
          __name(receiveInstantiationResult, "receiveInstantiationResult");
          var info = getWasmImports();
          if (Module2["instantiateWasm"]) {
            try {
              return Module2["instantiateWasm"](info, receiveInstance);
            } catch (e) {
              err(`Module.instantiateWasm callback failed with error: ${e}`);
              readyPromiseReject(e);
            }
          }
          wasmBinaryFile ??= findWasmBinary();
          try {
            var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
            receiveInstantiationResult(result);
            return result;
          } catch (e) {
            readyPromiseReject(e);
            return;
          }
        }
        __name(createWasm, "createWasm");
        class ExitStatus {
          static {
            __name(this, "ExitStatus");
          }
          name = "ExitStatus";
          constructor(status) {
            this.message = `Program terminated with exit(${status})`;
            this.status = status;
          }
        }
        var callRuntimeCallbacks = /* @__PURE__ */ __name((callbacks) => {
          while (callbacks.length > 0) {
            callbacks.shift()(Module2);
          }
        }, "callRuntimeCallbacks");
        var __emscripten_memcpy_js = /* @__PURE__ */ __name((dest, src, num) => HEAPU8.copyWithin(dest, src, src + num), "__emscripten_memcpy_js");
        var getHeapMax = /* @__PURE__ */ __name(() => 2147483648, "getHeapMax");
        var alignMemory = /* @__PURE__ */ __name((size, alignment) => Math.ceil(size / alignment) * alignment, "alignMemory");
        var growMemory = /* @__PURE__ */ __name((size) => {
          var b = wasmMemory.buffer;
          var pages = (size - b.byteLength + 65535) / 65536 | 0;
          try {
            wasmMemory.grow(pages);
            updateMemoryViews();
            return 1;
          } catch (e) {
          }
        }, "growMemory");
        var _emscripten_resize_heap = /* @__PURE__ */ __name((requestedSize) => {
          var oldSize = HEAPU8.length;
          requestedSize >>>= 0;
          var maxHeapSize = getHeapMax();
          if (requestedSize > maxHeapSize) {
            return false;
          }
          for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
            var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
            overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
            var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
            var replacement = growMemory(newSize);
            if (replacement) {
              return true;
            }
          }
          return false;
        }, "_emscripten_resize_heap");
        var _fd_close = /* @__PURE__ */ __name((fd) => 52, "_fd_close");
        var convertI32PairToI53Checked = /* @__PURE__ */ __name((lo, hi) => hi + 2097152 >>> 0 < 4194305 - !!lo ? (lo >>> 0) + hi * 4294967296 : NaN, "convertI32PairToI53Checked");
        function _fd_seek(fd, offset_low, offset_high, whence, newOffset) {
          var offset = convertI32PairToI53Checked(offset_low, offset_high);
          return 70;
        }
        __name(_fd_seek, "_fd_seek");
        var printCharBuffers = [null, [], []];
        var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
        var UTF8ArrayToString = /* @__PURE__ */ __name((heapOrArray, idx = 0, maxBytesToRead = NaN) => {
          var endIdx = idx + maxBytesToRead;
          var endPtr = idx;
          while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
          if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
            return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
          }
          var str = "";
          while (idx < endPtr) {
            var u0 = heapOrArray[idx++];
            if (!(u0 & 128)) {
              str += String.fromCharCode(u0);
              continue;
            }
            var u1 = heapOrArray[idx++] & 63;
            if ((u0 & 224) == 192) {
              str += String.fromCharCode((u0 & 31) << 6 | u1);
              continue;
            }
            var u2 = heapOrArray[idx++] & 63;
            if ((u0 & 240) == 224) {
              u0 = (u0 & 15) << 12 | u1 << 6 | u2;
            } else {
              u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
            }
            if (u0 < 65536) {
              str += String.fromCharCode(u0);
            } else {
              var ch = u0 - 65536;
              str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
            }
          }
          return str;
        }, "UTF8ArrayToString");
        var printChar = /* @__PURE__ */ __name((stream, curr) => {
          var buffer = printCharBuffers[stream];
          if (curr === 0 || curr === 10) {
            (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
            buffer.length = 0;
          } else {
            buffer.push(curr);
          }
        }, "printChar");
        var _fd_write = /* @__PURE__ */ __name((fd, iov, iovcnt, pnum) => {
          var num = 0;
          for (var i = 0; i < iovcnt; i++) {
            var ptr = HEAPU32[iov >> 2];
            var len = HEAPU32[iov + 4 >> 2];
            iov += 8;
            for (var j = 0; j < len; j++) {
              printChar(fd, HEAPU8[ptr + j]);
            }
            num += len;
          }
          HEAPU32[pnum >> 2] = num;
          return 0;
        }, "_fd_write");
        var wasmImports = { d: __emscripten_memcpy_js, e: _emscripten_resize_heap, c: _fd_close, b: _fd_seek, a: _fd_write };
        var wasmExports;
        createWasm();
        var ___wasm_call_ctors = /* @__PURE__ */ __name(() => (___wasm_call_ctors = wasmExports["g"])(), "___wasm_call_ctors");
        var _speex_preprocess_state_init = Module2["_speex_preprocess_state_init"] = (a0, a1) => (_speex_preprocess_state_init = Module2["_speex_preprocess_state_init"] = wasmExports["h"])(a0, a1);
        var _speex_preprocess_state_destroy = Module2["_speex_preprocess_state_destroy"] = (a0) => (_speex_preprocess_state_destroy = Module2["_speex_preprocess_state_destroy"] = wasmExports["i"])(a0);
        var _speex_preprocess_run = Module2["_speex_preprocess_run"] = (a0, a1) => (_speex_preprocess_run = Module2["_speex_preprocess_run"] = wasmExports["j"])(a0, a1);
        var _speex_preprocess_ctl = Module2["_speex_preprocess_ctl"] = (a0, a1, a2) => (_speex_preprocess_ctl = Module2["_speex_preprocess_ctl"] = wasmExports["k"])(a0, a1, a2);
        var _free = Module2["_free"] = (a0) => (_free = Module2["_free"] = wasmExports["l"])(a0);
        var _malloc = Module2["_malloc"] = (a0) => (_malloc = Module2["_malloc"] = wasmExports["m"])(a0);
        var calledRun;
        dependenciesFulfilled = /* @__PURE__ */ __name(function runCaller() {
          if (!calledRun) run();
          if (!calledRun) dependenciesFulfilled = runCaller;
        }, "runCaller");
        function run() {
          if (runDependencies > 0) {
            return;
          }
          preRun();
          if (runDependencies > 0) {
            return;
          }
          function doRun() {
            if (calledRun) return;
            calledRun = true;
            Module2["calledRun"] = true;
            if (ABORT) return;
            initRuntime();
            readyPromiseResolve(Module2);
            postRun();
          }
          __name(doRun, "doRun");
          {
            doRun();
          }
        }
        __name(run, "run");
        run();
        moduleRtn = readyPromise;
        return moduleRtn;
      });
    })();
    speex_worker_default = Module;
  }
});

// ../src/telephony/speex-worker-loader.js
import speexWasmModule from "./0317e281dd18920ed36d918b7771b405cb45cb70-speex-worker.wasm";
function loadSpeexRuntimeModule() {
  if (!modulePromise) {
    modulePromise = speex_worker_default({
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(speexWasmModule, imports);
        receiveInstance(instance, speexWasmModule);
        return instance.exports;
      }
    }).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}
var SPEEX_RUNTIME_KIND, modulePromise;
var init_speex_worker_loader = __esm({
  "../src/telephony/speex-worker-loader.js"() {
    init_modules_watch_stub();
    init_speex_worker();
    SPEEX_RUNTIME_KIND = "workerd-compiled-wasm";
    modulePromise = null;
    __name(loadSpeexRuntimeModule, "loadSpeexRuntimeModule");
  }
});

// ../src/telephony/phone-noise-suppressor.js
var phone_noise_suppressor_exports = {};
__export(phone_noise_suppressor_exports, {
  PHONE_NOISE_SUPPRESSION_REVISION: () => PHONE_NOISE_SUPPRESSION_REVISION,
  createPhoneNoiseSuppressor: () => createPhoneNoiseSuppressor,
  phoneNoiseSuppressionSelfTest: () => phoneNoiseSuppressionSelfTest
});
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
  if (state && typeof mod?._speex_preprocess_state_destroy === "function") {
    mod._speex_preprocess_state_destroy(state);
    pre.state = 0;
  }
  pre.destroy();
}
function phoneNoiseSuppressionSelfTest() {
  if (!selfTestPromise) {
    selfTestPromise = (async () => {
      const mod = await loadSpeexRuntimeModule();
      const pre = new SpeexPreprocessor(mod, 160, 8e3);
      try {
        configure(pre, { noiseSuppressDb: -12, probStart: 42, probContinue: 20 });
        let x = 305419896;
        let processedFrames = 0;
        for (let f = 0; f < 24; f += 1) {
          const samples = new Int16Array(160);
          for (let i = 0; i < samples.length; i += 1) {
            x = 1664525 * x + 1013904223 >>> 0;
            const noise = (x / 4294967295 * 2 - 1) * 420;
            const voice = f >= 12 ? Math.sin(2 * Math.PI * 220 * i / 8e3) * 900 : 0;
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
          probability: Math.max(0, Math.min(100, Number(pre.prob) || 0))
        };
      } finally {
        destroyPreprocessor(pre, mod);
      }
    })().catch((error) => ({
      ok: false,
      revision: PHONE_NOISE_SUPPRESSION_REVISION,
      runtimeKind: SPEEX_RUNTIME_KIND,
      error: String(error?.message || error || "speex-self-test-failed").slice(0, 240)
    }));
  }
  return selfTestPromise;
}
async function createPhoneNoiseSuppressor({ frameSize = 160, sampleRate = 8e3, noiseSuppressDb = -12, probStart = 42, probContinue = 20 } = {}) {
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
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: "invalid-frame" };
      }
      try {
        const samples = Int16Array.from(frame);
        const speech = pre.processInt16(samples);
        const probability = Math.max(0, Math.min(100, Number(pre.prob) || 0));
        return { ok: true, samples, speech, probability, elapsedMs: nowMs() - started, fallback: "" };
      } catch (error) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: String(error?.message || error || "speex-error").slice(0, 120) };
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyPreprocessor(pre, mod);
    }
  };
}
var PHONE_NOISE_SUPPRESSION_REVISION, selfTestPromise;
var init_phone_noise_suppressor = __esm({
  "../src/telephony/phone-noise-suppressor.js"() {
    init_modules_watch_stub();
    init_dist();
    init_speex_worker_loader();
    PHONE_NOISE_SUPPRESSION_REVISION = "talksys-phone-speex-v126-worker-r1";
    __name(nowMs, "nowMs");
    __name(configure, "configure");
    __name(destroyPreprocessor, "destroyPreprocessor");
    selfTestPromise = null;
    __name(phoneNoiseSuppressionSelfTest, "phoneNoiseSuppressionSelfTest");
    __name(createPhoneNoiseSuppressor, "createPhoneNoiseSuppressor");
  }
});

// .wrangler/tmp/bundle-OB6phK/middleware-loader.entry.ts
init_modules_watch_stub();

// .wrangler/tmp/bundle-OB6phK/middleware-insertion-facade.js
init_modules_watch_stub();

// phone-v126-workerd-smoke-worker.mjs
init_modules_watch_stub();
var phone_v126_workerd_smoke_worker_default = {
  async fetch() {
    try {
      const { phoneNoiseSuppressionSelfTest: phoneNoiseSuppressionSelfTest2 } = await Promise.resolve().then(() => (init_phone_noise_suppressor(), phone_noise_suppressor_exports));
      const result = await phoneNoiseSuppressionSelfTest2();
      return Response.json(result);
    } catch (error) {
      return Response.json({
        ok: false,
        stage: "dynamic-import-or-self-test",
        error: String(error?.message || error || "unknown workerd error").slice(0, 1e3),
        stack: String(error?.stack || "").slice(0, 3e3)
      });
    }
  }
};

// ../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
init_modules_watch_stub();
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
init_modules_watch_stub();
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-OB6phK/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = phone_v126_workerd_smoke_worker_default;

// ../node_modules/wrangler/templates/middleware/common.ts
init_modules_watch_stub();
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-OB6phK/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
/*! Bundled license information:

@sapphi-red/speex-preprocess-wasm/dist/index.js:
  (*!
  license of speex.wasm
  
  ---
  
  Copyright 2002-2008 	Xiph.org Foundation
  Copyright 2002-2008 	Jean-Marc Valin
  Copyright 2005-2007	Analog Devices Inc.
  Copyright 2005-2008	Commonwealth Scientific and Industrial Research
                          Organisation (CSIRO)
  Copyright 1993, 2002, 2006 David Rowe
  Copyright 2003 		EpicGames
  Copyright 1992-1994	Jutta Degener, Carsten Bormann
  
  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions
  are met:
  
  - Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
  
  - Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
  
  - Neither the name of the Xiph.org Foundation nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.
  
  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
  ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
  LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
  A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION OR
  CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
  EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
  *)
*/
//# sourceMappingURL=phone-v126-workerd-smoke-worker.js.map
