export const TALK_CLIENT_V33 = String.raw`(() => {
'use strict';
const $=(id)=>document.getElementById(id);
const chat=$('chat'), status=$('status'), mic=$('mic'), form=$('form'), input=$('input'), diag=$('diag'), logEl=$('log'), ttsTest=$('tts-test');
const TARGET=16000, MAX_HISTORY=14, SILENCE_MS=680, MAX_UTTERANCE_MS=16000, MIN_SPEECH_MS=180, PRE_ROLL=7;
let history=[], micOn=false, stream=null, ctx=null, source=null, processor=null, silentGain=null, busy=false, playing=false, currentAudio=null;
let noise=0.0035, speech=false, startHits=0, silence=0, duration=0, pre=[], frames=[], frameCount=0, lastRms=0, lastPeak=0, utterances=0;
let lastTranscript='', lastSttMs=0, lastGlmMs=0, lastSearchMs=0, lastTtsMs=0, lastError='', lastDiagAt=0;

function ts(){return new Date().toLocaleTimeString('ja-JP',{hour12:false});}
function log(s){const line=ts()+'  '+s; logEl.textContent=(line+'\n'+logEl.textContent).slice(0,12000);}
function setStatus(s){status.textContent=s;}
function add(role,text){const v=String(text||'').trim();if(!v)return;const n=document.createElement('div');n.className='msg '+role;n.textContent=v;chat.appendChild(n);chat.scrollTop=chat.scrollHeight;}
function esc(v){return v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function diagUpdate(force=false){
  const now=Date.now();if(!force&&now-lastDiagAt<250)return;lastDiagAt=now;
  const startTh=Math.max(0.008,Math.min(0.07,noise*2.7));
  const endTh=Math.max(0.0055,Math.min(startTh*.72,noise*1.75));
  const rows={revision:'talksys-v33-clean-http-voice',mic:micOn?'ON':'OFF',audioContext:ctx?ctx.state+' / '+ctx.sampleRate+'Hz':'-',rms:lastRms.toFixed(5),peak:lastPeak.toFixed(5),noiseFloor:noise.toFixed(5),startThreshold:startTh.toFixed(5),endThreshold:endTh.toFixed(5),speechActive:speech,pcmFrames:frameCount,utterances,lastTranscript,lastSttMs,lastSearchMs,lastGlmMs,lastTtsMs,tts:'MeloTTS / JP',error:lastError||'-'};
  diag.innerHTML=Object.entries(rows).map(([k,v])=>'<div class="key">'+k+'</div><div>'+esc(String(v))+'</div>').join('');
}
function level(a){let sum=0,p=0;for(let i=0;i<a.length;i++){const v=a[i]||0;sum+=v*v;p=Math.max(p,Math.abs(v));}return{r:Math.sqrt(sum/Math.max(1,a.length)),p};}
function resampler(sourceRate){
  let pending=[],phase=0,step=sourceRate/TARGET;
  return(input)=>{let p=phase;while(p<input.length){const a=Math.floor(p),f=p-a;pending.push(a+1<input.length?input[a]*(1-f)+input[a+1]*f:(input[a]||0));p+=step;}phase=p-input.length;const out=[];while(pending.length>=640)out.push(new Float32Array(pending.splice(0,640)));return out;};
}
function resetTurn(){speech=false;startHits=0;silence=0;duration=0;frames=[];pre=[];}
function processFrame(a){
  frameCount++;const lv=level(a);lastRms=lv.r;lastPeak=lv.p;const frameMs=a.length/TARGET*1000;
  const startTh=Math.max(0.008,Math.min(0.07,noise*2.7));const endTh=Math.max(0.0055,Math.min(startTh*.72,noise*1.75));
  if(playing||busy){startHits=0;diagUpdate();return;}
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
function wav(chunks){
  let samples=0;for(const c of chunks)samples+=c.length;const b=new ArrayBuffer(44+samples*2),v=new DataView(b);
  const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  w(0,'RIFF');v.setUint32(4,36+samples*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,TARGET,true);v.setUint32(28,TARGET*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,samples*2,true);
  let o=44;for(const c of chunks)for(let i=0;i<c.length;i++){const x=Math.max(-1,Math.min(1,c[i]));v.setInt16(o,x<0?x*0x8000:x*0x7fff,true);o+=2;}return b;
}
async function commitVoice(reason){
  if(!speech)return;const data=frames,ms=duration;resetTurn();if(ms<MIN_SPEECH_MS){log('短すぎる発話を破棄 '+Math.round(ms)+'ms');return;}
  utterances++;const buffer=wav(data);log('発話確定 '+reason+' / '+Math.round(ms)+'ms / '+buffer.byteLength+'B');busy=true;setStatus('聞き取っています…');diagUpdate(true);
  try{
    const t=Date.now();const r=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':'audio/wav'},body:buffer});const j=await r.json();lastSttMs=Date.now()-t;
    if(!r.ok||!j.ok||!j.text)throw new Error(j.error||'文字起こしできませんでした');lastTranscript=j.text;log('STT完了 '+lastSttMs+'ms: '+j.text);add('user',j.text);await ask(j.text);
  }catch(e){lastError=String(e.message||e);log('STTエラー: '+lastError);setStatus('聞き取りに失敗');}
  finally{busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}
}
async function ask(text){
  const previous=history.slice(-MAX_HISTORY);history.push({role:'user',content:text});setStatus('考えています…');
  const t=Date.now();const r=await fetch('/api/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,history:previous})});const j=await r.json();
  lastGlmMs=j?.timings?.glmMs||Date.now()-t;lastSearchMs=j?.timings?.searchMs||0;
  if(!r.ok||!j.ok||!j.answer)throw new Error(j.error||'回答生成に失敗');
  log((j.search?'検索あり':'検索なし')+' / GLM '+lastGlmMs+'ms'+(lastSearchMs?' / 検索 '+lastSearchMs+'ms':''));if(j.search&&j.queries?.length)log('検索語: '+j.queries.join(' | '));
  add('assistant',j.answer);history.push({role:'assistant',content:j.answer});if(history.length>MAX_HISTORY*2)history=history.slice(-MAX_HISTORY*2);await speak(j.answer);
}
async function speak(text){
  setStatus('話しています…');playing=true;
  try{
    const t=Date.now();const r=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
    if(!r.ok){let e='TTS HTTP '+r.status;try{const j=await r.json();e=j.error||e;}catch{}throw new Error(e);}
    const blob=await r.blob();lastTtsMs=Number(r.headers.get('x-talksys-tts-ms'))||Date.now()-t;log('TTS完了 '+lastTtsMs+'ms / '+blob.size+'B / lang='+(r.headers.get('x-talksys-tts-lang')||'?'));
    const url=URL.createObjectURL(blob),a=new Audio(url);currentAudio=a;await a.play();await new Promise(res=>{a.onended=res;a.onerror=res;});URL.revokeObjectURL(url);currentAudio=null;
  }catch(e){lastError=String(e.message||e);log('TTSエラー: '+lastError);}
  finally{playing=false;if(micOn)setStatus('聞いています');else setStatus('停止中');diagUpdate(true);}
}
async function startMic(){
  if(micOn)return;lastError='';
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const AC=window.AudioContext||window.webkitAudioContext;ctx=new AC();await ctx.resume();source=ctx.createMediaStreamSource(stream);processor=ctx.createScriptProcessor(2048,1,1);silentGain=ctx.createGain();silentGain.gain.value=0;
    const convert=resampler(ctx.sampleRate);processor.onaudioprocess=e=>{const d=e.inputBuffer.getChannelData(0);for(const f of convert(d))processFrame(f);};source.connect(processor);processor.connect(silentGain);silentGain.connect(ctx.destination);
    micOn=true;mic.classList.add('on');mic.textContent='マイク会話を停止';setStatus('聞いています');log('マイク開始 '+ctx.sampleRate+'Hz → 16000Hz');diagUpdate(true);
  }catch(e){lastError=e.name+': '+String(e.message||e);log('マイク開始失敗: '+lastError);setStatus('マイクを開始できません');stopMic();}
}
function stopMic(){
  if(speech)resetTurn();micOn=false;try{processor&&processor.disconnect();}catch{}try{source&&source.disconnect();}catch{}try{silentGain&&silentGain.disconnect();}catch{}try{stream&&stream.getTracks().forEach(t=>t.stop());}catch{}
  processor=source=silentGain=stream=null;if(ctx){try{ctx.close();}catch{}ctx=null;}mic.classList.remove('on');mic.textContent='マイク会話を開始';setStatus(playing?'話しています…':'停止中');log('マイク停止');diagUpdate(true);
}
mic.addEventListener('click',()=>micOn?stopMic():startMic());
form.addEventListener('submit',async e=>{
  e.preventDefault();const v=input.value.trim();if(!v||busy)return;input.value='';busy=true;add('user',v);
  try{await ask(v);}catch(err){lastError=String(err.message||err);log('会話エラー: '+lastError);setStatus('回答に失敗');}
  finally{busy=false;if(micOn&&!playing)setStatus('聞いています');diagUpdate(true);}
});
ttsTest.addEventListener('click',async()=>{if(playing)return;log('日本語TTSテスト開始');await speak('日本語音声の動作確認です。聞き取りやすく話せていれば正常です。');});
window.addEventListener('beforeunload',()=>{if(micOn)stopMic();});
diagUpdate(true);log('TalkSys v33 起動');
})();`;
