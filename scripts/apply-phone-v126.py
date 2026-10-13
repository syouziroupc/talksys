from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# Runtime selector: Node tests keep the known byte-loader; workerd uses a precompiled Wasm module.
pkg_path = ROOT / 'package.json'
pkg = json.loads(pkg_path.read_text())
pkg['imports'] = {
    '#speex-runtime-loader': {
        'workerd': './src/telephony/speex-worker-loader.js',
        'default': './src/telephony/speex-node-loader.js',
    }
}
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

(ROOT / 'src/telephony/speex-node-loader.js').write_text("""import { loadSpeexModule } from '@sapphi-red/speex-preprocess-wasm';
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
""")

(ROOT / 'src/telephony/speex-worker-loader.js').write_text("""import loadSpeexWorkerModule from './vendor/speex-worker.js';
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
""")

(ROOT / 'src/telephony/phone-noise-suppressor.js').write_text("""import { SpeexPreprocessor } from '@sapphi-red/speex-preprocess-wasm';
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
""")

# Patch the canonical telephony adapter, preserving STT/TTS/answer/PCMU boundaries.
index_path = ROOT / 'src/telephony/index.js'
s = index_path.read_text()
for old, new, label in [
    ("import { createPhoneNoiseSuppressor, PHONE_NOISE_SUPPRESSION_REVISION } from './phone-noise-suppressor.js';",
     "import { createPhoneNoiseSuppressor, phoneNoiseSuppressionSelfTest, PHONE_NOISE_SUPPRESSION_REVISION } from './phone-noise-suppressor.js';", 'noise import'),
    ("export const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v120-r1';",
     "export const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v126-restored-r1';", 'ack revision'),
    ("export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v125-r1';",
     "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v126-r1';", 'runtime revision'),
    ("export const PHONE_RELEASE_VERSION = 'v125';", "export const PHONE_RELEASE_VERSION = 'v126';", 'release'),
    ("export const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-v125-r1';",
     "export const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-v126-r1';", 'noise vad revision'),
    ("function health(request, env, deps) {\n  return json({",
     "async function health(request, env, deps) {\n  const noiseSuppressionRuntime = flag(env?.TELEPHONY_NOISE_SUPPRESSION_ENABLED, true)\n    ? await phoneNoiseSuppressionSelfTest()\n    : { ok: false, disabled: true, revision: PHONE_NOISE_SUPPRESSION_REVISION };\n  return json({", 'health self-test'),
    ("adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, noiseSuppressionRevision: PHONE_NOISE_SUPPRESSION_REVISION, noiseVadRevision: PHONE_NOISE_VAD_REVISION,",
     "adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, noiseSuppressionRevision: PHONE_NOISE_SUPPRESSION_REVISION, noiseSuppressionRuntime, noiseVadRevision: PHONE_NOISE_VAD_REVISION,", 'health field'),
    ("fastReaction: `Whisper確定直後の分類別PCMU受理相槌 + lookup検索進捗 + Gemini本回答 / ${PHONE_FAST_ACK_REVISION} / ${PHONE_SEARCH_PROGRESS_REVISION} / ${FAST_REACTION_REVISION}`",
     "fastReaction: `発話終了後のキャッシュ済みPCMU受理相槌（slow-STT時はWhisperと並列） + lookup検索進捗 + Gemini本回答 / ${PHONE_FAST_ACK_REVISION} / ${PHONE_SEARCH_PROGRESS_REVISION} / ${FAST_REACTION_REVISION}`", 'health ack description'),
]:
    s = replace_once(s, old, new, label)

old_ack = """    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;
    const sttPromise=transcribeSamples(env,samples);
    const slowAckTimer=setTimeout(()=>{
      if(sttSettled||closed||latestAcceptedCapture===0)return;
      const selected=selectPreparedSlowSttAck(phoneAckAudioCache.keys(),recentAckTexts);
      const prepared=selected?(selected===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(selected)):null;
      if(!selected||!prepared?.bytes?.byteLength){queueLatency(turnId,'ack_slow_stt_unprepared',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS});return;}
      slowAckArmed=true;slowAckText=selected;slowAckAudio=prepared;
      queueLatency(turnId,'ack_slow_stt_armed',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS,text:selected,bytes:prepared.bytes.byteLength});
    },PHONE_ACK_STT_GRACE_MS);"""
new_ack = """    let sttSettled=false,slowAckStarted=false,slowAckText='',slowAckAudio=null,slowAckPromise=Promise.resolve(false);
    const sttPromise=transcribeSamples(env,samples);
    const slowAckTimer=setTimeout(()=>{
      if(sttSettled||closed)return;
      const selected=selectPreparedSlowSttAck(phoneAckAudioCache.keys(),recentAckTexts);
      const prepared=selected?(selected===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(selected)):null;
      if(!selected||!prepared?.bytes?.byteLength){queueLatency(turnId,'ack_slow_stt_unprepared',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS});return;}
      slowAckStarted=true;slowAckText=selected;slowAckAudio=prepared;
      queueLatency(turnId,'ack_slow_stt_fallback',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS,text:selected,bytes:prepared.bytes.byteLength});
      slowAckPromise=speak(selected,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:prepared}).then((reacted)=>{if(reacted){recentAckTexts=[...recentAckTexts,selected].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'slow-stt-receipt',text:selected,cached:true,revision:PHONE_ACK_LATENCY_REVISION}));}return reacted;});
      trackTask(slowAckPromise.catch((error)=>{console.warn(JSON.stringify({type:'phone_slow_stt_ack_error',turnId,error:clean(error?.message||error,240)}));return false;}));
    },PHONE_ACK_STT_GRACE_MS);"""
s = replace_once(s, old_ack, new_ack, 'v119 ack timer restore')
s = replace_once(s,
    "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();interruptPlayback();",
    "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();if(!slowAckStarted)interruptPlayback();",
    'ack playback preservation')
s = replace_once(s, "const ackText=slowAckArmed?slowAckText:categoryAckText;", "const ackText=slowAckStarted?slowAckText:categoryAckText;", 'ack text selector')
s = replace_once(s, "const ackAudio=slowAckArmed?slowAckAudio:categoryAckAudio;", "const ackAudio=slowAckStarted?slowAckAudio:categoryAckAudio;", 'ack audio selector')
s = replace_once(s,
    "if(slowAckArmed&&ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_slow_stt_committed',Date.now()-speechEndAt,{text:ackText,revision:PHONE_ACK_LATENCY_REVISION,reactionKind:reaction.kind||'none'});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'slow-stt-receipt',text:ackText,cached:true,revision:PHONE_ACK_LATENCY_REVISION}));}}",
    "if(slowAckStarted){queueLatency(turnId,'ack_already_started',Date.now()-speechEndAt,{text:ackText,revision:PHONE_ACK_LATENCY_REVISION,reactionKind:reaction.kind||'none'});}",
    'remove post-STT ack replay')

s = replace_once(s,
    "let phoneNoiseSuppressor=null, noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0, noiseSummaryLogged=false;",
    "let phoneNoiseSuppressor=null, noiseInitError='', noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0, noiseSummaryLogged=false;",
    'noise init telemetry state')
s = replace_once(s,
    "if(noiseSuppressionEnabled){trackTask(createPhoneNoiseSuppressor({frameSize:160,sampleRate:8000,noiseSuppressDb:-12,probStart:42,probContinue:20}).then((processor)=>{phoneNoiseSuppressor=processor;console.log(JSON.stringify({type:'phone_noise_suppression_ready',revision:PHONE_NOISE_SUPPRESSION_REVISION}));}).catch((error)=>{phoneNoiseSuppressor=null;console.warn(JSON.stringify({type:'phone_noise_suppression_fallback',revision:PHONE_NOISE_SUPPRESSION_REVISION,error:clean(error?.message||error,240)}));}));}",
    "if(noiseSuppressionEnabled){trackTask(createPhoneNoiseSuppressor({frameSize:160,sampleRate:8000,noiseSuppressDb:-12,probStart:42,probContinue:20}).then((processor)=>{phoneNoiseSuppressor=processor;noiseInitError='';console.log(JSON.stringify({type:'phone_noise_suppression_ready',revision:PHONE_NOISE_SUPPRESSION_REVISION,runtimeKind:processor?.runtimeKind||''}));}).catch((error)=>{phoneNoiseSuppressor=null;noiseInitError=clean(error?.message||error,240);console.warn(JSON.stringify({type:'phone_noise_suppression_fallback',revision:PHONE_NOISE_SUPPRESSION_REVISION,error:noiseInitError}));}));}",
    'noise init telemetry')
s = replace_once(s, "fallbackFrames:noiseFallbackFrames};", "fallbackFrames:noiseFallbackFrames,runtimeKind:phoneNoiseSuppressor?.runtimeKind||'',initError:noiseInitError};", 'noise summary telemetry')
index_path.write_text(s)

# Replace obsolete regression contracts that intentionally preserved the v120 latency regression.
for test_path in (ROOT / 'tests').glob('*.mjs'):
    text = test_path.read_text()
    text = text.replace("'talksys-phone-speex-v124-r1'", "'talksys-phone-speex-v126-worker-r1'")
    text = text.replace("'talksys-phone-noise-v125-r1'", "'talksys-phone-noise-v126-r1'")
    text = text.replace("'talksys-phone-runtime-log-v125-r1'", "'talksys-phone-runtime-log-v126-r1'")
    text = text.replace("PHONE_RELEASE_VERSION, 'v125'", "PHONE_RELEASE_VERSION, 'v126'")
    text = text.replace("'talksys-phone-ack-latency-v120-r1'", "'talksys-phone-ack-latency-v126-restored-r1'")
    test_path.write_text(text)

p = ROOT / 'tests/phone-quality-personalization-v120.test.mjs'
t = p.read_text()
t = t.replace("test('v120 removes wait-language from receipt ack and never preplays an unvalidated slow-STT capture', () => {", "test('v126 restores the proven v119 slow-STT acknowledgement while keeping wait-language removed', () => {")
t = replace_once(t, "  assert.match(telephony, /if\\(sttSettled\\|\\|closed\\|\\|latestAcceptedCapture===0\\)return/);", "  assert.match(telephony, /if\\(sttSettled\\|\\|closed\\)return/);", 'quality ack guard')
t = replace_once(t,
    "  assert.doesNotMatch(telephony.slice(timerStart, timerEnd), /\\bspeak\\s*\\(/);\n  assert.match(telephony, /ack_slow_stt_armed/);\n  assert.match(telephony, /ack_slow_stt_committed/);",
    "  assert.match(telephony.slice(timerStart, timerEnd), /\\bspeak\\s*\\(/);\n  assert.match(telephony, /ack_slow_stt_fallback/);\n  assert.match(telephony, /ack_already_started/);",
    'quality ack contract')
p.write_text(t)

p = ROOT / 'tests/phone-second-turn-ack-zip-v119.test.mjs'
t = p.read_text()
t = t.replace("test('v120 arms slow-STT acknowledgement but commits playout only after accepted STT', () => {", "test('v126 restores v119 pre-STT acknowledgement playout after the bounded grace', () => {")
t = replace_once(t,
    "  assert.match(source, /ack_slow_stt_armed/);\n  assert.match(source, /ack_slow_stt_committed/);\n  assert.match(source, /if\\(sttSettled\\|\\|closed\\|\\|latestAcceptedCapture===0\\)return/);",
    "  assert.match(source, /ack_slow_stt_fallback/);\n  assert.match(source, /ack_already_started/);\n  assert.match(source, /if\\(sttSettled\\|\\|closed\\)return/);",
    'v119 test ack markers')
t = replace_once(t,
    "  assert.doesNotMatch(timerBlock, /\\bspeak\\s*\\(/, 'slow-STT timer must never play audio before STT acceptance');\n  const rejectGate = source.indexOf(\"if(!stt?.ok||!stt.text||myCapture<latestAcceptedCapture)\");\n  const commit = source.indexOf(\"ack_slow_stt_committed\");\n  assert.ok(rejectGate >= 0 && commit > rejectGate, 'slow acknowledgement commit must be downstream of STT rejection gate');",
    "  assert.match(timerBlock, /\\bspeak\\s*\\(/, 'slow-STT acknowledgement must start while STT is still pending');\n  assert.match(source, /if\\(!slowAckStarted\\)interruptPlayback\\(\\)/);",
    'v119 test playback contract')
p.write_text(t)

(ROOT / 'tests/phone-v126-worker-runtime.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { phoneNoiseSuppressionSelfTest, PHONE_NOISE_SUPPRESSION_REVISION } from '../src/telephony/phone-noise-suppressor.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workerLoader = fs.readFileSync(new URL('../src/telephony/speex-worker-loader.js', import.meta.url), 'utf8');
const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('v126 keeps Node tests on byte-loader but production workerd on precompiled Wasm', async () => {
  assert.equal(pkg.imports['#speex-runtime-loader'].workerd, './src/telephony/speex-worker-loader.js');
  assert.equal(pkg.imports['#speex-runtime-loader'].default, './src/telephony/speex-node-loader.js');
  assert.match(workerLoader, /speex-worker\\.wasm/);
  assert.match(workerLoader, /new WebAssembly\\.Instance\\(speexWasmModule, imports\\)/);
  assert.match(workerLoader, /receiveInstance\\(instance, speexWasmModule\\)/);
  assert.doesNotMatch(workerLoader, /wasmBinary/);
  const result = await phoneNoiseSuppressionSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.runtimeKind, 'node-wasm-binary');
  assert.equal(PHONE_NOISE_SUPPRESSION_REVISION, 'talksys-phone-speex-v126-worker-r1');
});

test('v126 health makes Worker Speex readiness a deploy-visible contract', () => {
  assert.match(telephony, /await phoneNoiseSuppressionSelfTest\\(\\)/);
  assert.match(telephony, /noiseSuppressionRuntime/);
  assert.match(telephony, /runtimeKind:phoneNoiseSuppressor\\?\\.runtimeKind/);
  assert.match(telephony, /initError:noiseInitError/);
});
""")

print('Applied guarded v126 phone repair')
