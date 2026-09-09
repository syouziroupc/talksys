import { TALK_CLIENT_V42 } from './talk-client-v42.js';

const REVISION='talksys-v43-smoke-weather-adaptive-vad';

const PROCESS_FRAME_PATCH=String.raw`
function vadThresholds(){
  const startTh=Math.max(0.012,Math.min(0.095,noise*3.2*noiseBoost));
  const endTh=Math.max(0.007,Math.min(startTh*.70,noise*2.0*Math.sqrt(noiseBoost)));
  return {startTh,endTh};
}
function adaptAmbient(rms,fast=false){
  const value=Math.max(.001,Math.min(.04,Number(rms)||0));
  const alpha=fast?.08:(value>noise?.012:.035);
  noise=Math.max(.0015,Math.min(.04,noise*(1-alpha)+value*alpha));
}
function processFrame(a){
  frameCount++;const lv=level(a);lastRms=lv.r;lastPeak=lv.p;const frameMs=a.length/TARGET*1000;const th=vadThresholds(),startTh=th.startTh,endTh=th.endTh,now=Date.now();
  if(!speech&&!playing&&!busy&&now<calibrationUntil){pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();adaptAmbient(lv.r,true);startHits=0;diagUpdate();return;}
  if(playing){pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();const age=now-ttsStartedAt;const bargeTh=Math.max(0.016,Math.min(0.075,startTh*1.22));const peakTh=Math.max(0.034,bargeTh*1.65);if(age>500&&lv.r>=bargeTh&&lv.p>=peakTh)bargeHits++;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=4&&interruptSpeechForBargeIn(lv.r)){speech=true;frames=pre.splice(0);duration=frames.length*frameMs;silence=0;startHits=0;speechVoicedMs=frameMs*4;speechMaxRms=lv.r;log('割込み発話開始');diagUpdate(true);}return;}
  if(busy&&!speech){startHits=0;bargeHits=0;diagUpdate();return;}
  if(!speech){
    pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();
    const peakGate=Math.max(.026,startTh*1.45);
    if(lv.r<startTh||lv.p<peakGate){adaptAmbient(lv.r,false);startHits=Math.max(0,startHits-1);diagUpdate();return;}
    startHits++;if(startHits<3){diagUpdate();return;}
    speech=true;frames=pre.splice(0);duration=frames.length*frameMs;silence=0;speechVoicedMs=frameMs*3;speechMaxRms=lv.r;log('発話開始 RMS='+lv.r.toFixed(4)+' / noise='+noise.toFixed(4)+' / boost='+noiseBoost.toFixed(2));setStatus('聞いています…');diagUpdate(true);return;
  }
  frames.push(a.slice());duration+=frameMs;speechMaxRms=Math.max(speechMaxRms,lv.r);
  if(lv.r>endTh){silence=0;speechVoicedMs+=frameMs;}else silence+=frameMs;
  if(duration>=MAX_UTTERANCE_MS||silence>=SILENCE_MS)commitVoice(duration>=MAX_UTTERANCE_MS?'最大長':'無音');diagUpdate();
}`;

const COMMIT_PATCH=String.raw`
async function commitVoice(reason){
  if(!speech)return;
  const data=frames,ms=duration,voicedMs=speechVoicedMs,maxRms=speechMaxRms,snr=maxRms/Math.max(.001,noise);resetTurn();
  if(ms<MIN_SPEECH_MS||voicedMs<240||snr<1.55){falseNoiseRejects++;noiseBoost=Math.min(2.6,noiseBoost*1.12+.04);if(maxRms>0)noise=Math.max(noise,Math.min(.04,maxRms*.38));log('雑音候補を自動破棄 '+Math.round(ms)+'ms / voiced='+Math.round(voicedMs)+'ms / SNR='+snr.toFixed(2)+' / 感度補正='+noiseBoost.toFixed(2));if(resumePlan)await resumeInterruptedSpeech();diagUpdate(true);return;}
  utterances++;const buffer=wav(data);log('発話確定 '+reason+' / '+Math.round(ms)+'ms / '+buffer.byteLength+'B / SNR='+snr.toFixed(2));busy=true;setStatus('聞き取っています…');diagUpdate(true);
  let gotText=false;
  try{const t=Date.now();const r=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':'audio/wav','x-talksys-session':talkSessionId},body:buffer});const j=await r.json();lastSttMs=Date.now()-t;if(!r.ok||!j.ok||!j.text)throw new Error(j.error||'文字起こしできませんでした');gotText=true;resumePlan=null;goodSpeechCount++;noiseBoost=Math.max(1,noiseBoost*.93);lastTranscript=j.text;lastError='';log('STT完了 '+lastSttMs+'ms: '+j.text+' / 感度補正='+noiseBoost.toFixed(2));add('user',j.text);await ask(j.text);}
  catch(e){lastError=String(e.message||e);log('STTエラー: '+lastError);if(!gotText){falseNoiseRejects++;noiseBoost=Math.min(2.6,noiseBoost*1.10+.03);log('STT失敗を雑音学習へ反映 / 感度補正='+noiseBoost.toFixed(2));}if(!gotText&&resumePlan){lastError='';await resumeInterruptedSpeech();}else setStatus('聞き取りに失敗');}
  finally{busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}
}`;

let client=TALK_CLIENT_V42
  .replaceAll('talksys-v42-search-judgment-persistent-logs',REVISION)
  .replaceAll('TalkSys v42 起動','TalkSys v43 起動');

client=client.replace(
  "const TARGET=16000, MAX_HISTORY=14, SILENCE_MS=680, MAX_UTTERANCE_MS=16000, MIN_SPEECH_MS=180, PRE_ROLL=7;",
  "const TARGET=16000, MAX_HISTORY=14, SILENCE_MS=760, MAX_UTTERANCE_MS=16000, MIN_SPEECH_MS=320, PRE_ROLL=8;",
);
client=client.replace(
  "let noise=0.0035, speech=false, startHits=0, silence=0, duration=0, pre=[], frames=[], frameCount=0, lastRms=0, lastPeak=0, utterances=0;",
  "let noise=0.0035, noiseBoost=1, calibrationUntil=0, falseNoiseRejects=0, goodSpeechCount=0, speechVoicedMs=0, speechMaxRms=0, speech=false, startHits=0, silence=0, duration=0, pre=[], frames=[], frameCount=0, lastRms=0, lastPeak=0, utterances=0;",
);
client=client.replace(
  "const startTh=Math.max(0.008,Math.min(0.07,noise*2.7));const endTh=Math.max(0.0055,Math.min(startTh*.72,noise*1.75));",
  "const startTh=Math.max(0.012,Math.min(0.095,noise*3.2*noiseBoost));const endTh=Math.max(0.007,Math.min(startTh*.70,noise*2.0*Math.sqrt(noiseBoost)));",
);
client=client.replace(
  "noiseFloor:noise.toFixed(5),startThreshold:startTh.toFixed(5),endThreshold:endTh.toFixed(5),speechActive:speech",
  "noiseFloor:noise.toFixed(5),noiseBoost:noiseBoost.toFixed(2),falseNoiseRejects,goodSpeechCount,calibrating:Date.now()<calibrationUntil,startThreshold:startTh.toFixed(5),endThreshold:endTh.toFixed(5),speechActive:speech",
);
client=client.replace(
  "function resetTurn(){speech=false;startHits=0;silence=0;duration=0;frames=[];pre=[];}",
  "function resetTurn(){speech=false;startHits=0;silence=0;duration=0;speechVoicedMs=0;speechMaxRms=0;frames=[];pre=[];}",
);
client=client.replace(/function processFrame\(a\)\{[\s\S]*?\n\}\nfunction wav/,PROCESS_FRAME_PATCH+'\nfunction wav');
client=client.replace(/async function commitVoice\(reason\)\{[\s\S]*?\n\}\nasync function getPlan/,COMMIT_PATCH+'\nasync function getPlan');
client=client.replace(
  "micOn=true;mic.classList.add('on');mic.textContent='マイク会話を停止';setStatus(playing?'話しています…':'聞いています');log('マイク開始 '+ctx.sampleRate+'Hz → 16000Hz');diagUpdate(true);",
  "micOn=true;calibrationUntil=Date.now()+1400;startHits=0;noiseBoost=Math.max(1,noiseBoost*.96);mic.classList.add('on');mic.textContent='マイク会話を停止';setStatus(playing?'話しています…':'周囲の雑音を調整中…');log('マイク開始 '+ctx.sampleRate+'Hz → 16000Hz / 1.4秒環境音キャリブレーション');diagUpdate(true);",
);

export const TALK_CLIENT_V43=client;
export const __test={revision:REVISION,hasAdaptiveNoise:client.includes('noiseBoost'),hasCalibration:client.includes('calibrationUntil'),hasFalseNoiseReject:client.includes('雑音候補を自動破棄'),hasThreeFrameGate:client.includes('startHits<3'),hasSttNoiseLearning:client.includes('STT失敗を雑音学習へ反映')};
