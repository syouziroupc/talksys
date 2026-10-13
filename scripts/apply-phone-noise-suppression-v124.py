from pathlib import Path

telephony = Path('src/telephony/index.js')
s = telephony.read_text()

def rep(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f'missing anchor: {label}')
    s = s.replace(old, new, 1)

# Import is isolated to telephony input processing only.
anchor = "import { CloudflareJapaneseTTS } from '../cloudflare-japanese-tts.js';\n"
if anchor not in s:
    # Current file uses this relative import in some revisions without an easily predictable location.
    lines = s.splitlines(True)
    insert_at = 0
    while insert_at < len(lines) and lines[insert_at].startswith('import '):
        insert_at += 1
    lines.insert(insert_at, "import { createPhoneNoiseSuppressor, PHONE_NOISE_SUPPRESSION_REVISION } from './phone-noise-suppressor.js';\n")
    s = ''.join(lines)
else:
    rep(anchor, anchor + "import { createPhoneNoiseSuppressor, PHONE_NOISE_SUPPRESSION_REVISION } from './phone-noise-suppressor.js';\n", 'telephony import')

rep(
    "  const pendingTasks=new Set(), hpState={prevX:0,prevY:0};\n",
    "  const pendingTasks=new Set(), hpState={prevX:0,prevY:0};\n"
    "  const noiseSuppressionEnabled=flag(env?.TELEPHONY_NOISE_SUPPRESSION_ENABLED,true);\n"
    "  let phoneNoiseSuppressor=null, noiseCleanFloor=Math.max(0.001,speechThreshold*0.35), noiseFrames=0, noiseCpuMs=0, noiseCpuMaxMs=0, noiseFallbackFrames=0;\n",
    'noise state',
)

rep(
    "  const trackTask=(promise)=>{pendingTasks.add(promise);promise.finally(()=>pendingTasks.delete(promise));return promise;};\n",
    "  const trackTask=(promise)=>{pendingTasks.add(promise);promise.finally(()=>pendingTasks.delete(promise));return promise;};\n"
    "  if(noiseSuppressionEnabled){trackTask(createPhoneNoiseSuppressor({frameSize:160,sampleRate:8000,noiseSuppressDb:-12,probStart:42,probContinue:20}).then((processor)=>{phoneNoiseSuppressor=processor;console.log(JSON.stringify({type:'phone_noise_suppression_ready',revision:PHONE_NOISE_SUPPRESSION_REVISION}));}).catch((error)=>{phoneNoiseSuppressor=null;console.warn(JSON.stringify({type:'phone_noise_suppression_fallback',revision:PHONE_NOISE_SUPPRESSION_REVISION,error:clean(error?.message||error,240)}));}));}\n",
    'noise init',
)

old_media = """      const decoded=pcmuBase64ToSamples(message.media.payload),samples=highPassPcmFrame(decoded,hpState,8000,90),rms=rmsOfSamples(samples),threshold=startThreshold(),snr=rms/Math.max(0.001,noiseFloor);\n      if(!speechActive){\n        preRoll.push(samples);if(preRoll.length>PHONE_VAD_PREROLL_FRAMES)preRoll.shift();\n        if(assistantPlaying){const bargeThreshold=Math.max(threshold*1.25,noiseFloor*3.2,0.010);if(rms>=bargeThreshold&&snr>=1.8)bargeHits+=1;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=5){interruptPlayback();speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;bargeHits=0;}else adaptNoise(rms,false);return;}\n        if(phoneVadFrameIsSpeech(rms,noiseFloor,speechThreshold))speechHits+=1;else{speechHits=0;adaptNoise(rms,false);}if(speechHits>=PHONE_VAD_START_HITS){speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;}return;\n      }\n      speechFrames.push(samples);if(rms>=Math.max(noiseFloor*1.8,speechThreshold*0.75))silentFor=0;else silentFor+=FRAME_MS;const durationMs=speechFrames.length*FRAME_MS;if(silentFor>=silenceMs||durationMs>=maxUtteranceMs)finishUtterance();return;\n"""
new_media = """      const decoded=pcmuBase64ToSamples(message.media.payload),rawSamples=highPassPcmFrame(decoded,hpState,8000,90),rawRms=rmsOfSamples(rawSamples),threshold=startThreshold(),rawSnr=rawRms/Math.max(0.001,noiseFloor);\n      let samples=rawSamples,rms=rawRms,speexSpeech=false,cleanSpeech=false;\n      if(phoneNoiseSuppressor&&!assistantPlaying){\n        const processed=phoneNoiseSuppressor.process(rawSamples);\n        noiseFrames+=1;noiseCpuMs+=processed.elapsedMs||0;noiseCpuMaxMs=Math.max(noiseCpuMaxMs,processed.elapsedMs||0);\n        if(processed.ok&&processed.samples?.length===rawSamples.length){samples=processed.samples;rms=rmsOfSamples(samples);speexSpeech=Boolean(processed.speech);const cleanAlpha=rms>noiseCleanFloor?0.008:0.04;noiseCleanFloor=Math.max(0.0006,Math.min(0.02,noiseCleanFloor*(1-cleanAlpha)+Math.max(0.0003,rms)*cleanAlpha));cleanSpeech=phoneVadFrameIsSpeech(rms,noiseCleanFloor,Math.max(0.0028,speechThreshold*0.72));}else{noiseFallbackFrames+=1;samples=rawSamples;rms=rawRms;}\n      }\n      if(!speechActive){\n        preRoll.push(samples);if(preRoll.length>PHONE_VAD_PREROLL_FRAMES)preRoll.shift();\n        if(assistantPlaying){const bargeThreshold=Math.max(threshold*1.25,noiseFloor*3.2,0.010);if(rawRms>=bargeThreshold&&rawSnr>=1.8)bargeHits+=1;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=5){interruptPlayback();speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;bargeHits=0;}else adaptNoise(rawRms,false);return;}\n        const rawSpeech=phoneVadFrameIsSpeech(rawRms,noiseFloor,speechThreshold);\n        const speechCandidate=phoneNoiseSuppressor?(speexSpeech||cleanSpeech||(rawSpeech&&rawSnr>=3.2)):rawSpeech;\n        if(speechCandidate)speechHits+=1;else{speechHits=0;adaptNoise(rawRms,false);}if(speechHits>=PHONE_VAD_START_HITS){speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;}return;\n      }\n      speechFrames.push(samples);if(rms>=Math.max((phoneNoiseSuppressor?noiseCleanFloor:noiseFloor)*1.65,speechThreshold*0.62))silentFor=0;else silentFor+=FRAME_MS;const durationMs=speechFrames.length*FRAME_MS;if(silentFor>=silenceMs||durationMs>=maxUtteranceMs)finishUtterance();return;\n"""
rep(old_media, new_media, 'media processing block')

# Emit per-call processor diagnostics without changing response logic.
rep(
    "    if(message?.event==='stop'){finishUtterance();interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');closeSocket(telnyx,1000,'telnyx_stopped');}\n",
    "    if(message?.event==='stop'){finishUtterance();if(noiseFrames)console.log(JSON.stringify({type:'phone_noise_suppression_summary',revision:PHONE_NOISE_SUPPRESSION_REVISION,frames:noiseFrames,avgCpuMs:Number((noiseCpuMs/noiseFrames).toFixed(4)),maxCpuMs:Number(noiseCpuMaxMs.toFixed(4)),fallbackFrames:noiseFallbackFrames}));try{phoneNoiseSuppressor?.destroy?.();}catch{}interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');closeSocket(telnyx,1000,'telnyx_stopped');}\n",
    'stop diagnostics',
)

telephony.write_text(s)

Path('src/telephony/phone-noise-suppressor.js').write_text(r'''import { loadSpeexModule, SpeexPreprocessor } from '@sapphi-red/speex-preprocess-wasm';

export const PHONE_NOISE_SUPPRESSION_REVISION = 'talksys-phone-speex-v124-r1';

let modulePromise = null;

function nowMs() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

async function speexModule() {
  if (!modulePromise) modulePromise = loadSpeexModule();
  return modulePromise;
}

export async function createPhoneNoiseSuppressor({ frameSize = 160, sampleRate = 8000, noiseSuppressDb = -12, probStart = 42, probContinue = 20 } = {}) {
  const mod = await speexModule();
  const pre = new SpeexPreprocessor(mod, frameSize, sampleRate);
  pre.denoise = true;
  pre.agc = false; // Keep TalkSys' existing post-capture weak-speech normalization unchanged.
  pre.vad = true;
  pre.noiseSuppress = noiseSuppressDb;
  pre.probStart = probStart;
  pre.probContinue = probContinue;
  let destroyed = false;

  return {
    revision: PHONE_NOISE_SUPPRESSION_REVISION,
    process(frame) {
      const started = nowMs();
      if (destroyed || !(frame instanceof Int16Array) || frame.length !== frameSize) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: 'invalid-frame' };
      }
      try {
        const samples = Int16Array.from(frame);
        const speech = pre.processInt16(samples);
        return { ok: true, samples, speech, elapsedMs: nowMs() - started, fallback: '' };
      } catch (error) {
        return { ok: false, samples: frame, speech: false, elapsedMs: nowMs() - started, fallback: String(error?.message || error || 'speex-error').slice(0, 120) };
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pre.destroy();
    },
  };
}
''')

Path('tests/phone-noise-suppression-v124.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneNoiseSuppressor, PHONE_NOISE_SUPPRESSION_REVISION } from '../src/telephony/phone-noise-suppressor.js';

function frame(seed = 1, voice = 0) {
  let x = seed >>> 0;
  const out = new Int16Array(160);
  for (let i = 0; i < out.length; i += 1) {
    x = (1664525 * x + 1013904223) >>> 0;
    const noise = ((x / 0xffffffff) * 2 - 1) * 650;
    const tone = voice ? Math.sin(2 * Math.PI * 220 * i / 8000) * voice : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(noise + tone)));
  }
  return out;
}

function rms(v) { let sum = 0; for (const n of v) sum += n * n; return Math.sqrt(sum / Math.max(1, v.length)); }

test('v124 Speex phone suppressor is 8 kHz / 20 ms, fail-open, and low-latency', async () => {
  assert.equal(PHONE_NOISE_SUPPRESSION_REVISION, 'talksys-phone-speex-v124-r1');
  const ns = await createPhoneNoiseSuppressor();
  const invalid = ns.process(new Int16Array(80));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.samples.length, 80);

  // Warm state before timing.
  for (let i = 0; i < 80; i += 1) ns.process(frame(i, i > 40 ? 1200 : 0));
  let elapsed = 0;
  let max = 0;
  let noiseBefore = 0;
  let noiseAfter = 0;
  for (let i = 0; i < 1200; i += 1) {
    const input = frame(i + 1000, i % 5 === 0 ? 900 : 0);
    if (i < 200) noiseBefore += rms(input);
    const out = ns.process(input);
    assert.equal(out.ok, true);
    assert.equal(out.samples.length, 160);
    elapsed += out.elapsedMs;
    max = Math.max(max, out.elapsedMs);
    if (i < 200) noiseAfter += rms(out.samples);
  }
  const avg = elapsed / 1200;
  assert.ok(avg < 2.0, `average frame CPU ${avg.toFixed(3)} ms exceeds 2ms budget`);
  assert.ok(max < 20, `single frame CPU ${max.toFixed(3)} ms exceeds one 20ms frame`);
  assert.ok(noiseAfter < noiseBefore, 'stationary noise should be attenuated after warm-up');
  ns.destroy();
});

test('telephony source keeps answer/TTS path untouched and isolates suppression before VAD', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile('src/telephony/index.js', 'utf8'));
  assert.match(source, /createPhoneNoiseSuppressor/);
  assert.match(source, /answerWithTalkSys\(deps,stt\.text,history,controller\.signal,spokenBackchannel/);
  assert.match(source, /speak\(turn\.answer, \{ purpose: 'answer'/);
  assert.match(source, /if\(assistantPlaying\).*bargeThreshold/);
  assert.match(source, /phoneNoiseSuppressor\?\(speexSpeech\|\|cleanSpeech\|\|\(rawSpeech&&rawSnr>=3\.2\)\):rawSpeech/);
});
''')

wrangler = Path('wrangler.jsonc')
w = wrangler.read_text()
needle = '    "TELEPHONY_VAD_RMS": "0.0045",\n'
if needle not in w:
    raise SystemExit('missing wrangler VAD anchor')
w = w.replace(needle, needle + '    "TELEPHONY_NOISE_SUPPRESSION_ENABLED": "true",\n', 1)
wrangler.write_text(w)

trigger = Path('.deploy/production-trigger.txt')
trigger.write_text('phone-speex-noise-suppression-v124-20261013\n')
