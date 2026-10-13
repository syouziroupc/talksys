# SpeexDSP Worker build

Source: `sapphi-red/speex-preprocess-wasm` tag `v0.4.0` and its pinned SpeexDSP submodule.

The DSP code is unchanged. The build interface adds Emscripten `instantiateWasm` to `INCOMING_MODULE_JS_API` so Cloudflare's precompiled `WebAssembly.Module` can be supplied without runtime byte compilation. The generic Emscripten `self.location.href` URL probe is removed because workerd has no browser Worker `location`, and this build never discovers or fetches Wasm by URL.
