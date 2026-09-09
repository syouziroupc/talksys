import { TALK_CLIENT_V37 } from './talk-client-v37.js';

const REVISION='talksys-v38-history-search-tts-fallback';

const SPEAK_PATCH=String.raw`
async function playServerTtsChunk(text,token){
  const r=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
  if(!r.ok){let msg='サーバーTTSに失敗';try{const j=await r.json();if(j?.error)msg+=': '+j.error;}catch{}throw new Error(msg);}
  const buffer=await r.arrayBuffer();if(token!==ttsToken)return;
  lastVoiceName='Cloudflare MeloTTS fallback';
  if(ctx&&ctx.state==='running'&&typeof ctx.decodeAudioData==='function'){
    const decoded=await ctx.decodeAudioData(buffer.slice(0));if(token!==ttsToken)return;
    await new Promise((resolve,reject)=>{try{const s=ctx.createBufferSource();fallbackSource=s;s.buffer=decoded;s.connect(ctx.destination);s.onended=()=>{if(fallbackSource===s)fallbackSource=null;resolve();};s.start();}catch(e){reject(e);}});return;
  }
  const blob=new Blob([buffer],{type:r.headers.get('content-type')||'audio/wav'}),url=URL.createObjectURL(blob);const a=new Audio(url);fallbackAudio=a;
  try{await new Promise((resolve,reject)=>{a.onended=resolve;a.onerror=()=>reject(new Error('サーバーTTS再生エラー'));const p=a.play();if(p&&typeof p.catch==='function')p.catch(reject);});}finally{if(fallbackAudio===a)fallbackAudio=null;URL.revokeObjectURL(url);}
}
async function playDeviceTtsChunk(chunk,voice,token){
  const u=new SpeechSynthesisUtterance(chunk);u.voice=voice;u.lang=voice.lang||'ja-JP';u.rate=1.0;u.pitch=1;u.volume=1;
  await new Promise((resolve,reject)=>{u.onend=resolve;u.onerror=e=>{if(token!==ttsToken||/canceled|cancelled|interrupted/i.test(String(e?.error||'')))resolve();else reject(new Error('端末TTS再生エラー: '+(e?.error||'unknown')));};window.speechSynthesis.speak(u);});
}
async function speak(text,options={}){
  const chunks=speechChunks(text);if(!chunks.length)return;const startIndex=Math.max(0,Math.min(chunks.length-1,Number(options.startIndex)||0));const token=++ttsToken;ttsStartedAt=Date.now();bargeHits=0;playing=true;lastError='';setStatus(options.searchAnnouncement?'検索しています…':'話しています…');const t=Date.now();
  let voice=null,useServer=false;
  try{
    try{voice=await selectJapaneseVoice();lastVoiceName=(voice.name||'日本語音声')+' / '+(voice.lang||'ja-JP');}
    catch(e){useServer=true;lastVoiceName='Cloudflare MeloTTS fallback';log('端末日本語音声なし → Cloudflare TTSへフォールバック');}
    for(let i=startIndex;i<chunks.length;i++){
      if(token!==ttsToken)break;activeSpeechPlan={text,chunks,index:i,resumeable:options.resumeable!==false};
      if(!useServer){
        try{await playDeviceTtsChunk(chunks[i],voice,token);}
        catch(e){if(token!==ttsToken)break;useServer=true;lastVoiceName='Cloudflare MeloTTS fallback';log('端末TTS再生失敗 → Cloudflare TTSへフォールバック: '+String(e.message||e));}
      }
      if(useServer&&token===ttsToken)await playServerTtsChunk(chunks[i],token);
    }
    lastTtsMs=Date.now()-t;if(token===ttsToken)log((useServer?'Cloudflare':'端末')+'日本語TTS完了 '+lastTtsMs+'ms / voice='+lastVoiceName);else log('TTSは割込みで停止');
  }catch(e){lastTtsMs=Date.now()-t;if(token===ttsToken){lastError=String(e.message||e);log('TTSエラー: '+lastError);}}
  finally{if(token===ttsToken){playing=false;activeSpeechPlan=null;if(micOn)setStatus('聞いています');else setStatus('停止中');}diagUpdate(true);}
}`;

const ASK_PATCH=String.raw`
async function ask(text){
  const seq=++turnSeq,previous=history.slice(-MAX_HISTORY);history.push({role:'user',content:text});setStatus('考えています…');
  const plan=await getPlan(text,previous);if(seq!==turnSeq)return;lastPlanMs=Number(plan?.plannerMs)||0;lastSearchPlan=String(plan?.searchInstruction||'');
  const payload={text,history:previous,searchTrace,searchPlan:plan||null};
  const ack=String(plan?.ack||'').trim();
  if(plan?.search){
    lastSearchTopic=plan.topic||plan.resolvedQuestion||'必要な情報';const searching=(ack?ack+' ':'')+'条件に合う情報を調べます。';add('assistant',searching);log('検索計画 ['+(plan.planner||'?')+'] '+lastSearchTopic+(lastSearchPlan?' / '+lastSearchPlan:''));
    const turnPromise=fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});await speak(searching,{searchAnnouncement:true,resumeable:false});if(seq!==turnSeq)return;
    const t=Date.now(),r=await turnPromise,j=await r.json();if(seq!==turnSeq)return;lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace=j.search?{resolvedQuestion:j.resolvedQuestion||plan.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]}:searchTrace;
    log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / planner='+(j.planner||plan.planner||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));if(j.search&&j.queries?.length)log('検索語: '+j.queries.join(' | '));add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer,{resumeable:true});return;
  }
  const turnPromise=fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(ack){add('assistant',ack);log('相槌: '+ack);await speak(ack,{resumeable:false});if(seq!==turnSeq)return;}
  const t=Date.now(),r=await turnPromise,j=await r.json();if(seq!==turnSeq)return;lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');if(j.search){lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace={resolvedQuestion:j.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]};}log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer,{resumeable:true});
}`;

let client=TALK_CLIENT_V37.replaceAll('talksys-v37-grounded-continuity',REVISION).replaceAll('TalkSys v37 起動','TalkSys v38 起動');
client=client.replace("let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0;","let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0, fallbackAudio=null, fallbackSource=null, lastPlanMs=0, lastSearchPlan='';");
client=client.replace("tts:'端末日本語 / '+lastVoiceName,bargeIns,falseBargeResumes,lastSearchTopic,lastSearchQueries:lastSearchQueries.join(' | '),error:lastError||'-'","tts:'自動（端末→Cloudflare） / '+lastVoiceName,planMs:lastPlanMs,bargeIns,falseBargeResumes,lastSearchTopic,lastSearchPlan,lastSearchQueries:lastSearchQueries.join(' | '),error:lastError||'-'");
client=client.replace(/async function speak\(text,options=\{\}\)\{[\s\S]*?\n\}\nfunction interruptSpeechForBargeIn/,SPEAK_PATCH+'\nfunction interruptSpeechForBargeIn');
client=client.replace("ttsToken++;try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}playing=false;","ttsToken++;try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}try{fallbackSource&&fallbackSource.stop();}catch{}fallbackSource=null;try{if(fallbackAudio){fallbackAudio.pause();fallbackAudio.currentTime=0;}}catch{}fallbackAudio=null;playing=false;");
client=client.replace(/async function ask\(text\)\{[\s\S]*?\n\}\nasync function startMic/,ASK_PATCH+'\nasync function startMic');
client=client.replace("window.addEventListener('beforeunload',()=>{try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}if(micOn)stopMic();});","window.addEventListener('beforeunload',()=>{try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}try{fallbackSource&&fallbackSource.stop();}catch{}try{fallbackAudio&&fallbackAudio.pause();}catch{}if(micOn)stopMic();});");

export const TALK_CLIENT_V38=client;
