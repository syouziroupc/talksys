import { TALK_CLIENT_V35 } from './talk-client-v35.js';

const stableVoice = String.raw`function voiceKey(v){return String(v?.voiceURI||v?.name||'')+'|'+String(v?.lang||'');}
function voiceScore(v){
  const name=String(v?.name||''),lang=String(v?.lang||'');let score=0;
  if(/^ja-JP$/i.test(lang))score+=120;else if(/^ja(?:-|$)/i.test(lang))score+=90;
  if(/Google.*(?:日本語|Japanese)/i.test(name))score+=1000;
  else if(/Google/i.test(name))score+=900;
  else if(/Nanami/i.test(name))score+=820;
  else if(/Haruka|Sayaka|Ichiro|Keita/i.test(name))score+=760;
  else if(/Ayumi/i.test(name))score+=420;
  else if(/Microsoft/i.test(name))score+=650;
  if(v?.localService)score+=12;
  return score;
}
async function voiceInventory(){
  if(!('speechSynthesis' in window)||!('SpeechSynthesisUtterance' in window))throw new Error('このブラウザは端末TTSに対応していません');
  let voices=window.speechSynthesis.getVoices();
  await Promise.race([
    new Promise(resolve=>window.speechSynthesis.addEventListener('voiceschanged',resolve,{once:true})),
    new Promise(resolve=>setTimeout(resolve,650))
  ]);
  await new Promise(resolve=>setTimeout(resolve,120));
  const later=window.speechSynthesis.getVoices();if(later.length)voices=later;
  return voices;
}
async function selectJapaneseVoice(){
  const now=window.speechSynthesis.getVoices();
  if(lockedVoiceKey){const same=now.find(v=>voiceKey(v)===lockedVoiceKey);if(same)return same;}
  if(voiceSelectionPromise)return voiceSelectionPromise;
  voiceSelectionPromise=(async()=>{
    const voices=await voiceInventory();const ja=voices.filter(v=>/^ja(?:-|$)/i.test(String(v.lang||'')));
    if(!ja.length)throw new Error('日本語TTS音声（ja-JP）が端末にありません');
    ja.sort((a,b)=>voiceScore(b)-voiceScore(a)||String(a.name||'').localeCompare(String(b.name||''),'ja'));
    const chosen=ja[0];lockedVoiceKey=voiceKey(chosen);lastVoiceName=(chosen.name||'日本語音声')+' / '+(chosen.lang||'ja-JP');
    log('日本語音声を固定 '+lastVoiceName);diagUpdate(true);return chosen;
  })();
  try{return await voiceSelectionPromise;}finally{voiceSelectionPromise=null;}
}
function spokenText`;

const bargeProcess = String.raw`function interruptSpeechForBargeIn(rms){
  if(!playing)return false;
  bargeIns++;bargeHits=0;ttsToken++;try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}playing=false;
  log('音声割込み '+bargeIns+'回目 RMS='+Number(rms||0).toFixed(4));setStatus('聞いています…');diagUpdate(true);return true;
}
function processFrame(a){
  frameCount++;const lv=level(a);lastRms=lv.r;lastPeak=lv.p;const frameMs=a.length/TARGET*1000;
  const startTh=Math.max(0.008,Math.min(0.07,noise*2.7));const endTh=Math.max(0.0055,Math.min(startTh*.72,noise*1.75));
  if(playing){
    pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();
    const age=Date.now()-ttsStartedAt;const bargeTh=Math.max(0.011,Math.min(0.055,startTh*1.15));const peakTh=Math.max(0.025,bargeTh*1.7);
    if(age>420&&lv.r>=bargeTh&&lv.p>=peakTh)bargeHits++;else bargeHits=Math.max(0,bargeHits-1);
    if(bargeHits>=3&&interruptSpeechForBargeIn(lv.r)){
      speech=true;frames=pre.splice(0);duration=frames.length*frameMs;silence=0;startHits=0;log('割込み発話開始');diagUpdate(true);
    }
    return;
  }
  if(busy&&!speech){startHits=0;bargeHits=0;diagUpdate();return;}
  if(!speech){
    pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();
    if(lv.r<startTh){noise=Math.max(.001,Math.min(.025,noise*.985+lv.r*.015));startHits=0;diagUpdate();return;}
    startHits++;if(startHits<2){diagUpdate();return;}
    speech=true;frames=pre.splice(0);duration=frames.length*frameMs;silence=0;log('発話開始 RMS='+lv.r.toFixed(4));setStatus('聞いています…');diagUpdate(true);return;
  }
  frames.push(a.slice());duration+=frameMs;if(lv.r>endTh)silence=0;else silence+=frameMs;
  if(duration>=MAX_UTTERANCE_MS||silence>=SILENCE_MS)commitVoice(duration>=MAX_UTTERANCE_MS?'最大長':'無音');
  diagUpdate();
}
function wav`;

const stableSpeak = String.raw`async function speak(text){
  setStatus('話しています…');playing=true;lastError='';const token=++ttsToken;ttsStartedAt=Date.now();bargeHits=0;
  const t=Date.now();
  try{
    const voice=await selectJapaneseVoice();lastVoiceName=(voice.name||'日本語音声')+' / '+(voice.lang||'ja-JP');diagUpdate(true);
    const utterance=new SpeechSynthesisUtterance(spokenText(text));utterance.voice=voice;utterance.lang=voice.lang||'ja-JP';utterance.rate=1.0;utterance.pitch=1;utterance.volume=1;
    window.speechSynthesis.cancel();
    await new Promise((resolve,reject)=>{
      utterance.onend=resolve;
      utterance.onerror=e=>{if(token!==ttsToken||/canceled|cancelled|interrupted/i.test(String(e?.error||'')))resolve();else reject(new Error('端末TTS再生エラー: '+(e?.error||'unknown')));};
      window.speechSynthesis.speak(utterance);
    });
    lastTtsMs=Date.now()-t;if(token===ttsToken)log('端末日本語TTS完了 '+lastTtsMs+'ms / voice='+lastVoiceName);else log('端末日本語TTSは割込みで停止');
  }catch(e){lastTtsMs=Date.now()-t;if(token===ttsToken){lastError=String(e.message||e);log('TTSエラー: '+lastError);}}
  finally{
    if(token===ttsToken){playing=false;if(micOn)setStatus('聞いています');else setStatus('停止中');}
    diagUpdate(true);
  }
}
async function startMic(){`;

export const TALK_CLIENT_V36 = TALK_CLIENT_V35
  .replaceAll('talksys-v35-system-ja-quality','talksys-v36-search-voice-barge')
  .replace("let lastTranscript='', lastSttMs=0, lastGlmMs=0, lastSearchMs=0, lastTtsMs=0, lastError='', lastDiagAt=0, lastVoiceName='未選択';", "let lastTranscript='', lastSttMs=0, lastGlmMs=0, lastSearchMs=0, lastTtsMs=0, lastError='', lastDiagAt=0, lastVoiceName='未選択', bargeHits=0, bargeIns=0, lockedVoiceKey='', voiceSelectionPromise=null, ttsToken=0, ttsStartedAt=0;")
  .replace("tts:'端末日本語 / '+lastVoiceName,error:lastError||'-'", "tts:'端末日本語 / '+lastVoiceName,bargeIns,error:lastError||'-'")
  .replace(/async function selectJapaneseVoice\(\)\{[\s\S]*?\n\}\nfunction spokenText/, stableVoice)
  .replace(/function processFrame\(a\)\{[\s\S]*?\n\}\nfunction wav/, bargeProcess)
  .replace(/async function speak\(text\)\{[\s\S]*?\n\}\nasync function startMic\(\)\{/, stableSpeak)
  .replaceAll('TalkSys v35 起動','TalkSys v36 起動');
