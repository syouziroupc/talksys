import { TALK_CLIENT_V43 } from './talk-client-v43.js';

export const CLIENT_REVISION = 'talksys-v46-streaming-vad';
export const INTERACTION_REVISION = 'talksys-v52-native-gemini-3-5-flash-lite-r1';

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

client = "window.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "';\nwindow.__TALKSYS_INTERACTION_REVISION__='" + INTERACTION_REVISION + "';\n" + client;

if (!client.includes("window.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "'") || !client.includes("window.__TALKSYS_INTERACTION_REVISION__='" + INTERACTION_REVISION + "'")) throw new Error('TalkSys runtime revision markers did not apply');
if (!client.includes('非常文字入力で現在の応答を割込み')) throw new Error('TalkSys typed-interrupt patch did not apply');
if (!client.includes('previousInteractionId:geminiInteractionId')) throw new Error('Gemini interaction continuity patch did not apply');
if (!client.includes("planner:'gemini-native'")) throw new Error('Gemini native planner bypass patch did not apply');
if (!client.includes('bargeHits>=3')) throw new Error('TalkSys relaxed barge-in patch did not apply');
if (!client.includes('SILENCE_MS=480')) throw new Error('TalkSys faster voice-end patch did not apply');
if (!client.includes('voiceSafeText(spokenText(text))') || !client.includes('sentences.slice(0,4)')) throw new Error('TalkSys spoken-text compaction patch did not apply');
if (!client.includes('停止位置の次から読み上げ再開')) throw new Error('TalkSys false-barge resume patch did not apply');

export const TALK_CLIENT_V45 = client;
export const __test = {
  revision: CLIENT_REVISION,
  interactionRevision: INTERACTION_REVISION,
  httpTranscribe: client.includes('/api/transcribe'),
  httpTurns: client.includes('/api/turn'),
  adaptiveNoise: client.includes('noiseBoost'),
  ambientCalibration: client.includes('calibrationUntil'),
  typedInterrupt: client.includes('非常文字入力で現在の応答を割込み') && !client.includes('if(!v||busy)return'),
  fasterTts: client.includes('u.rate=1.12'),
  fasterTurnEnd: client.includes('SILENCE_MS=480'),
  relaxedBargeIn: client.includes('bargeHits>=3') && client.includes('age>320'),
  resumeAfterInterruptedChunk: client.includes('停止位置の次から読み上げ再開'),
  spokenAnswerCompaction: client.includes('voiceSafeText(spokenText(text))') && client.includes('sentences.slice(0,4)'),
  nativeGeminiInteractions: client.includes('previousInteractionId:geminiInteractionId') && client.includes("planner:'gemini-native'"),
  legacyWebSocket: client.includes('new WebSocket') || client.includes('/agents/'),
};