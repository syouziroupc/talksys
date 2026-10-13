from pathlib import Path
import base64

root = Path('node_modules/@sapphi-red/speex-preprocess-wasm')
wasm_files = sorted(root.rglob('*.wasm'), key=lambda p: p.stat().st_size, reverse=True)
if not wasm_files:
    raise SystemExit('Speex package contains no .wasm file')
wasm = wasm_files[0]
data = wasm.read_bytes()
if len(data) < 10_000 or len(data) > 2_000_000:
    raise SystemExit(f'unexpected Speex wasm size: {len(data)}')
encoded = base64.b64encode(data).decode('ascii')
Path('src/telephony/speex-wasm-binary.js').write_text(
    "// Generated from @sapphi-red/speex-preprocess-wasm@0.4.0 during guarded v124 build.\n"
    f"export const SPEEX_WASM_BASE64 = '{encoded}';\n"
)

p = Path('src/telephony/phone-noise-suppressor.js')
s = p.read_text()
old = "import { loadSpeexModule, SpeexPreprocessor } from '@sapphi-red/speex-preprocess-wasm';\n"
new = old + "import { SPEEX_WASM_BASE64 } from './speex-wasm-binary.js';\n"
if old not in s:
    raise SystemExit('missing Speex import anchor')
s = s.replace(old, new, 1)
old_loader = "async function speexModule() {\n  if (!modulePromise) modulePromise = loadSpeexModule();\n  return modulePromise;\n}\n"
new_loader = "async function speexModule() {\n  if (!modulePromise) {\n    const decoded = atob(SPEEX_WASM_BASE64);\n    const wasmBinary = new Uint8Array(decoded.length);\n    for (let i = 0; i < decoded.length; i += 1) wasmBinary[i] = decoded.charCodeAt(i);\n    modulePromise = loadSpeexModule({ wasmBinary });\n  }\n  return modulePromise;\n}\n"
if old_loader not in s:
    raise SystemExit('missing Speex loader anchor')
s = s.replace(old_loader, new_loader, 1)
p.write_text(s)
print(f'embedded {wasm} ({len(data)} bytes)')
