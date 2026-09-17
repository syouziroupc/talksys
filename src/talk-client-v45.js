import { TALK_CLIENT_V43 } from './talk-client-v43.js';

export const CLIENT_REVISION = 'talksys-v45-http-adaptive-vad';
export const INTERACTION_REVISION = 'talksys-v48-typed-interrupt-fast-voice-r1';

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

let client = TALK_CLIENT_V43
  .replaceAll('talksys-v43-smoke-weather-adaptive-vad', CLIENT_REVISION)
  .replaceAll('TalkSys v43 起動', 'TalkSys v45 起動')
  .replaceAll('u.rate=1.0;', 'u.rate=1.12;')
  .replace('SILENCE_MS=760', 'SILENCE_MS=620')
  .replace(FORM_HANDLER_OLD, FORM_HANDLER_NEW);

client = client.replace(
  "'use strict';",
  "'use strict';\nwindow.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "';\nwindow.__TALKSYS_INTERACTION_REVISION__='" + INTERACTION_REVISION + "';",
);

if (!client.includes('非常文字入力で現在の応答を割込み')) {
  throw new Error('TalkSys typed-interrupt patch did not apply');
}

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
  fasterTurnEnd: client.includes('SILENCE_MS=620'),
  legacyWebSocket: client.includes('new WebSocket') || client.includes('/agents/'),
};
