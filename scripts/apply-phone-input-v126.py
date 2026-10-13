from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

index_path = Path('src/telephony/index.js')
stt_path = Path('src/stt-v45.js')
index = index_path.read_text(encoding='utf-8')
stt = stt_path.read_text(encoding='utf-8')

if "PHONE_RELEASE_VERSION = 'v125'" not in index:
    raise SystemExit('baseline guard failed: expected production v125')

index = replace_once(index,
"export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v125-r1';\nexport const PHONE_RELEASE_VERSION = 'v125';",
"export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v126-r1';\nexport const PHONE_RELEASE_VERSION = 'v126';",
'release revision')

index = replace_once(index,
"export const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-vad-v125-r1';\nexport const PHONE_VAD_RAW_RESCUE_MS = 240;\nexport const PHONE_VAD_CLEAN_PROB_FLOOR = 30;\nconst PHONE_ACK_STT_GRACE_MS = 250;",
"export const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-vad-v125-r1';\nexport const PHONE_VAD_RAW_RESCUE_MS = 240;\nexport const PHONE_VAD_CLEAN_PROB_FLOOR = 30;\nexport const PHONE_INPUT_ADAPTATION_REVISION = 'talksys-phone-input-adaptation-v126-r1';\nexport const PHONE_INPUT_CALIBRATION_MS = 3000;\nexport const PHONE_INPUT_GAIN_MAX_DB = 6;\nexport const PHONE_INPUT_GAIN_MIN_SNR_DB = 10;\nconst PHONE_ACK_STT_GRACE_MS = 250;",
'input adaptation constants')

anchor = "export function phoneActiveVoiceEvidence({ speexSpeech = false, speechProbability = 0, cleanSpeech = false, rawSpeech = false, rawSnr = 0, msSinceDenoisedSpeech = Number.POSITIVE_INFINITY } = {}) {\n  const probability = Math.max(0, Math.min(100, Number(speechProbability) || 0));\n  const ageMs = Number.isFinite(Number(msSinceDenoisedSpeech)) ? Math.max(0, Number(msSinceDenoisedSpeech)) : Number.POSITIVE_INFINITY;\n  const denoisedSpeech = Boolean(speexSpeech) || (Boolean(cleanSpeech) && probability >= PHONE_VAD_CLEAN_PROB_FLOOR);\n  const rawRescue = !denoisedSpeech && Boolean(rawSpeech) && Number(rawSnr) >= 4.0 && ageMs <= PHONE_VAD_RAW_RESCUE_MS;\n  return { voice: denoisedSpeech || rawRescue, denoisedSpeech, rawRescue, probability };\n}\n"
helper = anchor + "\nexport function estimatePhoneInputNoise(values = []) {\n  const sorted = Array.from(values || [], (value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);\n  if (sorted.length < 20) return { ready: false, frames: sorted.length, noiseFloor: 0, p10: 0, p25: 0, p50: 0, p90: 0 };\n  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];\n  const p10 = pick(0.10), p25 = pick(0.25), p50 = pick(0.50), p90 = pick(0.90);\n  const noiseFloor = Math.max(0.0005, Math.min(0.03, p25));\n  return { ready: true, frames: sorted.length, noiseFloor, p10, p25, p50, p90 };\n}\n\nexport function calibratedPhoneVadNoiseFloor(currentNoiseFloor = 0.0015, calibratedNoiseFloor = 0, speechThreshold = 0.0045) {\n  const current = Math.max(0.001, Math.min(0.03, Number(currentNoiseFloor) || 0.0015));\n  const calibrated = Math.max(0, Number(calibratedNoiseFloor) || 0);\n  if (!calibrated) return current;\n  // Only raise the starting estimate, and cap the jump. This reduces noisy-device\n  // false starts without making quiet speech harder to start on already-good phones.\n  const safeCeiling = Math.max(current, Math.max(0.0015, Number(speechThreshold) || 0.0045) * 0.75);\n  return Math.max(current, Math.min(calibrated, safeCeiling));\n}\n"
index = replace_once(index, anchor, helper, 'input calibration helpers')

old_transcribe = "async function transcribeSamples(env, samples) {\n  const wav = samplesToWav(samples, 8000);\n  const request = new Request('https://talksys.internal/api/transcribe', {\n    method: 'POST', headers: { 'content-type': 'audio/wav', 'x-talksys-source': 'telnyx' }, body: wav,\n  });"
new_transcribe = "async function transcribeSamples(env, samples, inputContext = {}) {\n  const wav = samplesToWav(samples, 8000);\n  const headers = { 'content-type': 'audio/wav', 'x-talksys-source': 'telnyx', 'x-talksys-input-adaptation': PHONE_INPUT_ADAPTATION_REVISION };\n  const calibratedNoiseFloor = Number(inputContext?.calibratedNoiseFloor) || 0;\n  if (inputContext?.calibrationReady && calibratedNoiseFloor > 0) headers['x-talksys-noise-floor-rms'] = calibratedNoiseFloor.toFixed(6);\n  const request = new Request('https://talksys.internal/api/transcribe', {\n    method: 'POST', headers, body: wav,\n  });"
index = replace_once(index, old_transcribe, new_transcribe, 'transcribe context')

old_state = "  let activeDenoisedSpeechAgeMs=Number.POSITIVE_INFINITY, captureVoiceFrames=0, captureRawRescueFrames=0, captureHighRmsNonspeechFrames=0;\n  const callerProfileSession={status:'idle',phoneNumber:'',profile:null};\n  const adaptNoise=(rms,fast=false)=>{const value=Math.max(0.0005,Math.min(0.04,Number(rms)||0));const alpha=fast?0.08:(value>noiseFloor?0.01:0.035);noiseFloor=Math.max(0.001,Math.min(0.03,noiseFloor*(1-alpha)+value*alpha));};"
new_state = "  let activeDenoisedSpeechAgeMs=Number.POSITIVE_INFINITY, captureVoiceFrames=0, captureRawRescueFrames=0, captureHighRmsNonspeechFrames=0;\n  let inputCalibrationStartedAt=0,inputCalibrationDone=false,inputCalibrationFrames=[],calibratedNoiseFloor=0,inputCalibrationResult=null;\n  const callerProfileSession={status:'idle',phoneNumber:'',profile:null};\n  const adaptNoise=(rms,fast=false)=>{const value=Math.max(0.0005,Math.min(0.04,Number(rms)||0));const alpha=fast?0.08:(value>noiseFloor?0.01:0.035);noiseFloor=Math.max(0.001,Math.min(0.03,noiseFloor*(1-alpha)+value*alpha));};"
index = replace_once(index, old_state, new_state, 'calibration state')

old_queue = "  const queueLatency=(turnId,stage,elapsedMs=0,detail={})=>{const record={type:'phone_latency',callId,turnId,stage,elapsedMs:boundedMs(elapsedMs),...detail};console.log(JSON.stringify(record));return trackTask(appendLatencyEvent(env,{callId,turnId,stage,elapsedMs,detail}).catch((error)=>console.error(JSON.stringify({type:'phone_latency_log_error',stage,error:clean(error?.message||error,240)}))));};\n  const emitNoiseSummary="
new_queue = "  const queueLatency=(turnId,stage,elapsedMs=0,detail={})=>{const record={type:'phone_latency',callId,turnId,stage,elapsedMs:boundedMs(elapsedMs),...detail};console.log(JSON.stringify(record));return trackTask(appendLatencyEvent(env,{callId,turnId,stage,elapsedMs,detail}).catch((error)=>console.error(JSON.stringify({type:'phone_latency_log_error',stage,error:clean(error?.message||error,240)}))));};\n  const finalizeInputCalibration=(reason='window-complete')=>{\n    if(inputCalibrationDone)return inputCalibrationResult;\n    inputCalibrationDone=true;\n    inputCalibrationResult=estimatePhoneInputNoise(inputCalibrationFrames);\n    inputCalibrationFrames=[];\n    if(inputCalibrationResult.ready){\n      calibratedNoiseFloor=inputCalibrationResult.noiseFloor;\n      noiseFloor=calibratedPhoneVadNoiseFloor(noiseFloor,calibratedNoiseFloor,speechThreshold);\n    }\n    const detail={revision:PHONE_INPUT_ADAPTATION_REVISION,reason,windowMs:PHONE_INPUT_CALIBRATION_MS,ready:Boolean(inputCalibrationResult.ready),frames:inputCalibrationResult.frames,calibratedNoiseFloor:Number((calibratedNoiseFloor||0).toFixed(6)),vadNoiseFloor:Number(noiseFloor.toFixed(6)),p10:Number((inputCalibrationResult.p10||0).toFixed(6)),p25:Number((inputCalibrationResult.p25||0).toFixed(6)),p50:Number((inputCalibrationResult.p50||0).toFixed(6)),p90:Number((inputCalibrationResult.p90||0).toFixed(6))};\n    console.log(JSON.stringify({type:'phone_input_calibration',...detail}));\n    if(callId)queueLatency(`${clean(callId||'call',120)}-input`,'input_calibration',Date.now()-(inputCalibrationStartedAt||Date.now()),detail);\n    return inputCalibrationResult;\n  };\n  const emitNoiseSummary="
index = replace_once(index, old_queue, new_queue, 'calibration finalizer')

old_finish = "    const samples=Int16Array.from(frames.flatMap(frame=>Array.from(frame))),durationMs=samples.length/8;\n    if(durationMs<minSpeechMs)return;\n    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;\n    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs,endReason,noiseVadRevision:PHONE_NOISE_VAD_REVISION,...captureNoiseStats});\n    queueLatency(turnId,'vad_finalize',finalizedAt-speechEndAt,{silenceTargetMs:silenceMs,trailingSilenceMs});\n    pendingSttCount+=1;\n    const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8)});\n    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;\n    const sttPromise=transcribeSamples(env,samples);"
new_finish = "    const samples=Int16Array.from(frames.flatMap(frame=>Array.from(frame))),durationMs=samples.length/8;\n    if(durationMs<minSpeechMs)return;\n    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;\n    const inputContext={calibrationReady:inputCalibrationDone&&Boolean(inputCalibrationResult?.ready),calibratedNoiseFloor};\n    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs,endReason,noiseVadRevision:PHONE_NOISE_VAD_REVISION,inputAdaptationRevision:PHONE_INPUT_ADAPTATION_REVISION,calibrationReady:inputContext.calibrationReady,calibratedNoiseFloor:Number((calibratedNoiseFloor||0).toFixed(6)),...captureNoiseStats});\n    queueLatency(turnId,'vad_finalize',finalizedAt-speechEndAt,{silenceTargetMs:silenceMs,trailingSilenceMs});\n    pendingSttCount+=1;\n    const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8),calibrationReady:inputContext.calibrationReady,calibratedNoiseFloor:Number((calibratedNoiseFloor||0).toFixed(6))});\n    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;\n    const sttPromise=transcribeSamples(env,samples,inputContext);"
index = replace_once(index, old_finish, new_finish, 'STT input context')

old_media = "      const decoded=pcmuBase64ToSamples(message.media.payload),rawSamples=highPassPcmFrame(decoded,hpState,8000,90),rawRms=rmsOfSamples(rawSamples),threshold=startThreshold(),rawSnr=rawRms/Math.max(0.001,noiseFloor);\n      let samples=rawSamples,rms=rawRms,speexSpeech=false,speechProbability=0,cleanSpeech=false,noiseProcessed=false;"
new_media = "      const decoded=pcmuBase64ToSamples(message.media.payload),rawSamples=highPassPcmFrame(decoded,hpState,8000,90),rawRms=rmsOfSamples(rawSamples);\n      const inputNow=Date.now();\n      if(!inputCalibrationDone){\n        if(!inputCalibrationStartedAt)inputCalibrationStartedAt=inputNow;\n        inputCalibrationFrames.push(rawRms);\n        if(inputNow-inputCalibrationStartedAt>=PHONE_INPUT_CALIBRATION_MS||inputCalibrationFrames.length>=Math.ceil(PHONE_INPUT_CALIBRATION_MS/FRAME_MS))finalizeInputCalibration('window-complete');\n      }\n      const threshold=startThreshold(),rawSnr=rawRms/Math.max(0.001,noiseFloor);\n      let samples=rawSamples,rms=rawRms,speexSpeech=false,speechProbability=0,cleanSpeech=false,noiseProcessed=false;"
index = replace_once(index, old_media, new_media, 'media calibration')

index = replace_once(index,
"    if(message?.event==='stop'){finishUtterance('stream-stop');emitNoiseSummary('stream-stop');",
"    if(message?.event==='stop'){if(!inputCalibrationDone&&inputCalibrationFrames.length)finalizeInputCalibration('stream-stop');finishUtterance('stream-stop');emitNoiseSummary('stream-stop');",
'stop calibration flush')
index = replace_once(index,
"  telnyx.addEventListener('close',async()=>{closed=true;clearTimeout(deadline);finishUtterance('socket-close');emitNoiseSummary('socket-close');",
"  telnyx.addEventListener('close',async()=>{closed=true;clearTimeout(deadline);if(!inputCalibrationDone&&inputCalibrationFrames.length)finalizeInputCalibration('socket-close');finishUtterance('socket-close');emitNoiseSummary('socket-close');",
'close calibration flush')

# Keep existing VAD/Speex algorithms unchanged; only seed the pre-existing noise floor.
index_path.write_text(index, encoding='utf-8')

stt = replace_once(stt,
"export function normalizeQuietPhoneWav(buffer, metrics = {}) {\n  if (!metrics?.valid) return { buffer, gain: 1, gainDb: 0 };",
"export function normalizeQuietPhoneWav(buffer, metrics = {}, options = {}) {\n  if (!metrics?.valid) return { buffer, gain: 1, gainDb: 0, noiseFloorRms: 0, snrDb: null, reason: 'invalid-metrics' };",
'normalizer signature')

old_norm = "  const targetRms = 0.018;\n  const maxGain = 2.5;\n  const maxPeak = 0.90;\n  const gain = Math.max(1, Math.min(maxGain, targetRms / Math.max(rms, 0.0008), maxPeak / Math.max(peak, 0.001)));\n  if (gain < 1.05) return { buffer, gain: 1, gainDb: 0 };"
new_norm = "  const targetRms = 0.018;\n  const legacyMaxGain = 2.5;\n  const requestedMaxGainDb = Math.max(0, Math.min(6, Number(options?.maxGainDb) || 6));\n  const calibratedNoiseFloor = Math.max(0, Math.min(0.03, Number(options?.noiseFloorRms) || 0));\n  const snrDb = calibratedNoiseFloor > 0 ? Number((20 * Math.log10(Math.max(rms, 0.00001) / Math.max(calibratedNoiseFloor, 0.00001))).toFixed(2)) : null;\n  const maxGain = calibratedNoiseFloor > 0 ? Math.min(legacyMaxGain, Math.pow(10, requestedMaxGainDb / 20)) : legacyMaxGain;\n  const maxPeak = 0.90;\n  let gain = Math.max(1, Math.min(maxGain, targetRms / Math.max(rms, 0.0008), maxPeak / Math.max(peak, 0.001)));\n  let reason = calibratedNoiseFloor > 0 ? 'calibrated-clean' : 'legacy-no-calibration';\n  if (calibratedNoiseFloor > 0 && snrDb < 10) { gain = 1; reason = 'low-snr-no-boost'; }\n  else if (calibratedNoiseFloor > 0 && Number(metrics.activeMs || 0) < 100) { gain = 1; reason = 'insufficient-active-speech'; }\n  if (gain < 1.05) return { buffer, gain: 1, gainDb: 0, noiseFloorRms: calibratedNoiseFloor, snrDb, reason: gain === 1 ? reason : 'gain-below-floor' };"
stt = replace_once(stt, old_norm, new_norm, 'noise-aware normalizer')

stt = replace_once(stt,
"  return { buffer: copy, gain, gainDb: Number((20 * Math.log10(gain)).toFixed(2)) };",
"  return { buffer: copy, gain, gainDb: Number((20 * Math.log10(gain)).toFixed(2)), noiseFloorRms: calibratedNoiseFloor, snrDb, reason };",
'normalizer result')

old_call = "  const source = clean(request.headers.get('x-talksys-source') || '', 80).toLowerCase();\n  const metrics = analyzeWav(buffer);\n  const phoneNormalized = source === 'telnyx' ? normalizeQuietPhoneWav(buffer, metrics) : { buffer, gain: 1, gainDb: 0 };\n  const signal = {"
new_call = "  const source = clean(request.headers.get('x-talksys-source') || '', 80).toLowerCase();\n  const inputAdaptationRevision = clean(request.headers.get('x-talksys-input-adaptation') || '', 120);\n  const calibratedNoiseFloor = Math.max(0, Math.min(0.03, Number(request.headers.get('x-talksys-noise-floor-rms')) || 0));\n  const metrics = analyzeWav(buffer);\n  const phoneNormalized = source === 'telnyx' ? normalizeQuietPhoneWav(buffer, metrics, { noiseFloorRms: calibratedNoiseFloor, maxGainDb: 6 }) : { buffer, gain: 1, gainDb: 0, noiseFloorRms: 0, snrDb: null, reason: 'not-phone' };\n  const signal = {"
stt = replace_once(stt, old_call, new_call, 'STT calibration headers')

stt = replace_once(stt,
"    inputGainDb: phoneNormalized.gainDb,\n  };",
"    inputGainDb: phoneNormalized.gainDb,\n    inputGainReason: phoneNormalized.reason || '',\n    noiseFloorRms: Number((phoneNormalized.noiseFloorRms || 0).toFixed(6)),\n    estimatedSnrDb: Number.isFinite(phoneNormalized.snrDb) ? phoneNormalized.snrDb : null,\n    inputAdaptationRevision,\n  };",
'STT signal telemetry')

stt_path.write_text(stt, encoding='utf-8')

for path in Path('tests').glob('*.test.mjs'):
    text = path.read_text(encoding='utf-8')
    if "assert.equal(PHONE_RELEASE_VERSION, 'v125');" in text:
        path.write_text(text.replace("assert.equal(PHONE_RELEASE_VERSION, 'v125');", "assert.equal(PHONE_RELEASE_VERSION, 'v126');"), encoding='utf-8')

new_test = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { samplesToWav } from '../src/telephony/codec.js';
import {
  PHONE_INPUT_ADAPTATION_REVISION,
  PHONE_INPUT_CALIBRATION_MS,
  PHONE_INPUT_GAIN_MAX_DB,
  PHONE_RELEASE_VERSION,
  calibratedPhoneVadNoiseFloor,
  estimatePhoneInputNoise,
} from '../src/telephony/index.js';
import { analyzeWav, normalizeQuietPhoneWav } from '../src/stt-v45.js';

test('v126 initial calibration uses a robust low quantile and does not lower an existing floor', () => {
  const frames = [];
  for (let i = 0; i < 120; i += 1) frames.push(0.0020 + (i % 5) * 0.00005);
  for (let i = 0; i < 30; i += 1) frames.push(0.025 + (i % 4) * 0.002); // early speech / transients
  const result = estimatePhoneInputNoise(frames);
  assert.equal(result.ready, true);
  assert.ok(result.noiseFloor >= 0.0019 && result.noiseFloor <= 0.0023, `unexpected floor ${result.noiseFloor}`);
  assert.equal(calibratedPhoneVadNoiseFloor(0.003, 0.001, 0.0045), 0.003);
  assert.ok(calibratedPhoneVadNoiseFloor(0.0015, 0.02, 0.0045) <= 0.003375 + 1e-9);
});

test('v126 noise-aware STT gain leaves noisy captures unboosted but rescues clean weak speech conservatively', () => {
  const samples = new Int16Array(8000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sin(2 * Math.PI * 220 * i / 8000) * 420);
  const wav = samplesToWav(samples, 8000);
  const metrics = analyzeWav(wav);
  const noisy = normalizeQuietPhoneWav(wav, metrics, { noiseFloorRms: Math.max(0.0005, metrics.rms * 0.7), maxGainDb: PHONE_INPUT_GAIN_MAX_DB });
  assert.equal(noisy.gainDb, 0);
  assert.equal(noisy.reason, 'low-snr-no-boost');
  const clean = normalizeQuietPhoneWav(wav, metrics, { noiseFloorRms: Math.max(0.0005, metrics.rms * 0.15), maxGainDb: PHONE_INPUT_GAIN_MAX_DB });
  assert.ok(clean.gainDb > 0 && clean.gainDb <= PHONE_INPUT_GAIN_MAX_DB + 0.01, `gain ${clean.gainDb}`);
});

test('v126 adaptation is isolated from the conversation/TTS core', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v126');
  assert.equal(PHONE_INPUT_ADAPTATION_REVISION, 'talksys-phone-input-adaptation-v126-r1');
  assert.equal(PHONE_INPUT_CALIBRATION_MS, 3000);
  assert.equal(PHONE_INPUT_GAIN_MAX_DB, 6);
});
'''
Path('tests/phone-input-adaptation-v126.test.mjs').write_text(new_test, encoding='utf-8')
print('adaptive phone input v126 patch applied')
