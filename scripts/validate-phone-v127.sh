#!/usr/bin/env bash
set -euo pipefail

BASE=52deefd95faedd444822e56ff5238defd4645b1e

node --check src/telephony/index.js
node --check src/telephony/phone-noise-suppressor.js
node --check src/telephony/speex-node-loader.js
node --check src/telephony/speex-worker-loader.js
node --check src/stt-v45.js

node --test \
  tests/phone-input-adaptation-v127.test.mjs \
  tests/phone-v127-worker-runtime.test.mjs \
  tests/phone-noise-suppression-v124.test.mjs \
  tests/phone-noise-vad-v125.test.mjs \
  tests/phone-second-turn-ack-zip-v119.test.mjs \
  tests/phone-quality-personalization-v120.test.mjs

# Prove the production-style compiled-Wasm path inside real local workerd.
npx wrangler dev \
  --config tests/wrangler-phone-v127-smoke.jsonc \
  --local --ip 127.0.0.1 --port 8799 > /tmp/v127-workerd.log 2>&1 &
pid=$!
cleanup(){ kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
trap cleanup EXIT
ready=0
for attempt in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8799/ -o /tmp/v127-speex-workerd.json; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  cat /tmp/v127-workerd.log
  exit 1
fi
cat /tmp/v127-speex-workerd.json
node - <<'NODE'
const fs=require('fs');
const h=JSON.parse(fs.readFileSync('/tmp/v127-speex-workerd.json','utf8'));
if(!h?.ok) throw new Error(`Speex self-test failed: ${JSON.stringify(h)}`);
if(h.runtimeKind!=='workerd-compiled-wasm') throw new Error(`wrong runtime: ${JSON.stringify(h)}`);
if(Number(h.processedFrames||0)<24) throw new Error(`Speex processed too few frames: ${JSON.stringify(h)}`);
NODE
cleanup
trap - EXIT

mapfile -t suites < <(find tests -maxdepth 1 -type f \( -iname 'phone-*test.mjs' -o -iname 'telephony-*test.mjs' \) | sort)
node --test "${suites[@]}"
npm run architecture:check
npm run architecture:graph
npm run reuse:check
npm test

rm -rf /tmp/v127-dist
npx wrangler deploy --dry-run --outdir /tmp/v127-dist 2>&1 | tee /tmp/v127-dry-run.log
if grep -Eqi '(unsupported wasm|unresolved import)' /tmp/v127-dry-run.log; then
  cat /tmp/v127-dry-run.log
  exit 1
fi
find /tmp/v127-dist -maxdepth 2 -type f -printf '%p %s bytes\n' | sort

# Freeze every known-good conversation/output boundary from production v125.
test -z "$(git diff --name-only "$BASE" -- src/telephony/phone-tts.js wrangler.jsonc src/integrated-entry.js src/voice-fast-reaction.js src/voice-capture-policy.js)"
grep -q "PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v120-r1'" src/telephony/index.js
grep -q "slowAckArmed" src/telephony/index.js
if grep -q "talksys-phone-ack-latency-v126-restored-r1" src/telephony/index.js; then exit 1; fi
if grep -q "slowAckStarted" src/telephony/index.js; then exit 1; fi
grep -q "PHONE_RELEASE_VERSION = 'v127'" src/telephony/index.js
grep -q "phoneInputMode==='noisy'" src/telephony/index.js
grep -q "PHONE_INPUT_CALIBRATION_FRAMES = 150" src/telephony/index.js
grep -q "noiseSuppressDb: -12" src/telephony/phone-noise-suppressor.js
grep -q "pre.agc = false" src/telephony/phone-noise-suppressor.js
grep -q "workerd-compiled-wasm" src/telephony/speex-worker-loader.js
grep -q "maxGain = 1" src/stt-v45.js
grep -q "Math.pow(10, 6 / 20)" src/stt-v45.js
grep -q '"TELEPHONY_VAD_RMS": "0.0045"' wrangler.jsonc
grep -q '"TELEPHONY_TTS_OUTPUT_GAIN_DB": "3.0"' wrangler.jsonc

echo 'v127 adaptive input validation complete'
