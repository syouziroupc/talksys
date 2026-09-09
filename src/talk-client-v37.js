export const TALK_CLIENT_V37 = String.raw`(() => {
'use strict';
const $=(id)=>document.getElementById(id);
const chat=$('chat'), status=$('status'), mic=$('mic'), form=$('form'), input=$('input'), diag=$('diag'), logEl=$('log'), ttsTest=$('tts-test');
const TARGET=16000, MAX_HISTORY=14, SILENCE_MS=680, MAX_UTTERANCE_MS=16000, MIN_SPEECH_MS=180, PRE_ROLL=7;
const GREETING='こんにちは。AIアシスタントのフォーンズです。何かお手伝いできることはありますか？';
let history=[], micOn=false, stream=null, ctx=null, source=null, processor=null, silentGain=null, busy=false, playing=false;
let noise=0.0035, speech=false, startHits=0, silence=0, duration=0, pre=[], frames=[], frameCount=0, lastRms=0, lastPeak=0, utterances=0;
let lastTranscript='', lastSttMs=0, lastGlmMs=0, lastSearchMs=0, lastTtsMs=0, lastError='', lastDiagAt=0, lastVoiceName='未選択';
let bargeHits=0, bargeIns=0, falseBargeResumes=0, lockedVoiceKey='', voiceSelectionPromise=null, ttsToken=0, ttsStartedAt=0, resumePlan=null, activeSpeechPlan=null, bargeCooldownUntil=0;
let searchTrace=null, lastSearchTopic='', lastSearchQueries=[], turnSeq=0;

function ts(){return new Date().toLocaleTimeString('ja-JP',{hour12:false,timeZone:'Asia/Tokyo'});}
function jst(){return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date());}
function log(s){const line=ts()+'  '+s; logEl.textContent=(line+'\n'+logEl.textContent).slice(0,16000);}
function setStatus(s){status.textContent=s;}
function add(role,text){const v=String(text||'').trim();if(!v)return;const n=document.createElement('div');n.className='msg '+role;n.textContent=v;chat.appendChild(n);chat.scrollTop=chat.scrollHeight;}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function diagUpdate(force=false){
  const now=Date.now();if(!force&&now-lastDiagAt<250)return;lastDiagAt=now;
  const startTh=Math.max(0.008,Math.min(0.07,noise*2.7));const endTh=Math.max(0.0055,Math.min(startTh*.72,noise*1.75));
  const rows={revision:'talksys-v37-grounded-continuity',jst:jst(),mic:micOn?'ON':'OFF',audioContext:ctx?ctx.state+' / '+ctx.sampleRate+'Hz':'-',rms:lastRms.toFixed(5),peak:lastPeak.toFixed(5),noiseFloor:noise.toFixed(5),startThreshold:startTh.toFixed(5),endThreshold:endTh.toFixed(5),speechActive:speech,pcmFrames:frameCount,utterances,lastTranscript,lastSttMs,lastSearchMs,lastGlmMs,lastTtsMs,tts:'端末日本語 / '+lastVoiceName,bargeIns,falseBargeResumes,lastSearchTopic,lastSearchQueries:lastSearchQueries.join(' | '),error:lastError||'-'};
  diag.innerHTML=Object.entries(rows).map(([k,v])=>'<div class="key">'+k+'</div><div>'+esc(String(v))+'</div>').join('');
}
function level(a){let sum=0,p=0;for(let i=0;i<a.length;i++){const v=a[i]||0;sum+=v*v;p=Math.max(p,Math.abs(v));}return{r:Math.sqrt(sum/Math.max(1,a.length)),p};}
function resampler(sourceRate){let pending=[],phase=0,step=sourceRate/TARGET;return(input)=>{let p=phase;while(p<input.length){const a=Math.floor(p),f=p-a;pending.push(a+1<input.length?input[a]*(1-f)+input[a+1]*f:(input[a]||0));p+=step;}phase=p-input.length;const out=[];while(pending.length>=640)out.push(new Float32Array(pending.splice(0,640)));return out;};}
function resetTurn(){speech=false;startHits=0;silence=0;duration=0;frames=[];pre=[];}
function voiceKey(v){return String(v?.voiceURI||v?.name||'')+'|'+String(v?.lang||'');}
function voiceScore(v){const name=String(v?.name||''),lang=String(v?.lang||'');let score=0;if(/^ja-JP$/i.test(lang))score+=120;else if(/^ja(?:-|$)/i.test(lang))score+=90;if(/Google.*(?:日本語|Japanese)/i.test(name))score+=1000;else if(/Google/i.test(name))score+=900;else if(/Nanami/i.test(name))score+=820;else if(/Haruka|Sayaka|Ichiro|Keita/i.test(name))score+=760;else if(/Microsoft/i.test(name))score+=650;else if(/Ayumi/i.test(name))score+=420;if(v?.localService)score+=12;return score;}
async function voiceInventory(){
  if(!('speechSynthesis' in window)||!('SpeechSynthesisUtterance' in window))throw new Error('このブラウザは端末TTSに対応していません');
  let voices=window.speechSynthesis.getVoices();await Promise.race([new Promise(resolve=>window.speechSynthesis.addEventListener('voiceschanged',resolve,{once:true})),new Promise(resolve=>setTimeout(resolve,650))]);await new Promise(resolve=>setTimeout(resolve,120));const later=window.speechSynthesis.getVoices();if(later.length)voices=later;return voices;
}
async function selectJapaneseVoice(){
  const now=window.speechSynthesis.getVoices();if(lockedVoiceKey){const same=now.find(v=>voiceKey(v)===lockedVoiceKey);if(same)return same;}if(voiceSelectionPromise)return voiceSelectionPromise;
  voiceSelectionPromise=(async()=>{const voices=await voiceInventory();const ja=voices.filter(v=>/^ja(?:-|$)/i.test(String(v.lang||'')));if(!ja.length)throw new Error('日本語TTS音声（ja-JP）が端末にありません');ja.sort((a,b)=>voiceScore(b)-voiceScore(a)||String(a.name||'').localeCompare(String(b.name||''),'ja'));const chosen=ja[0];lockedVoiceKey=voiceKey(chosen);lastVoiceName=(chosen.name||'日本語音声')+' / '+(chosen.lang||'ja-JP');log('日本語音声を固定 '+lastVoiceName);diagUpdate(true);return chosen;})();
  try{return await voiceSelectionPromise;}finally{voiceSelectionPromise=null;}
}
function spokenText(text){return String(text||'').replace(/https?:\/\/\S+/g,'リンク').replace(/[*_#>\x60~]/g,'').replace(/\bWindows\s*10\b/gi,'ウィンドウズ テン').replace(/\bWindows\s*11\b/gi,'ウィンドウズ イレブン').replace(/\bPC\b/gi,'パソコン').replace(/\bSSD\b/gi,'エスエスディー').replace(/\bHDD\b/gi,'エイチディーディー').replace(/\bCPU\b/gi,'シーピーユー').replace(/\bGPU\b/gi,'ジーピーユー').replace(/\bRAM\b/gi,'メモリー').replace(/\bUSB\b/gi,'ユーエスビー').replace(/\bHDMI\b/gi,'エイチディーエムアイ').replace(/\bWi[-‐‑–—]?Fi\b/gi,'ワイファイ').replace(/\s+/g,' ').trim();}
function speechChunks(text){const value=spokenText(text);const parts=value.match(/[^。！？!?]+[。！？!?]?/g)||[value];const out=[];let buf='';for(const part of parts){if((buf+part).length<=90){buf+=part;continue;}if(buf)out.push(buf);buf=part;}if(buf)out.push(buf);return out.filter(Boolean);}
async function speak(text,options={}){
  const chunks=speechChunks(text);if(!chunks.length)return;const startIndex=Math.max(0,Math.min(chunks.length-1,Number(options.startIndex)||0));const token=++ttsToken;ttsStartedAt=Date.now();bargeHits=0;playing=true;lastError='';setStatus(options.searchAnnouncement?'検索しています…':'話しています…');const t=Date.now();
  try{
    const voice=await selectJapaneseVoice();lastVoiceName=(voice.name||'日本語音声')+' / '+(voice.lang||'ja-JP');
    for(let i=startIndex;i<chunks.length;i++){
      if(token!==ttsToken)break;activeSpeechPlan={text,chunks,index:i,resumeable:options.resumeable!==false};
      const u=new SpeechSynthesisUtterance(chunks[i]);u.voice=voice;u.lang=voice.lang||'ja-JP';u.rate=1.0;u.pitch=1;u.volume=1;
      await new Promise((resolve,reject)=>{u.onend=resolve;u.onerror=e=>{if(token!==ttsToken||/canceled|cancelled|interrupted/i.test(String(e?.error||'')))resolve();else reject(new Error('端末TTS再生エラー: '+(e?.error||'unknown')));};window.speechSynthesis.speak(u);});
    }
    lastTtsMs=Date.now()-t;if(token===ttsToken)log('端末日本語TTS完了 '+lastTtsMs+'ms / voice='+lastVoiceName);else log('端末日本語TTSは割込みで停止');
  }catch(e){lastTtsMs=Date.now()-t;if(token===ttsToken){lastError=String(e.message||e);log('TTSエラー: '+lastError);}}
  finally{if(token===ttsToken){playing=false;activeSpeechPlan=null;if(micOn)setStatus('聞いています');else setStatus('停止中');}diagUpdate(true);}
}
function interruptSpeechForBargeIn(rms){
  if(!playing||Date.now()<bargeCooldownUntil)return false;bargeIns++;bargeHits=0;
  if(activeSpeechPlan?.resumeable)resumePlan={text:activeSpeechPlan.text,chunks:activeSpeechPlan.chunks,index:activeSpeechPlan.index};
  else resumePlan=null;
  ttsToken++;try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}playing=false;log('音声割込み '+bargeIns+'回目 RMS='+Number(rms||0).toFixed(4));setStatus('聞いています…');diagUpdate(true);return true;
}
async function resumeInterruptedSpeech(){const plan=resumePlan;resumePlan=null;if(!plan)return false;falseBargeResumes++;bargeCooldownUntil=Date.now()+900;log('新しい発話なし。元の読み上げを再開 '+falseBargeResumes+'回目');await speak(plan.text,{startIndex:plan.index,resumeable:true});return true;}
function processFrame(a){
  frameCount++;const lv=level(a);lastRms=lv.r;lastPeak=lv.p;const frameMs=a.length/TARGET*1000;const startTh=Math.max(0.008,Math.min(0.07,noise*2.7));const endTh=Math.max(0.0055,Math.min(startTh*.72,noise*1.75));
  if(playing){pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();const age=Date.now()-ttsStartedAt;const bargeTh=Math.max(0.011,Math.min(0.055,startTh*1.15));const peakTh=Math.max(0.025,bargeTh*1.7);if(age>420&&lv.r>=bargeTh&&lv.p>=peakTh)bargeHits++;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=3&&interruptSpeechForBargeIn(lv.r)){speech=true;frames=pre.splice(0);duration=frames.length*frameMs;silence=0;startHits=0;log('割込み発話開始');diagUpdate(true);}return;}
  if(busy&&!speech){startHits=0;bargeHits=0;diagUpdate();return;}
  if(!speech){pre.push(a.slice());if(pre.length>PRE_ROLL)pre.shift();if(lv.r<startTh){noise=Math.max(.001,Math.min(.025,noise*.985+lv.r*.015));startHits=0;diagUpdate();return;}startHits++;if(startHits<2){diagUpdate();return;}speech=true;frames=pre.splice(0);duration=frames.length*frameMs;silence=0;log('発話開始 RMS='+lv.r.toFixed(4));setStatus('聞いています…');diagUpdate(true);return;}
  frames.push(a.slice());duration+=frameMs;if(lv.r>endTh)silence=0;else silence+=frameMs;if(duration>=MAX_UTTERANCE_MS||silence>=SILENCE_MS)commitVoice(duration>=MAX_UTTERANCE_MS?'最大長':'無音');diagUpdate();
}
function wav(chunks){let samples=0;for(const c of chunks)samples+=c.length;const b=new ArrayBuffer(44+samples*2),v=new DataView(b);const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};w(0,'RIFF');v.setUint32(4,36+samples*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,TARGET,true);v.setUint32(28,TARGET*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,samples*2,true);let o=44;for(const c of chunks)for(let i=0;i<c.length;i++){const x=Math.max(-1,Math.min(1,c[i]));v.setInt16(o,x<0?x*0x8000:x*0x7fff,true);o+=2;}return b;}
async function commitVoice(reason){
  if(!speech)return;const data=frames,ms=duration;resetTurn();if(ms<MIN_SPEECH_MS){log('短すぎる発話を破棄 '+Math.round(ms)+'ms');if(resumePlan)await resumeInterruptedSpeech();return;}
  utterances++;const buffer=wav(data);log('発話確定 '+reason+' / '+Math.round(ms)+'ms / '+buffer.byteLength+'B');busy=true;setStatus('聞き取っています…');diagUpdate(true);
  let gotText=false;
  try{const t=Date.now();const r=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':'audio/wav'},body:buffer});const j=await r.json();lastSttMs=Date.now()-t;if(!r.ok||!j.ok||!j.text)throw new Error(j.error||'文字起こしできませんでした');gotText=true;resumePlan=null;lastTranscript=j.text;lastError='';log('STT完了 '+lastSttMs+'ms: '+j.text);add('user',j.text);await ask(j.text);}
  catch(e){lastError=String(e.message||e);log('STTエラー: '+lastError);if(!gotText&&resumePlan){lastError='';await resumeInterruptedSpeech();}else setStatus('聞き取りに失敗');}
  finally{busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}
}
async function getPlan(text,previous){
  try{const r=await fetch('/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,history:previous,searchTrace})});if(!r.ok)return null;return await r.json();}catch{return null;}
}
async function ask(text){
  const seq=++turnSeq,previous=history.slice(-MAX_HISTORY);history.push({role:'user',content:text});setStatus('考えています…');
  const plan=await getPlan(text,previous);if(seq!==turnSeq)return;
  if(plan?.search){lastSearchTopic=plan.topic||'必要な情報';const searching=lastSearchTopic+'について検索しています。';add('assistant',searching);log('検索開始: '+lastSearchTopic);const turnPromise=fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,history:previous,searchTrace})});await speak(searching,{searchAnnouncement:true,resumeable:false});if(seq!==turnSeq)return;const t=Date.now(),r=await turnPromise,j=await r.json();if(seq!==turnSeq)return;lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace=j.search?{resolvedQuestion:j.resolvedQuestion||plan.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]}:searchTrace;log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));if(j.search&&j.queries?.length)log('検索語: '+j.queries.join(' | '));add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer,{resumeable:true});return;}
  const t=Date.now();const r=await fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,history:previous,searchTrace})});const j=await r.json();if(seq!==turnSeq)return;lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');if(j.search){lastSearchQueries=Array.isArray(j.queries)?j.queries.slice(0,6):[];searchTrace={resolvedQuestion:j.resolvedQuestion||text,queries:lastSearchQueries,sources:Array.isArray(j.sources)?j.sources.slice(0,8):[]};}log((j.search?'検索あり':'検索なし')+' / route='+(j.route||'?')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer,{resumeable:true});
}
async function startMic(){if(micOn)return;lastError='';try{stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:true,noiseSuppression:true,autoGainControl:true}});const AC=window.AudioContext||window.webkitAudioContext;ctx=new AC();await ctx.resume();source=ctx.createMediaStreamSource(stream);processor=ctx.createScriptProcessor(2048,1,1);silentGain=ctx.createGain();silentGain.gain.value=0;const convert=resampler(ctx.sampleRate);processor.onaudioprocess=e=>{const d=e.inputBuffer.getChannelData(0);for(const f of convert(d))processFrame(f);};source.connect(processor);processor.connect(silentGain);silentGain.connect(ctx.destination);micOn=true;mic.classList.add('on');mic.textContent='マイク会話を停止';setStatus(playing?'話しています…':'聞いています');log('マイク開始 '+ctx.sampleRate+'Hz → 16000Hz');diagUpdate(true);}catch(e){lastError=e.name+': '+String(e.message||e);log('マイク開始失敗: '+lastError);setStatus('マイクを開始できません');stopMic();}}
function stopMic(){if(speech)resetTurn();micOn=false;try{processor&&processor.disconnect();}catch{}try{source&&source.disconnect();}catch{}try{silentGain&&silentGain.disconnect();}catch{}try{stream&&stream.getTracks().forEach(t=>t.stop());}catch{}processor=source=silentGain=stream=null;if(ctx){try{ctx.close();}catch{}ctx=null;}mic.classList.remove('on');mic.textContent='マイク会話を開始';setStatus(playing?'話しています…':'停止中');log('マイク停止');diagUpdate(true);}
mic.addEventListener('click',()=>micOn?stopMic():startMic());
form.addEventListener('submit',async e=>{e.preventDefault();const v=input.value.trim();if(!v||busy)return;input.value='';busy=true;resumePlan=null;add('user',v);try{await ask(v);}catch(err){lastError=String(err.message||err);log('会話エラー: '+lastError);setStatus('回答に失敗');}finally{busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}});
ttsTest.addEventListener('click',async()=>{if(playing)return;log('日本語TTSテスト開始');await speak('日本語音声の動作確認です。Windows 10とWindows 11も自然に読めれば正常です。',{resumeable:false});});
window.addEventListener('beforeunload',()=>{try{window.speechSynthesis&&window.speechSynthesis.cancel();}catch{}if(micOn)stopMic();});
add('assistant',GREETING);history.push({role:'assistant',content:GREETING});diagUpdate(true);log('TalkSys v37 起動');setTimeout(()=>{if(!playing)speak(GREETING,{resumeable:false}).catch(()=>{});},180);
})();`;
