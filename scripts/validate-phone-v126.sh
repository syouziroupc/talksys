#!/usr/bin/env bash
set -euo pipefail

node --check src/telephony/index.js
node --check src/telephony/phone-noise-suppressor.js
node --check src/telephony/speex-node-loader.js
node --check src/telephony/speex-worker-loader.js
node --test \
  tests/phone-noise-suppression-v124.test.mjs \
  tests/phone-noise-vad-v125.test.mjs \
  tests/phone-second-turn-ack-zip-v119.test.mjs \
  tests/phone-quality-personalization-v120.test.mjs \
  tests/phone-v126-worker-runtime.test.mjs

# The previous regression existed because Node tests passed while the production
# Worker could not instantiate Speex. This is a mandatory workerd runtime proof.
npx wrangler dev --ip 127.0.0.1 --port 8799 > /tmp/v126-workerd.log 2>&1 &
pid=$!
cleanup(){ kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
trap cleanup EXIT
ready=0
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8799/telephony-health -o /tmp/v126-health.json; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  cat /tmp/v126-workerd.log
  exit 1
fi
cat /tmp/v126-health.json
node - <<'NODE'
const fs=require('fs');
const h=JSON.parse(fs.readFileSync('/tmp/v126-health.json','utf8'));
if(h.releaseVersion!=='v126') throw new Error(`unexpected release: ${h.releaseVersion}`);
if(!h.noiseSuppressionRuntime?.ok) throw new Error(`Speex self-test failed: ${JSON.stringify(h.noiseSuppressionRuntime)}`);
if(h.noiseSuppressionRuntime.runtimeKind!=='workerd-compiled-wasm') throw new Error(`wrong runtime: ${JSON.stringify(h.noiseSuppressionRuntime)}`);
if(Number(h.noiseSuppressionRuntime.processedFrames||0)<1) throw new Error('Speex processed zero frames');
NODE
cleanup
trap - EXIT

mapfile -t suites < <(find tests -maxdepth 1 -type f \( -iname 'phone-*test.mjs' -o -iname 'telephony-*test.mjs' \) | sort)
node --test "${suites[@]}"
npm run architecture:check
npm run architecture:graph
npm run reuse:check
npm test

rm -rf /tmp/v126-dist
npx wrangler deploy --dry-run --outdir /tmp/v126-dist 2>&1 | tee /tmp/v126-dry-run.log
if grep -Eqi '(unsupported wasm|unresolved import)' /tmp/v126-dry-run.log; then
  cat /tmp/v126-dry-run.log
  exit 1
fi
find /tmp/v126-dist -maxdepth 2 -type f -printf '%p %s bytes\n' | sort

# Frozen quality boundaries: v126 repairs only acknowledgement scheduling and
# the Worker Speex loader; it does not reopen STT/TTS/answer/PCMU tuning.
test -z "$(git diff --name-only 52deefd95faedd444822e56ff5238defd4645b1e -- src/telephony/phone-tts.js wrangler.jsonc src/stt-v45.js src/integrated-entry.js)"
grep -q "noiseSuppressDb: -12" src/telephony/phone-noise-suppressor.js
grep -q "pre.agc = false" src/telephony/phone-noise-suppressor.js
grep -q '"TELEPHONY_VAD_RMS": "0.0045"' wrangler.jsonc
grep -q '"TELEPHONY_TTS_OUTPUT_GAIN_DB": "3.0"' wrangler.jsonc
grep -q "slowAckPromise=speak" src/telephony/index.js
grep -q "if(!slowAckStarted)interruptPlayback()" src/telephony/index.js
grep -q "workerd-compiled-wasm" src/telephony/speex-worker-loader.js
grep -q "noiseSuppressionRuntime" src/telephony/index.js
git diff --check

echo 'v126 validation complete'
