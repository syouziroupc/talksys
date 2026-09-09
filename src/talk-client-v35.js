import { TALK_CLIENT_V34 } from './talk-client-v34.js';

const browserSpeech = String.raw`async function selectJapaneseVoice(){
  if(!('speechSynthesis' in window)||!('SpeechSynthesisUtterance' in window))throw new Error('このブラウザは端末TTSに対応していません');
  let voices=window.speechSynthesis.getVoices();
  if(!voices.length){
    await Promise.race([
      new Promise(resolve=>window.speechSynthesis.addEventListener('voiceschanged',resolve,{once:true})),
      new Promise(resolve=>setTimeout(resolve,900))
    ]);
    voices=window.speechSynthesis.getVoices();
  }
  const ja=voices.filter(v=>/^ja(?:-|$)/i.test(String(v.lang||'')));
  if(!ja.length)throw new Error('日本語TTS音声（ja-JP）が端末にありません');
  return ja.find(v=>/Nanami|Haruka|Ayumi|Ichiro|Japanese|日本語/i.test(v.name||''))||ja.find(v=>v.localService)||ja[0];
}
function spokenText(text){
  return String(text||'').replace(/https?:\/\/\S+/g,'リンク').replace(/[*_#>\x60~]/g,'').replace(/\bWindows\s*10\b/gi,'ウィンドウズ テン').replace(/\bWindows\s*11\b/gi,'ウィンドウズ イレブン').replace(/\bPC\b/gi,'パソコン').replace(/\bSSD\b/gi,'エスエスディー').replace(/\bHDD\b/gi,'エイチディーディー').replace(/\bCPU\b/gi,'シーピーユー').replace(/\bGPU\b/gi,'ジーピーユー').replace(/\bRAM\b/gi,'メモリー').replace(/\bUSB\b/gi,'ユーエスビー').replace(/\bHDMI\b/gi,'エイチディーエムアイ').replace(/\bWi[-‐‑–—]?Fi\b/gi,'ワイファイ').replace(/\s+/g,' ').trim();
}
async function speak(text){
  setStatus('話しています…');playing=true;lastError='';
  const t=Date.now();
  try{
    const voice=await selectJapaneseVoice();lastVoiceName=(voice.name||'日本語音声')+' / '+(voice.lang||'ja-JP');diagUpdate(true);
    const utterance=new SpeechSynthesisUtterance(spokenText(text));utterance.voice=voice;utterance.lang=voice.lang||'ja-JP';utterance.rate=1.03;utterance.pitch=1;utterance.volume=1;
    window.speechSynthesis.cancel();
    await new Promise((resolve,reject)=>{utterance.onend=resolve;utterance.onerror=e=>reject(new Error('端末TTS再生エラー: '+(e.error||'unknown')));window.speechSynthesis.speak(utterance);});
    lastTtsMs=Date.now()-t;log('端末日本語TTS完了 '+lastTtsMs+'ms / voice='+lastVoiceName);
  }catch(e){lastTtsMs=Date.now()-t;lastError=String(e.message||e);log('TTSエラー: '+lastError);}
  finally{playing=false;if(micOn)setStatus('聞いています');else setStatus('停止中');diagUpdate(true);}
}
async function startMic(){`;

export const TALK_CLIENT_V35 = TALK_CLIENT_V34
  .replaceAll('talksys-v34-grok-ja-natural','talksys-v35-system-ja-quality')
  .replace("let lastTranscript='', lastSttMs=0, lastGlmMs=0, lastSearchMs=0, lastTtsMs=0, lastError='', lastDiagAt=0;", "let lastTranscript='', lastSttMs=0, lastGlmMs=0, lastSearchMs=0, lastTtsMs=0, lastError='', lastDiagAt=0, lastVoiceName='未選択';")
  .replace("tts:'Grok TTS / ja'", "tts:'端末日本語 / '+lastVoiceName")
  .replace(/async function speak\(text\)\{[\s\S]*?\n\}\nasync function startMic\(\)\{/, browserSpeech)
  .replace("window.addEventListener('beforeunload',()=>{if(micOn)stopMic();});", "window.addEventListener('beforeunload',()=>{try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}if(micOn)stopMic();});")
  .replaceAll('TalkSys v34 起動','TalkSys v35 起動');
