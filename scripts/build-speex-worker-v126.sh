#!/usr/bin/env bash
set -euo pipefail

work=/tmp/talksys-speex-worker
rm -rf "$work"
git clone --branch v0.4.0 --depth 1 https://github.com/sapphi-red/speex-preprocess-wasm.git "$work"
git -C "$work" config -f .gitmodules submodule.build/speexdsp.url https://github.com/xiph/speexdsp.git
git -C "$work" submodule sync --recursive
git -C "$work" submodule update --init --depth 1 --recursive

python - <<'PY'
from pathlib import Path
p=Path('/tmp/talksys-speex-worker/build/build-wasm.sh')
s=p.read_text()
old="-s INCOMING_MODULE_JS_API=\"['wasmBinary']\""
new="-s INCOMING_MODULE_JS_API=\"['wasmBinary','instantiateWasm']\""
if s.count(old) != 1:
    raise SystemExit(f'expected one Emscripten incoming API declaration, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))
PY

docker run --rm \
  -v "$work:/src" \
  -w /src \
  emscripten/emsdk:3.1.74 \
  bash -lc 'apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends autoconf automake libtool pkg-config >/dev/null && bash build/build-wasm.sh'

test -s "$work/wasm-out/speex.js"
test -s "$work/wasm-out/speex.wasm"
mkdir -p src/telephony/vendor
cp "$work/wasm-out/speex.js" src/telephony/vendor/speex-worker.js
cp "$work/wasm-out/speex.wasm" src/telephony/vendor/speex-worker.wasm
cat > src/telephony/vendor/SPEEX_WORKER_NOTICE.md <<'EOF'
# SpeexDSP Worker build

Source: `sapphi-red/speex-preprocess-wasm` tag `v0.4.0` and its pinned SpeexDSP submodule.

The DSP code is unchanged. The build interface adds Emscripten `instantiateWasm` to `INCOMING_MODULE_JS_API` so Cloudflare's precompiled `WebAssembly.Module` can be supplied without runtime byte compilation.
EOF

echo "Built Worker Speex: $(wc -c < src/telephony/vendor/speex-worker.wasm) wasm bytes"
