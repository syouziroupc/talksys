import { TALK_CLIENT_V38 } from './talk-client-v38.js';

const REVISION='talksys-v40-japanese-native-fallback';

const HELPERS=String.raw`
function clientEnglishOnly(text){
  const v=String(text||'').trim();if(!v||/[ぁ-んァ-ヶ一-龠々]/u.test(v))return false;
  const low=v.toLowerCase();
  if(/^(?:windows(?:\s*\d+)?|wi[- ]?fi|pc|ssd|hdd|cpu|gpu|ram|usb|hdmi|core\s*i\d|ryzen(?:\s*\d+)?|cf[-a-z0-9]+|\d+\s*(?:gb|tb|mb|mhz|ghz))(?:[\s\d./+_-]+(?:windows|wi[- ]?fi|pc|ssd|hdd|cpu|gpu|ram|usb|hdmi|gb|tb|mb|mhz|ghz|\d+))*$/i.test(v))return false;
  if(/^(?:hello|hi|hey|thanks|thank you|good morning|good evening)[.!?\s]*$/i.test(v))return true;
  if(/\b(?:i|you|we|they|he|she|it|what|where|when|why|how|is|are|am|do|does|did|can|could|would|should|want|need|ask|tell|please|the|a|an|in|on|at|to|from|for|with)\b/i.test(low))return true;
  const words=(v.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)||[]);return words.length>=4;
}
async function selectJapaneseVoiceOrAuto(){
  if(lockedVoiceKey){const same=window.speechSynthesis.getVoices().find(v=>voiceKey(v)===lockedVoiceKey);if(same){lastVoiceCount=window.speechSynthesis.getVoices().length;lastJaVoiceCount=1;ttsStrategy='explicit-ja';return same;}}
  const voices=await voiceInventory();lastVoiceCount=voices.length;const ja=voices.filter(v=>/^ja(?:-|$)/i.test(String(v.lang||'')));lastJaVoiceCount=ja.length;
  if(ja.length){ja.sort((a,b)=>voiceScore(b)-voiceScore(a)||String(a.name||'').localeCompare(String(b.name||''),'ja'));const chosen=ja[0];lockedVoiceKey=voiceKey(chosen);lastVoiceName=(chosen.name||'日本語音声')+' / '+(chosen.lang||'ja-JP');ttsStrategy='explicit-ja';log('日本語音声を固定 '+lastVoiceName);diagUpdate(true);return chosen;}
  lockedVoiceKey='';lastVoiceName='端末自動選択 / ja-JP';ttsStrategy='auto-lang-ja-JP';log('列挙済み日本語音声なし → lang=ja-JPで端末の自動選択を使用');diagUpdate(true);return null;
}
async function playJapaneseDeviceChunk(chunk,voice,token){
  const u=new SpeechSynthesisUtterance(chunk);if(voice)u.voice=voice;u.lang='ja-JP';u.rate=1.0;u.pitch=1;u.volume=1;
  await new Promise((resolve,reject)=>{u.onend=resolve;u.onerror=e=>{const code=String(e?.error||'unknown');if(token!==ttsToken||/canceled|cancelled|interrupted/i.test(code))resolve();else reject(new Error('端末日本語TTS再生エラー: '+code));};window.speechSynthesis.speak(u);});
}
`;

const SPEAK_PATCH=String.raw`
async function speak(text,options={}){
  const chunks=speechChunks(text);if(!chunks.length)return;const startIndex=Math.max(0,Math.min(chunks.length-1,Number(options.startIndex)||0));const token=++ttsToken;ttsStartedAt=Date.now();bargeHits=0;playing=true;lastError='';setStatus(options.searchAnnouncement?'検索しています…':'話しています…');const t=Date.now();
  try{
    const voice=await selectJapaneseVoiceOrAuto();
    for(let i=startIndex;i<chunks.length;i++){
      if(token!==ttsToken)break;activeSpeechPlan={text,chunks,index:i,resumeable:options.resumeable!==false};await playJapaneseDeviceChunk(chunks[i],voice,token);
    }
    lastTtsMs=Date.now()-t;if(token===ttsToken)log('端末日本語TTS完了 '+lastTtsMs+'ms / strategy='+ttsStrategy+' / voice='+lastVoiceName);else log('TTSは割込みで停止');
  }catch(e){lastTtsMs=Date.now()-t;if(token===ttsToken){lastError=String(e.message||e);ttsStrategy='unavailable';log('TTSエラー: '+lastError);}}
  finally{if(token===ttsToken){playing=false;activeSpeechPlan=null;if(micOn)setStatus('聞いています');else setStatus('停止中');}diagUpdate(true);}
}`;

const ASK_PATCH=String.raw`
async function ask(text){
  const seq=++turnSeq;
  if(clientEnglishOnly(text)){
    const answer='日本語でお話しください。';lastPlanMs=0;lastSearchPlan='';add('assistant',answer);log('英語発話を日本語専用モードで遮断（履歴へ保存しません）');await speak(answer,{resumeable:false});return;
  }
  const previous=history.slice(-MAX_HISTORY);history.push({role:'user',content:text});setStatus('考えています…');
  const plan=await getPlan(text,previous);if(seq!==turnSeq)return;lastPlanMs=Number(plan?.plannerMs)||0;lastSearchPlan=String(plan?.searchInstruction||'');
  const payload={text,history:previous,searchTrace,searchPlan:plan||null};const ack=String(plan?.ack||'').trim();
  if(plan?.search){
    lastSearchTopic=plan.topic||plan.resolvedQuestion||'必要な情報';const searching=(ack?ack+' ':'')+'条件に合う情報を調べます。';add('assistant',searching);log('検索計画 ['+(plan.planner||'?')+'] '+lastSearchTopic+(lastSearchPlan?' / '+lastSearchPlan:''));
    const turnPromise=fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});await speak(searching,{searchAnnouncement:true,resumeable:false});if(seq!==turnSeq)return;
    const t=Date.now(),r=await turnPromise,j=await r.json();if(seq!==turnSeq)return;lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace=j.search?{resolvedQuestion:j.resolvedQuestion||plan.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]}:searchTrace;log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / planner='+(j.planner||plan.planner||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));if(j.search&&j.queries?.length)log('検索語: '+j.queries.join(' | '));add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer,{resumeable:true});return;
  }
  const turnPromise=fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});if(ack){add('assistant',ack);log('相槌: '+ack);await speak(ack,{resumeable:false});if(seq!==turnSeq)return;}
  const t=Date.now(),r=await turnPromise,j=await r.json();if(seq!==turnSeq)return;lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');if(j.search){lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace={resolvedQuestion:j.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]};}log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer,{resumeable:true});
}`;

let client=TALK_CLIENT_V38.replaceAll('talksys-v38-history-search-tts-fallback',REVISION).replaceAll('TalkSys v38 起動','TalkSys v40 起動');
client=client.replace("let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0, fallbackAudio=null, fallbackSource=null, lastPlanMs=0, lastSearchPlan='';","let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0, fallbackAudio=null, fallbackSource=null, lastPlanMs=0, lastSearchPlan='', lastVoiceCount=0, lastJaVoiceCount=0, ttsStrategy='未判定';");
client=client.replace("function spokenText(text){",HELPERS+'\nfunction spokenText(text){');
client=client.replace(/async function speak\(text,options=\{\}\)\{[\s\S]*?\n\}\nfunction interruptSpeechForBargeIn/,SPEAK_PATCH+'\nfunction interruptSpeechForBargeIn');
client=client.replace(/async function ask\(text\)\{[\s\S]*?\n\}\nasync function startMic/,ASK_PATCH+'\nasync function startMic');
client=client.replace("tts:'自動（端末→Cloudflare） / '+lastVoiceName,planMs:lastPlanMs,bargeIns,falseBargeResumes,lastSearchTopic,lastSearchPlan,lastSearchQueries:lastSearchQueries.join(' | '),error:lastError||'-'","tts:'日本語専用 / '+lastVoiceName,ttsStrategy,voiceCount:lastVoiceCount,jaVoiceCount:lastJaVoiceCount,planMs:lastPlanMs,bargeIns,falseBargeResumes,lastSearchTopic,lastSearchPlan,lastSearchQueries:lastSearchQueries.join(' | '),error:lastError||'-'");

export const TALK_CLIENT_V40=client;
