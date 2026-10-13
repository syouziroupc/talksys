from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label):
    out, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one regex match, found {count}')
    return out


# 1) Expose Speex last-frame speech probability without changing NS/AGC settings.
path = Path('src/telephony/phone-noise-suppressor.js')
text = path.read_text()
text = replace_once(
    text,
    "        const speech = pre.processInt16(samples);\n        return { ok: true, samples, speech, elapsedMs: nowMs() - started, fallback: '' };",
    "        const speech = pre.processInt16(samples);\n        const probability = Math.max(0, Math.min(100, Number(pre.prob) || 0));\n        return { ok: true, samples, speech, probability, elapsedMs: nowMs() - started, fallback: '' };",
    'speex probability',
)
path.write_text(text)


# 2) Replace RMS-only active VAD with Speex/clean evidence + bounded RAW rescue.
path = Path('src/telephony/index.js')
text = path.read_text()
text = replace_once(text, "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v123-r1';", "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v125-r1';", 'runtime revision')
text = replace_once(text, "export const PHONE_RELEASE_VERSION = 'v123';", "export const PHONE_RELEASE_VERSION = 'v125';", 'release version')
text = replace_once(
    text,
    "export const PHONE_VAD_PREROLL_FRAMES = 12;\nconst PHONE_ACK_STT_GRACE_MS = 250;",
    "export const PHONE_VAD_PREROLL_FRAMES = 12;\nexport const PHONE_NOISE_VAD_REVISION = 'talksys-phone-noise-vad-v125-r1';\nexport const PHONE_VAD_RAW_RESCUE_MS = 240;\nexport const PHONE_VAD_CLEAN_PROB_FLOOR = 30;\nconst PHONE_ACK_STT_GRACE_MS = 250;",
    'noise VAD constants',
)
text = replace_once(
    text,
    "export function phoneVadFrameIsSpeech(rms = 0, noiseFloor = 0.0015, baseThreshold = 0.0045) {\n  const level = Math.max(0, Number(rms) || 0);\n  const noise = Math.max(0.001, Number(noiseFloor) || 0.0015);\n  return level >= phoneVadStartThreshold(baseThreshold, noiseFloor) && level / noise >= 1.6;\n}\n",
    "export function phoneVadFrameIsSpeech(rms = 0, noiseFloor = 0.0015, baseThreshold = 0.0045) {\n  const level = Math.max(0, Number(rms) || 0);\n  const noise = Math.max(0.001, Number(noiseFloor) || 0.0015);\n  return level >= phoneVadStartThreshold(baseThreshold, noiseFloor) && level / noise >= 1.6;\n}\n\nexport function phoneActiveVoiceEvidence({ speexSpeech = false, speechProbability = 0, cleanSpeech = false, rawSpeech = false, rawSnr = 0, msSinceDenoisedSpeech = Number.POSITIVE_INFINITY } = {}) {\n  const probability = Math.max(0, Math.min(100, Number(speechProbability) || 0));\n  const ageMs = Number.isFinite(Number(msSinceDenoisedSpeech)) ? Math.max(0, Number(msSinceDenoisedSpeech)) : Number.POSITIVE_INFINITY;\n  const denoisedSpeech = Boolean(speexSpeech) || (Boolean(cleanSpeech) && probability >= PHONE_VAD_CLEAN_PROB_FLOOR);\n  const rawRescue = !denoisedSpeech && Boolean(rawSpeech) && Number(rawSnr) >= 4.0 && ageMs <= PHONE_VAD_RAW_RESCUE_MS;\n  return { voice: denoisedSpeech || rawRescue, denoisedSpeech, rawRescue, probability };\n}\n",
    'active VAD helper',
)
text = replace_once(
    text,
    "    personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION,\n  };",
    "    personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION,\n    noiseSuppressionRevision: PHONE_NOISE_SUPPRESSION_REVISION,\n    noiseVadRevision: PHONE_NOISE_VAD_REVISION,\n  };",
    'runtime noise revisions',
)
text = replace_once(
    text,
    "  let phoneNoiseSuppressor=null, noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0;",
    "  let phoneNoiseSuppressor=null, noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0, noiseSummaryLogged=false;\n  let activeDenoisedSpeechAgeMs=Number.POSITIVE_INFINITY, captureVoiceFrames=0, captureRawRescueFrames=0, captureHighRmsNonspeechFrames=0;",
    'noise state',
)
text = replace_once(
    text,
    "  const queueLatency=(turnId,stage,elapsedMs=0,detail={})=>{const record={type:'phone_latency',callId,turnId,stage,elapsedMs:boundedMs(elapsedMs),...detail};console.log(JSON.stringify(record));return trackTask(appendLatencyEvent(env,{callId,turnId,stage,elapsedMs,detail}).catch((error)=>console.error(JSON.stringify({type:'phone_latency_log_error',stage,error:clean(error?.message||error,240)}))));};",
    "  const queueLatency=(turnId,stage,elapsedMs=0,detail={})=>{const record={type:'phone_latency',callId,turnId,stage,elapsedMs:boundedMs(elapsedMs),...detail};console.log(JSON.stringify(record));return trackTask(appendLatencyEvent(env,{callId,turnId,stage,elapsedMs,detail}).catch((error)=>console.error(JSON.stringify({type:'phone_latency_log_error',stage,error:clean(error?.message||error,240)}))));};\n  const emitNoiseSummary=(reason='unknown')=>{if(noiseSummaryLogged)return;noiseSummaryLogged=true;const detail={revision:PHONE_NOISE_SUPPRESSION_REVISION,noiseVadRevision:PHONE_NOISE_VAD_REVISION,reason,enabled:noiseSuppressionEnabled,ready:Boolean(phoneNoiseSuppressor),frames:noiseFrames,avgCpuMs:noiseFrames?Number((noiseCpuMs/noiseFrames).toFixed(4)):0,maxCpuMs:Number(noiseCpuMaxMs.toFixed(4)),fallbackFrames:noiseFallbackFrames};console.log(JSON.stringify({type:'phone_noise_suppression_summary',...detail}));if(callId)queueLatency(`${clean(callId||'call',120)}-noise`,'noise_suppression_summary',0,detail);};",
    'persisted noise summary',
)
text = replace_once(
    text,
    "  const finishUtterance=()=>{\n    if(!speechActive||!speechFrames.length)return;\n    const frames=speechFrames,myCapture=++captureSeq,finalizedAt=Date.now(),trailingSilenceMs=Math.max(0,silentFor);\n    speechActive=false;speechHits=0;bargeHits=0;silentFor=0;speechFrames=[];preRoll=[];\n    const samples=Int16Array.from(frames.flatMap(frame=>Array.from(frame))),durationMs=samples.length/8;\n    if(durationMs<minSpeechMs)return;\n    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;\n    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs});",
    "  const finishUtterance=(endReason='unknown')=>{\n    if(!speechActive||!speechFrames.length)return;\n    const frames=speechFrames,myCapture=++captureSeq,finalizedAt=Date.now(),trailingSilenceMs=Math.max(0,silentFor);\n    const captureNoiseStats={voiceFrames:captureVoiceFrames,rawRescueFrames:captureRawRescueFrames,highRmsNonspeechFrames:captureHighRmsNonspeechFrames};\n    speechActive=false;speechHits=0;bargeHits=0;silentFor=0;speechFrames=[];preRoll=[];activeDenoisedSpeechAgeMs=Number.POSITIVE_INFINITY;captureVoiceFrames=0;captureRawRescueFrames=0;captureHighRmsNonspeechFrames=0;\n    const samples=Int16Array.from(frames.flatMap(frame=>Array.from(frame))),durationMs=samples.length/8;\n    if(durationMs<minSpeechMs)return;\n    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;\n    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs,endReason,noiseVadRevision:PHONE_NOISE_VAD_REVISION,...captureNoiseStats});",
    'finish utterance metrics',
)

media_pattern = r"    if\(message\?\.event==='media'&&message\?\.media\?\.payload\)\{.*?\n    \}\n    if\(message\?\.event==='stop'\)\{.*?\n  \}\);\n  telnyx\.addEventListener\('error'"
media_replacement = """    if(message?.event==='media'&&message?.media?.payload){
      const decoded=pcmuBase64ToSamples(message.media.payload),rawSamples=highPassPcmFrame(decoded,hpState,8000,90),rawRms=rmsOfSamples(rawSamples),threshold=startThreshold(),rawSnr=rawRms/Math.max(0.001,noiseFloor);
      let samples=rawSamples,rms=rawRms,speexSpeech=false,speechProbability=0,cleanSpeech=false,noiseProcessed=false;
      if(phoneNoiseSuppressor&&!assistantPlaying){
        const processed=phoneNoiseSuppressor.process(rawSamples);
        noiseFrames+=1;noiseCpuMs+=processed.elapsedMs||0;noiseCpuMaxMs=Math.max(noiseCpuMaxMs,processed.elapsedMs||0);
        if(processed.ok&&processed.samples?.length===rawSamples.length){samples=processed.samples;rms=rmsOfSamples(samples);speexSpeech=Boolean(processed.speech);speechProbability=Math.max(0,Math.min(100,Number(processed.probability)||0));noiseProcessed=true;const cleanAlpha=rms>noiseCleanFloor?0.008:0.04;noiseCleanFloor=Math.max(0.0006,Math.min(0.02,noiseCleanFloor*(1-cleanAlpha)+Math.max(0.0003,rms)*cleanAlpha));cleanSpeech=phoneVadFrameIsSpeech(rms,noiseCleanFloor,Math.max(0.0028,speechThreshold*0.72));}else{noiseFallbackFrames+=1;samples=rawSamples;rms=rawRms;}
      }
      const rawSpeech=phoneVadFrameIsSpeech(rawRms,noiseFloor,speechThreshold);
      if(!speechActive){
        preRoll.push(samples);if(preRoll.length>PHONE_VAD_PREROLL_FRAMES)preRoll.shift();
        if(assistantPlaying){const bargeThreshold=Math.max(threshold*1.25,noiseFloor*3.2,0.010);if(rawRms>=bargeThreshold&&rawSnr>=1.8)bargeHits+=1;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=5){interruptPlayback();speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;bargeHits=0;activeDenoisedSpeechAgeMs=0;captureVoiceFrames=0;captureRawRescueFrames=0;captureHighRmsNonspeechFrames=0;}else adaptNoise(rawRms,false);return;}
        const speechCandidate=noiseProcessed?(speexSpeech||cleanSpeech||(rawSpeech&&rawSnr>=3.2)):rawSpeech;
        if(speechCandidate)speechHits+=1;else{speechHits=0;adaptNoise(rawRms,false);}if(speechHits>=PHONE_VAD_START_HITS){speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;activeDenoisedSpeechAgeMs=0;captureVoiceFrames=0;captureRawRescueFrames=0;captureHighRmsNonspeechFrames=0;}return;
      }
      speechFrames.push(samples);
      const evidence=noiseProcessed?phoneActiveVoiceEvidence({speexSpeech,speechProbability,cleanSpeech,rawSpeech,rawSnr,msSinceDenoisedSpeech:activeDenoisedSpeechAgeMs}):{voice:rawSpeech,denoisedSpeech:false,rawRescue:false,probability:0};
      if(noiseProcessed){
        if(evidence.denoisedSpeech)activeDenoisedSpeechAgeMs=0;else if(Number.isFinite(activeDenoisedSpeechAgeMs))activeDenoisedSpeechAgeMs+=FRAME_MS;
        if(evidence.voice)captureVoiceFrames+=1;
        if(evidence.rawRescue)captureRawRescueFrames+=1;
        const highResidualRms=rms>=Math.max(noiseCleanFloor*1.65,speechThreshold*0.62);
        if(!evidence.voice&&highResidualRms)captureHighRmsNonspeechFrames+=1;
      }
      if(evidence.voice)silentFor=0;else silentFor+=FRAME_MS;
      const durationMs=speechFrames.length*FRAME_MS;
      if(silentFor>=silenceMs)finishUtterance('hangover');else if(durationMs>=maxUtteranceMs)finishUtterance('max-utterance');return;
    }
    if(message?.event==='stop'){finishUtterance('stream-stop');emitNoiseSummary('stream-stop');try{phoneNoiseSuppressor?.destroy?.();}catch{}interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');closeSocket(telnyx,1000,'telnyx_stopped');}
  });
  telnyx.addEventListener('error'"""
text = regex_once(text, media_pattern, media_replacement, 'media VAD state machine')
text = replace_once(
    text,
    "  telnyx.addEventListener('close',async()=>{closed=true;clearTimeout(deadline);finishUtterance();interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');});",
    "  telnyx.addEventListener('close',async()=>{closed=true;clearTimeout(deadline);finishUtterance('socket-close');emitNoiseSummary('socket-close');interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');});",
    'close summary',
)
text = replace_once(
    text,
    "        const spoken = await speak(turn.answer, { purpose: 'answer', turnId, originAt: speechEndAt });\n        if(!spoken)await setCallStatus(env,callId,'tts-error');",
    "        const spoken = await speak(turn.answer, { purpose: 'answer', turnId, originAt: speechEndAt });\n        if(!spoken&&!closed&&myVersion===turnVersion)await setCallStatus(env,callId,'tts-error');",
    'avoid cancellation as tts error',
)
text = replace_once(
    text,
    "    inputAudio: 'Telnyx PCMU 8kHz → 90Hz HPF → 適応VAD → TalkSys STT',",
    "    inputAudio: 'Telnyx PCMU 8kHz → 90Hz HPF → SpeexDSP NS/VAD → hangover判定 → TalkSys STT',",
    'health input description',
)
text = replace_once(
    text,
    "    adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, phoneVadBaseRms: Number(env?.TELEPHONY_VAD_RMS || 0.0045), phoneVadStartNoiseRatio: PHONE_VAD_START_NOISE_RATIO, phoneVadStartHits: PHONE_VAD_START_HITS, phoneVadPreRollMs: PHONE_VAD_PREROLL_FRAMES * FRAME_MS,",
    "    adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, noiseSuppressionRevision: PHONE_NOISE_SUPPRESSION_REVISION, noiseVadRevision: PHONE_NOISE_VAD_REVISION, phoneVadBaseRms: Number(env?.TELEPHONY_VAD_RMS || 0.0045), phoneVadStartNoiseRatio: PHONE_VAD_START_NOISE_RATIO, phoneVadStartHits: PHONE_VAD_START_HITS, phoneVadPreRollMs: PHONE_VAD_PREROLL_FRAMES * FRAME_MS, phoneVadRawRescueMs: PHONE_VAD_RAW_RESCUE_MS,",
    'health noise VAD fields',
)
path.write_text(text)


# 3) Fix deterministic frequent phone replies and make respectful behavior a system invariant.
path = Path('src/integrated-entry.js')
text = path.read_text()
text = replace_once(
    text,
    "const CURRENT_TIME_ONLY_RE = /^(?:(?:今|現在)(?:の)?(?:時刻|時間)?(?:は)?(?:何時|なんじ)(?:ですか|なの|だ|でしょうか)?|(?:今|現在)(?:の)?(?:時刻|時間)(?:を)?(?:教えて|おしえて|知りたい)(?:ください|下さい)?|(?:時間|時刻)(?:は)?(?:何時|なんじ)(?:ですか)?|(?:時間|時刻)(?:を)?(?:教えて|おしえて)(?:ください|下さい)?)[。！!？?…\\s]*$/i;",
    "const CURRENT_TIME_ONLY_RE = /^(?:(?:今|現在)(?:の)?(?:時刻|時間)?(?:は)?(?:何時|なんじ)(?:ですか|なの|だ|でしょうか)?|(?:今|現在)(?:の)?(?:時刻|時間)(?:を)?(?:教えて|おしえて|知りたい)(?:ください|下さい)?|(?:時間|時刻)(?:は)?(?:何時|なんじ)(?:ですか)?|(?:時間|時刻)(?:を)?(?:教えて|おしえて)(?:ください|下さい)?)[。！!？?…\\s]*$/i;\nconst CURRENT_TIME_COLLOQUIAL_RE = /^(?:今|現在)(?:の)?(?:時間|時刻)(?:は|を)?[。！!？?…\\s]*$/i;\nconst THANKS_ONLY_RE = /^(?:ありがとう(?:ございます|ございました)?|どうもありがとう(?:ございます|ございました)?|助かりました)[。！!？?…\\s]*$/i;\nconst GOODBYE_ONLY_RE = /^(?:さようなら|失礼します|またね|じゃあね|電話を切ります|切ります)[。！!？?…\\s]*$/i;",
    'deterministic phone regexes',
)
text = replace_once(
    text,
    "function deterministicCurrentTimeResult(text = '', now = new Date(), started = Date.now()) {\n  if (!CURRENT_TIME_ONLY_RE.test(compact(text, 200))) return null;",
    "function deterministicCurrentTimeResult(text = '', now = new Date(), started = Date.now()) {\n  const value = compact(text, 200);\n  if (!CURRENT_TIME_ONLY_RE.test(value) && !CURRENT_TIME_COLLOQUIAL_RE.test(value)) return null;",
    'colloquial time route',
)
clock_end = """  };
}


function deterministicLocationClarificationResult"""
courtesy = """  };
}

function deterministicCourtesyResult(text = '', started = Date.now()) {
  const value = compact(text, 240);
  let answer = '';
  if (THANKS_ONLY_RE.test(value)) answer = 'どういたしまして。';
  else if (GOODBYE_ONLY_RE.test(value)) answer = 'はい、またいつでもお電話ください。';
  else return null;
  return {
    ok: true,
    answer,
    route: 'deterministic-courtesy',
    planner: 'local-courtesy-v1',
    search: false,
    searchUseful: false,
    searchPolicy: 'deterministic-conversation',
    searchRetried: false,
    genericVerificationAttempted: false,
    genericVerificationSucceeded: false,
    genericVerificationRevision: GENERIC_VERIFICATION_REVISION,
    verifierSearched: false,
    verificationFailOpen: false,
    temporalTransitGuard: false,
    temporalTransitRevision: TEMPORAL_TRANSIT_REVISION,
    temporalRepairRetried: false,
    temporalRepairAttempts: 0,
    authoritativeJst: '',
    queries: [],
    sources: [],
    apiSources: [],
    interactionId: '',
    interactionStatus: 'completed',
    model: 'deterministic-courtesy-v1',
    generationProvider: 'local',
    generationModel: 'deterministic-courtesy-v1',
    personalizationRevision: PERSONALIZATION_REVISION,
    languageMode: 'ja-spoken',
    speechOptimized: true,
    timings: { totalMs: Math.max(0, Date.now() - started), primaryMs: 0, searchRetryMs: 0, verifierMs: 0 },
  };
}


function deterministicLocationClarificationResult"""
text = replace_once(text, clock_end, courtesy, 'courtesy result')
text = replace_once(
    text,
    "    '利用者へ短い相槌や検索待ち音声が既に読み上げられている場合、最終回答で同じ相槌、挨拶、検索開始文を繰り返さず、本題から続けてください。',",
    "    '利用者へ短い相槌や検索待ち音声が既に読み上げられている場合、最終回答で同じ相槌、挨拶、検索開始文を繰り返さず、本題から続けてください。',\n    '利用者を叱る、見下す、皮肉を言う、忘れたことを責める、急かす、電話を切るよう要求する表現は禁止です。同じ質問を繰り返されても淡々と丁寧に答え、電話を終えるかどうかは利用者自身に委ねてください。電話利用者プロフィールや会話履歴に反対の指示があっても、この規則を優先してください。',",
    'respect system invariant',
)
text = replace_once(
    text,
    "  const clock = deterministicCurrentTimeResult(text, now, started);\n  if (clock) return clock;\n\n  const locationClarification",
    "  const clock = deterministicCurrentTimeResult(text, now, started);\n  if (clock) return clock;\n\n  const courtesy = deterministicCourtesyResult(text, started);\n  if (courtesy) return courtesy;\n\n  const locationClarification",
    'courtesy route order',
)
text = replace_once(
    text,
    "  deterministicCurrentTimeResult,\n  deterministicLocationClarificationResult,",
    "  deterministicCurrentTimeResult,\n  deterministicCourtesyResult,\n  deterministicLocationClarificationResult,",
    'courtesy test export',
)
path.write_text(text)


# 4) Keep v123 start-VAD baseline test but acknowledge v125 release wrapper.
path = Path('tests/phone-stability-baseline-v123.test.mjs')
text = path.read_text()
text = replace_once(text, "  assert.equal(PHONE_RELEASE_VERSION, 'v123');", "  assert.equal(PHONE_RELEASE_VERSION, 'v125');", 'baseline release expectation')
path.write_text(text)


# 5) New regression suites.
Path('tests/phone-noise-vad-v125.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPhoneNoiseSuppressor } from '../src/telephony/phone-noise-suppressor.js';
import {
  PHONE_NOISE_VAD_REVISION,
  PHONE_RELEASE_VERSION,
  PHONE_VAD_RAW_RESCUE_MS,
  phoneActiveVoiceEvidence,
} from '../src/telephony/index.js';

function frame(seed = 1, voice = 0) {
  let x = seed >>> 0;
  const out = new Int16Array(160);
  for (let i = 0; i < out.length; i += 1) {
    x = (1664525 * x + 1013904223) >>> 0;
    const noise = ((x / 0xffffffff) * 2 - 1) * 700;
    const tone = voice ? Math.sin(2 * Math.PI * 220 * i / 8000) * voice : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(noise + tone)));
  }
  return out;
}

test('v125 exposes bounded Speex speech probability within the existing CPU budget', async () => {
  const ns = await createPhoneNoiseSuppressor();
  for (let i = 0; i < 80; i += 1) ns.process(frame(i, i > 40 ? 1000 : 0));
  let elapsed = 0;
  let max = 0;
  for (let i = 0; i < 800; i += 1) {
    const out = ns.process(frame(i + 5000, i % 4 === 0 ? 950 : 0));
    assert.equal(out.ok, true);
    assert.ok(Number.isFinite(out.probability));
    assert.ok(out.probability >= 0 && out.probability <= 100);
    elapsed += out.elapsedMs;
    max = Math.max(max, out.elapsedMs);
  }
  assert.ok(elapsed / 800 < 2.0, `average frame CPU ${(elapsed / 800).toFixed(3)} ms exceeds 2ms budget`);
  assert.ok(max < 20, `single frame CPU ${max.toFixed(3)} ms exceeds one 20ms frame`);
  ns.destroy();
});

test('v125 active VAD cannot be held open indefinitely by raw high-RMS noise', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v125');
  assert.equal(PHONE_NOISE_VAD_REVISION, 'talksys-phone-noise-vad-v125-r1');
  assert.equal(PHONE_VAD_RAW_RESCUE_MS, 240);
  assert.equal(phoneActiveVoiceEvidence({ speexSpeech: true, speechProbability: 60 }).voice, true);
  assert.equal(phoneActiveVoiceEvidence({ cleanSpeech: true, speechProbability: 45 }).denoisedSpeech, true);
  const rescue = phoneActiveVoiceEvidence({ rawSpeech: true, rawSnr: 5, msSinceDenoisedSpeech: 120 });
  assert.equal(rescue.rawRescue, true);
  assert.equal(rescue.voice, true);
  const expired = phoneActiveVoiceEvidence({ rawSpeech: true, rawSnr: 20, msSinceDenoisedSpeech: 260 });
  assert.equal(expired.rawRescue, false);
  assert.equal(expired.voice, false);
  assert.equal(phoneActiveVoiceEvidence({ speechProbability: 10, cleanSpeech: false, rawSpeech: false, rawSnr: 100, msSinceDenoisedSpeech: 0 }).voice, false);
});

test('v125 media continuation uses voice evidence instead of the removed RMS-only hold-open rule', () => {
  const source = fs.readFileSync('src/telephony/index.js', 'utf8');
  assert.match(source, /phoneActiveVoiceEvidence\(\{speexSpeech,speechProbability,cleanSpeech,rawSpeech,rawSnr,msSinceDenoisedSpeech:activeDenoisedSpeechAgeMs\}\)/);
  assert.match(source, /if\(evidence\.voice\)silentFor=0;else silentFor\+=FRAME_MS/);
  assert.match(source, /finishUtterance\('hangover'\)/);
  assert.match(source, /finishUtterance\('max-utterance'\)/);
  assert.doesNotMatch(source, /if\(rms>=Math\.max\(\(phoneNoiseSuppressor\?noiseCleanFloor:noiseFloor\)\*1\.65,speechThreshold\*0\.62\)\)silentFor=0/);
  assert.match(source, /noise_suppression_summary/);
});
''')

Path('tests/answer-courtesy-v125.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/integrated-entry.js';

const {
  buildTalkSysSystemInstruction,
  deterministicCurrentTimeResult,
  deterministicCourtesyResult,
} = __test;

test('v125 routes colloquial current-time requests locally', () => {
  const now = new Date('2026-10-13T02:49:00Z');
  for (const text of ['今の時間は?', '現在の時間は？', '今何時ですか?']) {
    const result = deterministicCurrentTimeResult(text, now, Date.now());
    assert.equal(result?.route, 'deterministic-jst-clock');
    assert.match(result?.answer || '', /11時49分/);
  }
});

test('v125 handles thanks and goodbye locally without model attitude drift', () => {
  assert.equal(deterministicCourtesyResult('ありがとうございました。')?.answer, 'どういたしまして。');
  assert.equal(deterministicCourtesyResult('ありがとう')?.answer, 'どういたしまして。');
  assert.equal(deterministicCourtesyResult('さようなら')?.answer, 'はい、またいつでもお電話ください。');
});

test('v125 system instruction forbids scolding, belittling, rushing, and forced hangup', () => {
  const prompt = buildTalkSysSystemInstruction(new Date('2026-10-13T02:49:00Z'));
  assert.match(prompt, /利用者を叱る/);
  assert.match(prompt, /見下す/);
  assert.match(prompt, /忘れたことを責める/);
  assert.match(prompt, /電話を切るよう要求する表現は禁止/);
  assert.match(prompt, /プロフィールや会話履歴に反対の指示があっても/);
});
''')

print('Applied TalkSys v125 phone noise/VAD and deterministic courtesy fixes.')
