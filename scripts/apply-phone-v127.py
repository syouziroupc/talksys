from pathlib import Path
import json

ROOT = Path('.')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)

# Package import conditions: Node tests keep byte-loader, workerd gets precompiled Wasm.
pkg_path = ROOT / 'package.json'
pkg = pkg_path.read_text()
pkg = replace_once(
    pkg,
    '  "type": "module",\n  "scripts": {',
    '  "type": "module",\n  "imports": {\n    "#speex-runtime-loader": {\n      "workerd": "./src/telephony/speex-worker-loader.js",\n      "default": "./src/telephony/speex-node-loader.js"\n    }\n  },\n  "scripts": {',
    'package imports',
)
pkg_path.write_text(pkg)

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

export const PHONE_NOISE_SUPPRESSION_REVISION = 'talksys-phone-speex-v127-adaptive-r1';

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

# Make existing STT normalization noise-aware. Clean/pending mode preserves v125 exactly.
stt_path = ROOT / 'src/stt-v45.js'
stt = stt_path.read_text()
old_norm = """export function normalizeQuietPhoneWav(buffer, metrics = {}) {
  if (!metrics?.valid) return { buffer, gain: 1, gainDb: 0 };
  const rms = Number(metrics.rms) || 0;
  const peak = Number(metrics.peak) || 0;
  if (rms <= 0 || peak <= 0) return { buffer, gain: 1, gainDb: 0 };

  const targetRms = 0.018;
  const maxGain = 2.5;
  const maxPeak = 0.90;
  const gain = Math.max(1, Math.min(maxGain, targetRms / Math.max(rms, 0.0008), maxPeak / Math.max(peak, 0.001)));
  if (gain < 1.05) return { buffer, gain: 1, gainDb: 0 };

  const copy = buffer.slice(0);
  const parsed = pcm16WavData(copy);
  if (!parsed) return { buffer, gain: 1, gainDb: 0 };
  const { view, dataOffset, dataSize } = parsed;
  const sampleCount = Math.floor(dataSize / 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const offset = dataOffset + i * 2;
    const sample = view.getInt16(offset, true);
    const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
    view.setInt16(offset, boosted, true);
  }
  return { buffer: copy, gain, gainDb: Number((20 * Math.log10(gain)).toFixed(2)) };
}
"""
new_norm = """export function normalizeQuietPhoneWav(buffer, metrics = {}, options = {}) {
  if (!metrics?.valid) return { buffer, gain: 1, gainDb: 0, snrDb: null };
  const rms = Number(metrics.rms) || 0;
  const peak = Number(metrics.peak) || 0;
  if (rms <= 0 || peak <= 0) return { buffer, gain: 1, gainDb: 0, snrDb: null };

  const targetRms = 0.018;
  const legacyMaxGain = 2.5;
  const maxPeak = 0.90;
  const inputMode = String(options?.inputMode || '').toLowerCase();
  const noiseFloor = Math.max(0, Number(options?.noiseFloor) || 0);
  let maxGain = legacyMaxGain;
  let snrDb = null;
  if (inputMode === 'noisy' && noiseFloor > 0) {
    snrDb = 20 * Math.log10(Math.max(rms, 0.0001) / Math.max(noiseFloor, 0.0001));
    // Noise-dominated captures must never have their background amplified.
    if (snrDb < 10) maxGain = 1;
    else if (snrDb < 16) maxGain = Math.pow(10, 3 / 20);
    else maxGain = Math.pow(10, 6 / 20);
  }
  const gain = Math.max(1, Math.min(maxGain, targetRms / Math.max(rms, 0.0008), maxPeak / Math.max(peak, 0.001)));
  if (gain < 1.05) return { buffer, gain: 1, gainDb: 0, snrDb: Number.isFinite(snrDb) ? Number(snrDb.toFixed(2)) : null };

  const copy = buffer.slice(0);
  const parsed = pcm16WavData(copy);
  if (!parsed) return { buffer, gain: 1, gainDb: 0, snrDb: Number.isFinite(snrDb) ? Number(snrDb.toFixed(2)) : null };
  const { view, dataOffset, dataSize } = parsed;
  const sampleCount = Math.floor(dataSize / 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const offset = dataOffset + i * 2;
    const sample = view.getInt16(offset, true);
    const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
    view.setInt16(offset, boosted, true);
  }
  return { buffer: copy, gain, gainDb: Number((20 * Math.log10(gain)).toFixed(2)), snrDb: Number.isFinite(snrDb) ? Number(snrDb.toFixed(2)) : null };
}
"""
stt = replace_once(stt, old_norm, new_norm, 'STT normalization')
stt = replace_once(
    stt,
    """  const source = clean(request.headers.get('x-talksys-source') || '', 80).toLowerCase();
  const metrics = analyzeWav(buffer);
  const phoneNormalized = source === 'telnyx' ? normalizeQuietPhoneWav(buffer, metrics) : { buffer, gain: 1, gainDb: 0 };
  const signal = {
    durationMs: Math.round(metrics.durationMs || 0),
    rms: Number((metrics.rms || 0).toFixed(5)),
    peak: Number((metrics.peak || 0).toFixed(5)),
    activeMs: Math.round(metrics.activeMs || 0),
    activeRatio: Number((metrics.activeRatio || 0).toFixed(3)),
    inputGainDb: phoneNormalized.gainDb,
  };
""",
    """  const source = clean(request.headers.get('x-talksys-source') || '', 80).toLowerCase();
  const inputMode = clean(request.headers.get('x-talksys-phone-input-mode') || '', 20).toLowerCase();
  const inputNoiseFloorRaw = Number(request.headers.get('x-talksys-phone-noise-floor') || 0);
  const inputNoiseFloor = Number.isFinite(inputNoiseFloorRaw) ? Math.max(0, inputNoiseFloorRaw) : 0;
  const metrics = analyzeWav(buffer);
  const phoneNormalized = source === 'telnyx'
    ? normalizeQuietPhoneWav(buffer, metrics, { inputMode, noiseFloor: inputNoiseFloor })
    : { buffer, gain: 1, gainDb: 0, snrDb: null };
  const signal = {
    durationMs: Math.round(metrics.durationMs || 0),
    rms: Number((metrics.rms || 0).toFixed(5)),
    peak: Number((metrics.peak || 0).toFixed(5)),
    activeMs: Math.round(metrics.activeMs || 0),
    activeRatio: Number((metrics.activeRatio || 0).toFixed(3)),
    inputGainDb: phoneNormalized.gainDb,
    inputMode: inputMode || 'legacy',
    inputNoiseFloor: Number(inputNoiseFloor.toFixed(5)),
    inputSnrDb: phoneNormalized.snrDb,
  };
""",
    'STT input metadata',
)
stt_path.write_text(stt)

# Telephony: preserve the v125 conversation core; add only input calibration, selective NS, and STT metadata.
idx_path = ROOT / 'src/telephony/index.js'
idx = idx_path.read_text()
idx = replace_once(
    idx,
    "import { createPhoneNoiseSuppressor, PHONE_NOISE_SUPPRESSION_REVISION } from './phone-noise-suppressor.js';",
    "import { createPhoneNoiseSuppressor, phoneNoiseSuppressionSelfTest, PHONE_NOISE_SUPPRESSION_REVISION } from './phone-noise-suppressor.js';",
    'telephony Speex import',
)
idx = replace_once(idx, "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v125-r1';\nexport const PHONE_RELEASE_VERSION = 'v125';", "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v127-r1';\nexport const PHONE_RELEASE_VERSION = 'v127';", 'release revision')
idx = replace_once(idx, "export const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-vad-v125-r1';", "export const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-vad-v127-adaptive-r1';", 'noise VAD revision')
idx = replace_once(
    idx,
    "export const PHONE_VAD_CLEAN_PROB_FLOOR = 30;\nconst PHONE_ACK_STT_GRACE_MS = 250;",
    "export const PHONE_VAD_CLEAN_PROB_FLOOR = 30;\nexport const PHONE_INPUT_CALIBRATION_REVISION = 'talksys-phone-input-calibration-v127-r1';\nexport const PHONE_INPUT_CALIBRATION_FRAMES = 150;\nexport const PHONE_INPUT_NOISY_FLOOR = 0.0035;\nconst PHONE_ACK_STT_GRACE_MS = 250;",
    'calibration constants',
)
helper = """
export function phoneInputCalibrationEstimate(rmsValues = [], requiredFrames = PHONE_INPUT_CALIBRATION_FRAMES) {
  const needed = Math.max(20, Number(requiredFrames) || PHONE_INPUT_CALIBRATION_FRAMES);
  const values = Array.from(rmsValues || [])
    .map(Number)
    .filter(Number.isFinite)
    .map((value) => Math.max(0.0002, Math.min(0.03, value)));
  if (values.length < needed) return { ready: false, mode: 'pending', floor: 0, frames: values.length, p30: 0, p50: 0 };
  const sorted = values.slice(0, needed).sort((a, b) => a - b);
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
  const p30 = quantile(0.30), p50 = quantile(0.50);
  const floor = Math.max(0.0006, Math.min(0.008, p30 * 1.05));
  const noisy = floor >= PHONE_INPUT_NOISY_FLOOR && p50 >= PHONE_INPUT_NOISY_FLOOR;
  return { ready: true, mode: noisy ? 'noisy' : 'clean', floor, frames: needed, p30, p50 };
}
"""
idx = replace_once(idx, "const PHONE_ACK_VARIANTS = Object.freeze({", helper + "\nconst PHONE_ACK_VARIANTS = Object.freeze({", 'calibration helper insertion')
idx = replace_once(idx, "    noiseVadRevision: PHONE_NOISE_VAD_REVISION,\n", "    noiseVadRevision: PHONE_NOISE_VAD_REVISION,\n    inputCalibrationRevision: PHONE_INPUT_CALIBRATION_REVISION,\n", 'runtime calibration revision')

old_transcribe = """async function transcribeSamples(env, samples) {
  const wav = samplesToWav(samples, 8000);
  const request = new Request('https://talksys.internal/api/transcribe', {
    method: 'POST', headers: { 'content-type': 'audio/wav', 'x-talksys-source': 'telnyx' }, body: wav,
  });
  const response = await transcribeV45(request, env);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true || !payload?.text) return { ok: false, error: payload?.error || `stt_${response.status}`, payload };
  return { ok: true, text: clean(payload.text, 1800), payload };
}
"""
new_transcribe = """async function transcribeSamples(env, samples, inputMeta = {}) {
  const wav = samplesToWav(samples, 8000);
  const headers = { 'content-type': 'audio/wav', 'x-talksys-source': 'telnyx' };
  const inputMode = clean(inputMeta?.inputMode || '', 20).toLowerCase();
  const noiseFloor = Number(inputMeta?.noiseFloor || 0);
  if (inputMode) headers['x-talksys-phone-input-mode'] = inputMode;
  if (Number.isFinite(noiseFloor) && noiseFloor > 0) headers['x-talksys-phone-noise-floor'] = String(noiseFloor);
  const request = new Request('https://talksys.internal/api/transcribe', {
    method: 'POST', headers, body: wav,
  });
  const response = await transcribeV45(request, env);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true || !payload?.text) return { ok: false, error: payload?.error || `stt_${response.status}`, payload };
  return { ok: true, text: clean(payload.text, 1800), payload };
}
"""
idx = replace_once(idx, old_transcribe, new_transcribe, 'telephony STT metadata')

idx = replace_once(idx, 'function health(request, env, deps) {\n  return json({', "async function health(request, env, deps) {\n  const noiseSuppressionRuntime = await phoneNoiseSuppressionSelfTest().catch((error) => ({ ok: false, runtimeKind: '', error: clean(error?.message || error, 240) }));\n  return json({", 'async health self-test')
idx = replace_once(idx, "    inputAudio: 'Telnyx PCMU 8kHz → 90Hz HPF → SpeexDSP NS/VAD → hangover判定 → TalkSys STT',", "    inputAudio: 'Telnyx PCMU 8kHz → 90Hz HPF → 3秒入力校正 → noisy時のみSpeexDSP NS/VAD → hangover判定 → TalkSys STT',", 'health input description')
idx = replace_once(
    idx,
    "    adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, noiseSuppressionRevision: PHONE_NOISE_SUPPRESSION_REVISION, noiseVadRevision: PHONE_NOISE_VAD_REVISION, phoneVadBaseRms: Number(env?.TELEPHONY_VAD_RMS || 0.0045),",
    "    adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, noiseSuppressionRevision: PHONE_NOISE_SUPPRESSION_REVISION, noiseVadRevision: PHONE_NOISE_VAD_REVISION, inputCalibrationRevision: PHONE_INPUT_CALIBRATION_REVISION, inputCalibrationFrames: PHONE_INPUT_CALIBRATION_FRAMES, inputNoisyFloor: PHONE_INPUT_NOISY_FLOOR, noiseSuppressionRuntime, phoneVadBaseRms: Number(env?.TELEPHONY_VAD_RMS || 0.0045),",
    'health calibration contract',
)

idx = replace_once(
    idx,
    "  let phoneNoiseSuppressor=null, noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0, noiseSummaryLogged=false;\n  let activeDenoisedSpeechAgeMs=Number.POSITIVE_INFINITY, captureVoiceFrames=0, captureRawRescueFrames=0, captureHighRmsNonspeechFrames=0;",
    "  let phoneNoiseSuppressor=null, noiseInitError='', noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseAppliedFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0, noiseSummaryLogged=false;\n  let phoneCalibrationRms=[], phoneInputMode='pending', phoneInputFloor=0, phoneCalibrationLogged=false;\n  let activeDenoisedSpeechAgeMs=Number.POSITIVE_INFINITY, captureVoiceFrames=0, captureRawRescueFrames=0, captureHighRmsNonspeechFrames=0;",
    'media state',
)
idx = replace_once(
    idx,
    "  if(noiseSuppressionEnabled){trackTask(createPhoneNoiseSuppressor({frameSize:160,sampleRate:8000,noiseSuppressDb:-12,probStart:42,probContinue:20}).then((processor)=>{phoneNoiseSuppressor=processor;console.log(JSON.stringify({type:'phone_noise_suppression_ready',revision:PHONE_NOISE_SUPPRESSION_REVISION}));}).catch((error)=>{phoneNoiseSuppressor=null;console.warn(JSON.stringify({type:'phone_noise_suppression_fallback',revision:PHONE_NOISE_SUPPRESSION_REVISION,error:clean(error?.message||error,240)}));}));}",
    "  if(noiseSuppressionEnabled){trackTask(createPhoneNoiseSuppressor({frameSize:160,sampleRate:8000,noiseSuppressDb:-12,probStart:42,probContinue:20}).then((processor)=>{phoneNoiseSuppressor=processor;noiseInitError='';console.log(JSON.stringify({type:'phone_noise_suppression_ready',revision:PHONE_NOISE_SUPPRESSION_REVISION,runtimeKind:processor?.runtimeKind||''}));}).catch((error)=>{phoneNoiseSuppressor=null;noiseInitError=clean(error?.message||error,240);console.warn(JSON.stringify({type:'phone_noise_suppression_fallback',revision:PHONE_NOISE_SUPPRESSION_REVISION,error:noiseInitError}));}));}",
    'Speex init telemetry',
)
idx = replace_once(
    idx,
    "  const emitNoiseSummary=(reason='unknown')=>{if(noiseSummaryLogged)return;noiseSummaryLogged=true;const detail={revision:PHONE_NOISE_SUPPRESSION_REVISION,noiseVadRevision:PHONE_NOISE_VAD_REVISION,reason,enabled:noiseSuppressionEnabled,ready:Boolean(phoneNoiseSuppressor),frames:noiseFrames,avgCpuMs:noiseFrames?Number((noiseCpuMs/noiseFrames).toFixed(4)):0,maxCpuMs:Number(noiseCpuMaxMs.toFixed(4)),fallbackFrames:noiseFallbackFrames};console.log(JSON.stringify({type:'phone_noise_suppression_summary',...detail}));if(callId)queueLatency(`${clean(callId||'call',120)}-noise`,'noise_suppression_summary',0,detail);};",
    "  const emitNoiseSummary=(reason='unknown')=>{if(noiseSummaryLogged)return;noiseSummaryLogged=true;const detail={revision:PHONE_NOISE_SUPPRESSION_REVISION,noiseVadRevision:PHONE_NOISE_VAD_REVISION,inputCalibrationRevision:PHONE_INPUT_CALIBRATION_REVISION,inputMode:phoneInputMode,calibrationFloor:Number(phoneInputFloor.toFixed(6)),reason,enabled:noiseSuppressionEnabled,ready:Boolean(phoneNoiseSuppressor),frames:noiseFrames,appliedFrames:noiseAppliedFrames,avgCpuMs:noiseFrames?Number((noiseCpuMs/noiseFrames).toFixed(4)):0,maxCpuMs:Number(noiseCpuMaxMs.toFixed(4)),fallbackFrames:noiseFallbackFrames,runtimeKind:phoneNoiseSuppressor?.runtimeKind||'',initError:noiseInitError};console.log(JSON.stringify({type:'phone_noise_suppression_summary',...detail}));if(callId)queueLatency(`${clean(callId||'call',120)}-noise`,'noise_suppression_summary',0,detail);};",
    'noise summary',
)

idx = replace_once(
    idx,
    "    const captureNoiseStats={voiceFrames:captureVoiceFrames,rawRescueFrames:captureRawRescueFrames,highRmsNonspeechFrames:captureHighRmsNonspeechFrames};",
    "    const captureNoiseStats={voiceFrames:captureVoiceFrames,rawRescueFrames:captureRawRescueFrames,highRmsNonspeechFrames:captureHighRmsNonspeechFrames,inputMode:phoneInputMode,calibrationFloor:Number(phoneInputFloor.toFixed(6)),calibrationRevision:PHONE_INPUT_CALIBRATION_REVISION};",
    'capture input stats',
)
idx = replace_once(
    idx,
    "    const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8)});\n    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;\n    const sttPromise=transcribeSamples(env,samples);",
    "    const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8),inputMode:phoneInputMode,calibrationFloor:Number(phoneInputFloor.toFixed(6))});\n    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;\n    const sttPromise=transcribeSamples(env,samples,{inputMode:phoneInputMode,noiseFloor:phoneInputFloor});",
    'STT call metadata while preserving v125 ack',
)

media_start = """    if(message?.event==='media'&&message?.media?.payload){
      const decoded=pcmuBase64ToSamples(message.media.payload),rawSamples=highPassPcmFrame(decoded,hpState,8000,90),rawRms=rmsOfSamples(rawSamples),threshold=startThreshold(),rawSnr=rawRms/Math.max(0.001,noiseFloor);
      let samples=rawSamples,rms=rawRms,speexSpeech=false,speechProbability=0,cleanSpeech=false,noiseProcessed=false;
      if(phoneNoiseSuppressor&&!assistantPlaying){
"""
media_new = """    if(message?.event==='media'&&message?.media?.payload){
      const decoded=pcmuBase64ToSamples(message.media.payload),rawSamples=highPassPcmFrame(decoded,hpState,8000,90),rawRms=rmsOfSamples(rawSamples),threshold=startThreshold(),rawSnr=rawRms/Math.max(0.001,noiseFloor);
      if(phoneInputMode==='pending'&&!assistantPlaying&&phoneCalibrationRms.length<PHONE_INPUT_CALIBRATION_FRAMES){
        phoneCalibrationRms.push(rawRms);
        const calibration=phoneInputCalibrationEstimate(phoneCalibrationRms);
        if(calibration.ready){
          phoneInputMode=calibration.mode;phoneInputFloor=calibration.floor;
          if(!phoneCalibrationLogged){phoneCalibrationLogged=true;const detail={revision:PHONE_INPUT_CALIBRATION_REVISION,frames:calibration.frames,mode:calibration.mode,floor:Number(calibration.floor.toFixed(6)),p30:Number(calibration.p30.toFixed(6)),p50:Number(calibration.p50.toFixed(6))};console.log(JSON.stringify({type:'phone_input_calibration',...detail}));if(callId)queueLatency(`${clean(callId||'call',120)}-calibration`,'input_calibration',0,detail);}
        }
      }
      let samples=rawSamples,rms=rawRms,speexSpeech=false,speechProbability=0,cleanSpeech=false,noiseProcessed=false;
      if(phoneNoiseSuppressor&&!assistantPlaying&&phoneInputMode==='noisy'){
"""
idx = replace_once(idx, media_start, media_new, 'media calibration gate')
idx = replace_once(
    idx,
    "        if(processed.ok&&processed.samples?.length===rawSamples.length){samples=processed.samples;rms=rmsOfSamples(samples);speexSpeech=Boolean(processed.speech);speechProbability=Math.max(0,Math.min(100,Number(processed.probability)||0));noiseProcessed=true;",
    "        if(processed.ok&&processed.samples?.length===rawSamples.length){samples=processed.samples;rms=rmsOfSamples(samples);speexSpeech=Boolean(processed.speech);speechProbability=Math.max(0,Math.min(100,Number(processed.probability)||0));noiseProcessed=true;noiseAppliedFrames+=1;",
    'Speex applied frame count',
)
idx_path.write_text(idx)

print('Applied guarded phone v127 adaptive input patch')
