import { TALK_CLIENT_V43 } from './talk-client-v43.js';

export const CLIENT_REVISION = 'talksys-v46-streaming-vad';
export const INTERACTION_REVISION = 'talksys-v52-native-gemini-3-5-flash-lite-r1';
export const AUDIO_REVISION = 'talksys-v58-noise-cancel-interrupt-r1';

const FORM_HANDLER_OLD = "form.addEventListener('submit',async e=>{e.preventDefault();const v=input.value.trim();if(!v||busy)return;input.value='';busy=true;resumePlan=null;add('user',v);try{await ask(v);}catch(err){lastError=String(err.message||err);log('会話エラー: '+lastError);setStatus('回答に失敗');}finally{busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}});";

const FORM_HANDLER_NEW = String.raw`form.addEventListener('submit',async e=>{
  e.preventDefault();const v=input.value.trim();if(!v)return;input.value='';
  if(busy||playing||speech){
    turnSeq++;resumePlan=null;activeSpeechPlan=null;ttsToken++;
    try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}
    try{fallbackSource&&fallbackSource.stop();}catch{}fallbackSource=null;
    try{if(fallbackAudio){fallbackAudio.pause();fallbackAudio.currentTime=0;}}catch{}fallbackAudio=null;
    if(speech)resetTurn();playing=false;busy=false;log('非常文字入力で現在の応答を割込み');
  }
  add('user',v);busy=true;
  const pending=ask(v),mySeq=turnSeq;
  try{await pending;}
  catch(err){if(turnSeq===mySeq){lastError=String(err.message||err);log('会話エラー: '+lastError);setStatus('回答に失敗');}}
  finally{if(turnSeq===mySeq){busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}}
});`;

const VOICE_SAFE_HELPER = String.raw`function voiceSafeText(text){
  let v=String(text||'')
    .replace(/https?:\/\/\S+/g,'')
    .replace(/(^|[。！？!?])\s*(?:結論|要点|ポイント|回答|理由|注意点|補足)\s*[:：]?\s*/g,'$1')
    .replace(/\s+(?:結論|要点|ポイント|回答|理由|注意点|補足)\s*[:：]\s*/g,'。')
    .replace(/\s+/g,' ')
    .replace(/。{2,}/g,'。')
    .trim();
  const sentences=v.match(/[^。！？!?]+[。！？!?]?/g)||[v];
  return sentences.slice(0,4).join('').trim();
}`;


const VOICE_CONTROL_HELPERS = String.raw`
function beginVoiceCandidate(){
  const id=++voiceCandidateEpoch;voiceCandidateCount++;currentVoiceCandidateId=id;return id;
}
function finishVoiceCandidate(id){
  if(!id)return;voiceCandidateCount=Math.max(0,voiceCandidateCount-1);if(currentVoiceCandidateId===id)currentVoiceCandidateId=0;
}
function abortActiveTurn(reason){
  const controller=activeTurnController;activeTurnController=null;
  if(controller){try{controller.abort(reason||'superseded');}catch{}}
}
async function waitForVoiceCandidate(seq){
  const until=Date.now()+2800;
  while(voiceCandidateCount>0&&seq===turnSeq&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,35));
  return seq===turnSeq;
}
function stopPlaybackForConfirmedVoice(){
  resumePlan=null;activeSpeechPlan=null;ttsToken++;
  try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}
  try{fallbackSource&&fallbackSource.stop();}catch{}fallbackSource=null;
  try{if(fallbackAudio){fallbackAudio.pause();fallbackAudio.currentTime=0;}}catch{}fallbackAudio=null;
  playing=false;
}
`;

const PROCESS_FRAME_V58 = String.raw`
function processFrame(a){
  frameCount++;const lv=level(a);lastRms=lv.r;lastPeak=lv.p;const frameMs=a.length/TARGET*1000;const th=vadThresholds(),startTh=th.startTh,endTh=th.endTh,now=Date.now();const snr=lv.r/Math.max(.001,noise);
  if(!speech&&!playing&&!busy&&now<calibrationUntil){pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();adaptAmbient(lv.r,true);startHits=0;diagUpdate();return;}
  if(playing){
    pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();const age=now-ttsStartedAt;
    const bargeTh=Math.max(0.015,Math.min(0.070,startTh*1.16));const peakTh=Math.max(0.032,bargeTh*1.55);
    if(age>360&&lv.r>=bargeTh&&lv.p>=peakTh&&snr>=1.65)bargeHits++;else bargeHits=Math.max(0,bargeHits-1);
    if(bargeHits>=4&&interruptSpeechForBargeIn(lv.r)){speech=true;beginVoiceCandidate();frames=pre.splice(0);duration=frames.length*frameMs;silence=0;startHits=0;speechVoicedMs=frameMs*4;speechMaxRms=lv.r;log('割込み発話開始');diagUpdate(true);}
    return;
  }
  if(!speech){
    pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();
    const peakGate=Math.max(.027,startTh*1.50);
    if(lv.r<startTh||lv.p<peakGate||snr<1.60){adaptAmbient(lv.r,false);startHits=0;diagUpdate();return;}
    startHits++;
    if(startHits<3){diagUpdate();return;}
    speech=true;beginVoiceCandidate();frames=pre.splice(0);duration=frames.length*frameMs;silence=0;speechVoicedMs=frameMs*3;speechMaxRms=lv.r;
    log((busy?'処理中の追加入力開始':'発話開始')+' RMS='+lv.r.toFixed(4)+' / noise='+noise.toFixed(4)+' / SNR='+snr.toFixed(2)+' / boost='+noiseBoost.toFixed(2));setStatus('聞いています…');diagUpdate(true);return;
  }
  frames.push(a.slice());duration+=frameMs;speechMaxRms=Math.max(speechMaxRms,lv.r);
  if(lv.r>endTh){silence=0;speechVoicedMs+=frameMs;}else silence+=frameMs;
  if(duration>=MAX_UTTERANCE_MS||silence>=SILENCE_MS)commitVoice(duration>=MAX_UTTERANCE_MS?'最大長':'無音');diagUpdate();
}
`;

const COMMIT_VOICE_V58 = String.raw`
async function commitVoice(reason){
  if(!speech)return;
  const candidateId=currentVoiceCandidateId,data=frames,ms=duration,voicedMs=speechVoicedMs,maxRms=speechMaxRms,snr=maxRms/Math.max(.001,noise),captureId=++voiceCaptureSeq;
  currentVoiceCandidateId=0;resetTurn();
  if(ms<MIN_SPEECH_MS||voicedMs<240||snr<1.55){
    finishVoiceCandidate(candidateId);falseNoiseRejects++;noiseBoost=Math.min(2.8,noiseBoost*1.12+.04);if(maxRms>0)noise=Math.max(noise,Math.min(.04,maxRms*.38));
    log('雑音候補を自動破棄 '+Math.round(ms)+'ms / voiced='+Math.round(voicedMs)+'ms / SNR='+snr.toFixed(2)+' / 感度補正='+noiseBoost.toFixed(2));
    if(resumePlan)await resumeInterruptedSpeech();diagUpdate(true);return;
  }
  utterances++;const buffer=wav(data);log('発話確定 '+reason+' / '+Math.round(ms)+'ms / '+buffer.byteLength+'B / SNR='+snr.toFixed(2));setStatus('聞き取っています…');diagUpdate(true);
  let gotText=false;
  try{
    const t=Date.now();const r=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':'audio/wav','x-talksys-session':talkSessionId},body:buffer});const j=await r.json();lastSttMs=Date.now()-t;
    if(!r.ok||!j.ok||!j.text)throw new Error(j.error||'文字起こしできませんでした');
    gotText=true;finishVoiceCandidate(candidateId);
    if(captureId<latestAcceptedVoiceSeq){log('古い音声認識結果を破棄 #'+captureId);return;}
    latestAcceptedVoiceSeq=captureId;goodSpeechCount++;noiseBoost=Math.max(1,noiseBoost*.93);lastTranscript=j.text;lastError='';
    log('STT完了 '+lastSttMs+'ms: '+j.text+' / 確定入力として前ターンを中断');
    abortActiveTurn('confirmed-voice-interrupt');turnSeq++;stopPlaybackForConfirmedVoice();busy=false;
    add('user',j.text);busy=true;const mySeq=turnSeq+1;
    try{await ask(j.text);}
    catch(err){if(turnSeq===mySeq){lastError=String(err.message||err);log('会話エラー: '+lastError);setStatus('回答に失敗');}}
    finally{if(captureId===latestAcceptedVoiceSeq){busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}}
  }catch(e){
    finishVoiceCandidate(candidateId);lastError=String(e.message||e);log('STTエラー: '+lastError);
    if(!gotText){falseNoiseRejects++;noiseBoost=Math.min(2.8,noiseBoost*1.10+.03);log('STT失敗を雑音学習へ反映 / 感度補正='+noiseBoost.toFixed(2));}
    if(!gotText&&resumePlan){lastError='';await resumeInterruptedSpeech();}else if(!activeTurnController)setStatus('聞き取りに失敗');
  }finally{diagUpdate(true);}
}
`;

const ASK_V58 = String.raw`
async function ask(text){
  abortActiveTurn('new-turn');
  const seq=++turnSeq,previous=history.slice(-MAX_HISTORY),controller=new AbortController();activeTurnController=controller;
  history.push({role:'user',content:text});setStatus('考えています…');
  try{
    const t=Date.now();
    const r=await fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({text,history:previous,searchTrace,sessionId:talkSessionId,previousInteractionId:geminiInteractionId})});
    const j=await r.json();if(seq!==turnSeq)return;
    if(j.interactionId)geminiInteractionId=j.interactionId;
    if(voiceCandidateCount>0){log('追加入力候補を認識中。旧回答の表示を保留');if(!await waitForVoiceCandidate(seq))return;}
    if(seq!==turnSeq)return;
    lastGlmMs=j?.timings?.geminiMs||j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;
    if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');
    if(j.search){lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace={resolvedQuestion:j.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]};}
    log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / Gemini '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));
    add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);
    await speak(j.answer,{resumeable:true});
  }catch(e){
    if(e?.name==='AbortError'||seq!==turnSeq){log('旧ターンを中断');return;}
    throw e;
  }finally{if(activeTurnController===controller)activeTurnController=null;}
}
`;

const START_MIC_V58 = String.raw`
async function startMic(){
  if(micOn)return;lastError='';
  try{
    const supported=navigator.mediaDevices?.getSupportedConstraints?.()||{};
    const audio={channelCount:{ideal:1}};
    if(supported.echoCancellation!==false)audio.echoCancellation=true;
    if(supported.noiseSuppression!==false)audio.noiseSuppression=true;
    if(supported.autoGainControl!==false)audio.autoGainControl=true;
    if(supported.voiceIsolation===true)audio.voiceIsolation=true;
    stream=await navigator.mediaDevices.getUserMedia({audio});
    const track=stream.getAudioTracks()[0],settings=track?.getSettings?.()||{};
    micProcessingSettings='EC='+(settings.echoCancellation??'?')+' NS='+(settings.noiseSuppression??'?')+' AGC='+(settings.autoGainControl??'?')+(settings.voiceIsolation!==undefined?' VI='+settings.voiceIsolation:'');
    const AC=window.AudioContext||window.webkitAudioContext;ctx=new AC();await ctx.resume();source=ctx.createMediaStreamSource(stream);
    inputFilter=ctx.createBiquadFilter();inputFilter.type='highpass';inputFilter.frequency.value=90;inputFilter.Q.value=.707;
    processor=ctx.createScriptProcessor(2048,1,1);silentGain=ctx.createGain();silentGain.gain.value=0;
    const convert=resampler(ctx.sampleRate);processor.onaudioprocess=e=>{const d=e.inputBuffer.getChannelData(0);for(const f of convert(d))processFrame(f);};
    source.connect(inputFilter);inputFilter.connect(processor);processor.connect(silentGain);silentGain.connect(ctx.destination);
    micOn=true;calibrationUntil=Date.now()+1400;startHits=0;noiseBoost=Math.max(1,noiseBoost*.96);mic.classList.add('on');mic.textContent='マイク会話を停止';
    setStatus(playing?'話しています…':'周囲の雑音を調整中…');log('マイク開始 '+ctx.sampleRate+'Hz → 16000Hz / '+micProcessingSettings+' / HPF 90Hz');diagUpdate(true);
  }catch(e){lastError=e.name+': '+String(e.message||e);log('マイク開始失敗: '+lastError);setStatus('マイクを開始できません');stopMic();}
}
`;

const STOP_MIC_V58 = String.raw`
function stopMic(){
  if(currentVoiceCandidateId){finishVoiceCandidate(currentVoiceCandidateId);currentVoiceCandidateId=0;}
  if(speech)resetTurn();micOn=false;
  try{processor&&processor.disconnect();}catch{}try{inputFilter&&inputFilter.disconnect();}catch{}try{source&&source.disconnect();}catch{}try{silentGain&&silentGain.disconnect();}catch{}try{stream&&stream.getTracks().forEach(t=>t.stop());}catch{}
  processor=inputFilter=source=silentGain=stream=null;if(ctx){try{ctx.close();}catch{}ctx=null;}
  mic.classList.remove('on');mic.textContent='マイク会話を開始';setStatus(playing?'話しています…':'停止中');log('マイク停止');diagUpdate(true);
}
`;

const RESUME_OLD = "async function resumeInterruptedSpeech(){const plan=resumePlan;resumePlan=null;if(!plan)return false;falseBargeResumes++;bargeCooldownUntil=Date.now()+900;log('新しい発話なし。元の読み上げを再開 '+falseBargeResumes+'回目');await speak(plan.text,{startIndex:plan.index,resumeable:true});return true;}";
const RESUME_NEW = "async function resumeInterruptedSpeech(){const plan=resumePlan;resumePlan=null;if(!plan)return false;falseBargeResumes++;bargeCooldownUntil=Date.now()+650;const nextIndex=Math.min(plan.chunks.length-1,Math.max(0,Number(plan.index)||0)+1);log('新しい発話なし。停止位置の次から読み上げ再開 '+falseBargeResumes+'回目');await speak(plan.text,{startIndex:nextIndex,resumeable:true});return true;}";

let client = TALK_CLIENT_V43
  .replaceAll('talksys-v43-smoke-weather-adaptive-vad', CLIENT_REVISION)
  .replaceAll('TalkSys v43 起動', 'TalkSys v46 起動')
  .replaceAll('u.rate=1.0;', 'u.rate=1.12;')
  .replace('SILENCE_MS=760', 'SILENCE_MS=480')
  .replace(FORM_HANDLER_OLD, FORM_HANDLER_NEW);

client = client.replace(
  "const TARGET=16000, MAX_HISTORY=14, SILENCE_MS=480, MAX_UTTERANCE_MS=16000, MIN_SPEECH_MS=320, PRE_ROLL=8;",
  "let geminiInteractionId=null;\nconst TARGET=16000, MAX_HISTORY=14, SILENCE_MS=480, MAX_UTTERANCE_MS=12000, MIN_SPEECH_MS=260, PRE_ROLL=8;",
);

client = client.replaceAll(
  "sessionId:talkSessionId};",
  "sessionId:talkSessionId,previousInteractionId:geminiInteractionId};",
);

client = client.replaceAll(
  "j=await r.json();if(seq!==turnSeq)return;",
  "j=await r.json();if(seq!==turnSeq)return;if(j.interactionId)geminiInteractionId=j.interactionId;",
);

client = client.replace(
  "const plan=await getPlan(text,previous);if(seq!==turnSeq)return;lastPlanMs=Number(plan?.plannerMs)||0;lastSearchPlan=String(plan?.searchInstruction||'');",
  "const plan={search:false,ack:'',planner:'gemini-native'};if(seq!==turnSeq)return;lastPlanMs=0;lastSearchPlan='';",
);

client = client.replace(
  "const bargeTh=Math.max(0.016,Math.min(0.075,startTh*1.22));const peakTh=Math.max(0.034,bargeTh*1.65);if(age>500&&lv.r>=bargeTh&&lv.p>=peakTh)bargeHits++;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=4&&interruptSpeechForBargeIn(lv.r))",
  "const bargeTh=Math.max(0.013,Math.min(0.065,startTh*1.08));const peakTh=Math.max(0.028,bargeTh*1.45);if(age>320&&lv.r>=bargeTh&&lv.p>=peakTh)bargeHits++;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=3&&interruptSpeechForBargeIn(lv.r))",
);

client = client.replace(
  "function speechChunks(text){const value=spokenText(text);",
  VOICE_SAFE_HELPER+"\nfunction speechChunks(text){const value=voiceSafeText(spokenText(text));",
);
client = client.replace(RESUME_OLD, RESUME_NEW);

client = client.replace(
  "let geminiInteractionId=null;\nconst TARGET=16000, MAX_HISTORY=14, SILENCE_MS=480, MAX_UTTERANCE_MS=12000, MIN_SPEECH_MS=260, PRE_ROLL=8;",
  "let geminiInteractionId=null,activeTurnController=null,voiceCandidateEpoch=0,voiceCandidateCount=0,currentVoiceCandidateId=0,voiceCaptureSeq=0,latestAcceptedVoiceSeq=0,inputFilter=null,micProcessingSettings='';\nconst TARGET=16000, MAX_HISTORY=14, SILENCE_MS=480, MAX_UTTERANCE_MS=12000, MIN_SPEECH_MS=260, PRE_ROLL=8;",
);
client = client.replace(
  "function voiceKey(v){",
  VOICE_CONTROL_HELPERS+"\nfunction voiceKey(v){",
);
client = client.replace(/function processFrame\(a\)\{[\s\S]*?\n\}\nfunction wav/, PROCESS_FRAME_V58+"\nfunction wav");
client = client.replace(/async function commitVoice\(reason\)\{[\s\S]*?\n\}\nasync function getPlan/, COMMIT_VOICE_V58+"\nasync function getPlan");
client = client.replace(/async function ask\(text\)\{[\s\S]*?\n\}\nasync function startMic/, ASK_V58+"\nasync function startMic");
client = client.replace(/async function startMic\(\)\{[\s\S]*?\n\}\nfunction stopMic/, START_MIC_V58+"\nfunction stopMic");
client = client.replace(/function stopMic\(\)\{[\s\S]*?\n\}\nmic\.addEventListener/, STOP_MIC_V58+"\nmic.addEventListener");

client = "window.__TALKSYS_AUDIO_REVISION__='" + AUDIO_REVISION + "';\n" + client;
client = "window.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "';\nwindow.__TALKSYS_INTERACTION_REVISION__='" + INTERACTION_REVISION + "';\n" + client;

if (!client.includes("window.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "'") || !client.includes("window.__TALKSYS_INTERACTION_REVISION__='" + INTERACTION_REVISION + "'")) throw new Error('TalkSys runtime revision markers did not apply');
if (!client.includes('非常文字入力で現在の応答を割込み')) throw new Error('TalkSys typed-interrupt patch did not apply');
if (!client.includes('previousInteractionId:geminiInteractionId')) throw new Error('Gemini interaction continuity patch did not apply');
if (!client.includes("planner:'gemini-native'")) throw new Error('Gemini native planner bypass patch did not apply');
if (!client.includes('bargeHits>=4') || !client.includes('age>360')) throw new Error('TalkSys debounced barge-in patch did not apply');
if (!client.includes('SILENCE_MS=480')) throw new Error('TalkSys faster voice-end patch did not apply');
if (!client.includes('voiceSafeText(spokenText(text))') || !client.includes('sentences.slice(0,4)')) throw new Error('TalkSys spoken-text compaction patch did not apply');
if (!client.includes('停止位置の次から読み上げ再開')) throw new Error('TalkSys false-barge resume patch did not apply');
if (!client.includes('confirmed-voice-interrupt') || !client.includes('activeTurnController')) throw new Error('TalkSys confirmed voice cancellation patch did not apply');
if (!client.includes('voiceCandidateCount>0') || !client.includes('旧回答の表示を保留')) throw new Error('TalkSys in-flight voice hold patch did not apply');
if (!client.includes("inputFilter.type='highpass'") || !client.includes('noiseSuppression=true')) throw new Error('TalkSys microphone DSP patch did not apply');
if (client.includes('if(busy&&!speech){startHits=0;bargeHits=0')) throw new Error('TalkSys still blocks microphone during processing');

export const TALK_CLIENT_V45 = client;
export const __test = {
  revision: CLIENT_REVISION,
  interactionRevision: INTERACTION_REVISION,
  audioRevision: AUDIO_REVISION,
  httpTranscribe: client.includes('/api/transcribe'),
  httpTurns: client.includes('/api/turn'),
  adaptiveNoise: client.includes('noiseBoost'),
  ambientCalibration: client.includes('calibrationUntil'),
  browserNoiseSuppression: client.includes('noiseSuppression=true') && client.includes("inputFilter.type='highpass'"),
  confirmedVoiceCancellation: client.includes('confirmed-voice-interrupt') && client.includes('activeTurnController'),
  listenWhileProcessing: !client.includes('if(busy&&!speech){startHits=0;bargeHits=0') && client.includes('処理中の追加入力開始'),
  holdOldAnswerUntilStt: client.includes('voiceCandidateCount>0') && client.includes('旧回答の表示を保留'),
  typedInterrupt: client.includes('非常文字入力で現在の応答を割込み') && !client.includes('if(!v||busy)return'),
  fasterTts: client.includes('u.rate=1.12'),
  fasterTurnEnd: client.includes('SILENCE_MS=480'),
  relaxedBargeIn: client.includes('bargeHits>=4') && client.includes('age>360'),
  resumeAfterInterruptedChunk: client.includes('停止位置の次から読み上げ再開'),
  spokenAnswerCompaction: client.includes('voiceSafeText(spokenText(text))') && client.includes('sentences.slice(0,4)'),
  nativeGeminiInteractions: client.includes('previousInteractionId:geminiInteractionId') && client.includes("planner:'gemini-native'"),
  legacyWebSocket: client.includes('new WebSocket') || client.includes('/agents/'),
};