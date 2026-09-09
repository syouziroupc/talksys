import workerV36 from './worker-v36.js';
import workerV34 from './worker-v34.js';
import { groundingDecisionV22 } from './grounding-policy-v22.js';
import { TALK_CLIENT_V37 } from './talk-client-v37.js';

const REVISION='talksys-v37-grounded-continuity';
const STT_MODEL='@cf/openai/whisper-large-v3-turbo';
const SEARCH_RE=/(検索して|調べて|ウェブで|Webで|ネットで|最新|現在|今日|明日|昨日|今から|次の|何時|時刻|時刻表|運行|遅延|天気|ニュース|価格|値段|相場|在庫|営業時間|営業中|発売|販売中|現行|法改正|制度|予定|日程|空席|予約|電話番号|連絡先|住所|所在地|アクセス|公式サイト|URL|ランキング|順位|どこで買|どこに売|近くの|店舗|販売店|家電量販店|乗り換え|乗換|経路|行き方|所要時間|運賃|誰|どこ|いつ|いくら)/i;
const RETRY_RE=/(もうちょっと|もう少し|何とかして|ちゃんと調べ|もっと調べ|検索し直|再検索|それじゃ困|分からないじゃなく|詳しく)/i;
const TRACE_RE=/(何を検索|なにを検索|どんな検索|検索語|何で調べ|どこを見た|何を調べ)/i;
const CLOCK_RE=/(今(?:は)?何時|現在時刻|日本時間|日本の時間|いま何時)/i;
const DATE_RE=/(今日は何日|今日の日付|今日は何曜日|今日何曜日)/i;
const PC_RE=/(パソコン|\bPC\b|ＰＣ|Windows|ノート|デスクトップ|Core\s*i[3579]|Ryzen|メモリ|SSD|HDD)/i;
const PURCHASE_RE=/(どこで買|どこがいい|購入先|販売店|店で買|通販|安い店|おすすめ.*店)/i;
const NEXT_TRANSIT_RE=/(次の電車|次発|次に乗|何時発|発車時刻|今から.*電車|現在.*電車|時刻表)/i;
const OLD_STT_PROMPT_RE=/^日本語の日常会話を[、,]?聞こえた内容のまま文字起こしする[。．.]?(?:固有名詞、製品名、英数字を勝手に言い換えない[。．.]?)?$/u;
const COMMON_SILENCE_HALLUCINATION_RE=/^(?:ご視聴ありがとうございました|ご清聴ありがとうございました|最後までご視聴ありがとうございました|チャンネル登録(?:を)?(?:お願い(?:します|いたします)|よろしくお願いします)|字幕(?:をご覧いただき)?ありがとうございました)[。．.!！?？]*$/u;

function clean(v,max=4000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-14).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1400)})).filter(x=>x.content):[];}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function base64FromBytes(bytes){let out='';const size=0x8000;for(let i=0;i<bytes.length;i+=size)out+=String.fromCharCode(...bytes.subarray(i,Math.min(bytes.length,i+size)));return btoa(out);}
function ascii(view,offset,length){let out='';for(let i=0;i<length&&offset+i<view.byteLength;i++)out+=String.fromCharCode(view.getUint8(offset+i));return out;}
function analyzeWav(buffer){
  try{
    const view=new DataView(buffer);if(view.byteLength<44||ascii(view,0,4)!=='RIFF'||ascii(view,8,4)!=='WAVE')return {valid:false,durationMs:0,rms:0,peak:0,activeMs:0,activeRatio:0};
    let offset=12,format=0,channels=0,sampleRate=0,bits=0,dataOffset=-1,dataSize=0;
    while(offset+8<=view.byteLength){const id=ascii(view,offset,4),size=view.getUint32(offset+4,true),body=offset+8;if(id==='fmt '&&size>=16&&body+16<=view.byteLength){format=view.getUint16(body,true);channels=view.getUint16(body+2,true);sampleRate=view.getUint32(body+4,true);bits=view.getUint16(body+14,true);}else if(id==='data'){dataOffset=body;dataSize=Math.min(size,Math.max(0,view.byteLength-body));break;}offset=body+size+(size&1);}
    if(format!==1||channels<1||bits!==16||sampleRate<8000||dataOffset<0||dataSize<2*channels)return {valid:false,durationMs:0,rms:0,peak:0,activeMs:0,activeRatio:0};
    const sampleCount=Math.floor(dataSize/(2*channels)),frameSamples=Math.max(1,Math.round(sampleRate*.02));let sum=0,peak=0,activeFrames=0,totalFrames=0,frameSum=0,frameN=0;
    for(let i=0;i<sampleCount;i++){
      let mono=0;for(let c=0;c<channels;c++)mono+=view.getInt16(dataOffset+(i*channels+c)*2,true)/32768;mono/=channels;const a=Math.abs(mono);sum+=mono*mono;if(a>peak)peak=a;frameSum+=mono*mono;frameN++;
      if(frameN>=frameSamples||i===sampleCount-1){const frameRms=Math.sqrt(frameSum/Math.max(1,frameN));if(frameRms>=0.006)activeFrames++;totalFrames++;frameSum=0;frameN=0;}
    }
    const rms=Math.sqrt(sum/Math.max(1,sampleCount)),durationMs=sampleCount/sampleRate*1000,activeRatio=totalFrames?activeFrames/totalFrames:0,activeMs=activeFrames*20;
    return {valid:true,durationMs,rms,peak,activeMs,activeRatio,sampleRate,channels};
  }catch{return {valid:false,durationMs:0,rms:0,peak:0,activeMs:0,activeRatio:0};}
}
function weakSpeechSignal(m){return !m?.valid||m.durationMs<260||m.peak<0.010||m.rms<0.0018||m.activeMs<120||m.activeRatio<0.06;}
function isLikelySttHallucination(text,metrics){
  const value=clean(text,500);if(!value)return true;
  if(OLD_STT_PROMPT_RE.test(value))return true;
  if(COMMON_SILENCE_HALLUCINATION_RE.test(value)&&(!metrics?.valid||metrics.rms<0.010||metrics.activeMs<650||metrics.activeRatio<0.24))return true;
  if(/^(?:えー|あー|うー|んー|…|\.\.\.)$/u.test(value)&&weakSpeechSignal(metrics))return true;
  return false;
}
async function transcribeHardened(request,env){
  const started=Date.now(),buffer=await request.arrayBuffer();
  if(buffer.byteLength<800)return json({ok:false,error:'audio too short',rejected:'audio-too-short'},400);
  if(buffer.byteLength>8_000_000)return json({ok:false,error:'audio too large'},413);
  const metrics=analyzeWav(buffer);
  const signal={durationMs:Math.round(metrics.durationMs||0),rms:Number((metrics.rms||0).toFixed(5)),peak:Number((metrics.peak||0).toFixed(5)),activeMs:Math.round(metrics.activeMs||0),activeRatio:Number((metrics.activeRatio||0).toFixed(3))};
  if(weakSpeechSignal(metrics))return json({ok:false,error:'no speech detected',rejected:'weak-speech-signal',elapsedMs:Date.now()-started,signal},422);
  try{
    const result=await env.AI.run(STT_MODEL,{audio:base64FromBytes(new Uint8Array(buffer)),task:'transcribe',language:'ja',vad_filter:true,beam_size:5,condition_on_previous_text:false,no_speech_threshold:0.48,compression_ratio_threshold:2.2,log_prob_threshold:-0.8,hallucination_silence_threshold:0.5});
    const text=clean(result?.text||result?.transcription_info?.text||result?.transcript||result?.response||'',1200);
    if(!text)return json({ok:false,error:'no speech detected',rejected:'empty-transcript',elapsedMs:Date.now()-started,signal},422);
    if(isLikelySttHallucination(text,metrics))return json({ok:false,error:'hallucinated transcript rejected',rejected:'hallucination-guard',elapsedMs:Date.now()-started,signal},422);
    return json({ok:true,text,elapsedMs:Date.now()-started,bytes:buffer.byteLength,model:STT_MODEL,signal,guard:'mobile-stt-v37'});
  }catch(error){return json({ok:false,error:String(error?.message||error).slice(0,240),elapsedMs:Date.now()-started,signal},502);}
}
function jstParts(date=new Date()){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,weekday:'short'});
  const p=Object.fromEntries(f.formatToParts(date).map(x=>[x.type,x.value]));
  return {year:p.year,month:p.month,day:p.day,hour:p.hour,minute:p.minute,second:p.second,weekday:p.weekday,iso:`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} JST`};
}
function jstJapanese(date=new Date()){
  return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date)+'（日本時間）';
}
function lastUser(history,skipCurrent=''){
  for(const item of [...history].reverse()){
    if(item.role!=='user')continue;const v=clean(item.content,900);if(!v||v===skipCurrent)continue;if(TRACE_RE.test(v))continue;return v;
  }
  return '';
}
function stationPair(text){
  const v=clean(text,1800);
  const pair=v.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,20}?)(?:駅)?\s*(?:から|より|→|⇒|〜|～|-)\s*([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,20}?)(?:駅)?\s*(?:まで|へ|に)(?=$|[のをがはで、。！？!?\s]|行)/i);
  if(!pair?.[1]||!pair?.[2])return [];
  const normalize=x=>clean(x,30).replace(/駅$/u,'');return [normalize(pair[1]),normalize(pair[2])];
}
function findStationPair(text,history){
  const direct=stationPair(text);if(direct.length)return direct;
  for(const item of [...history].reverse()){const pair=stationPair(item.content);if(pair.length)return pair;}
  return [];
}
function recentUserContext(history){return history.filter(x=>x.role==='user').slice(-6).map(x=>x.content).join(' ');}
function traceAnswer(trace){
  if(!trace||typeof trace!=='object')return '';
  const resolved=clean(trace.resolvedQuestion,260),queries=Array.isArray(trace.queries)?trace.queries.map(x=>clean(x,120)).filter(Boolean).slice(0,4):[],sources=Array.isArray(trace.sources)?trace.sources.map(x=>clean(x?.title,100)).filter(Boolean).slice(0,3):[];
  if(!resolved&&!queries.length&&!sources.length)return '';
  const q=queries.length?`検索語は「${queries.join('」「')}」です。`:'';
  const s=sources.length?`主に${sources.join('、')}を確認しました。`:'';
  return clean(`直前は${resolved?`「${resolved}」を調べるために、`:''}${q}${s}`,420);
}
function topicFrom(text,history){
  const current=clean(text,220);
  const [from,to]=findStationPair(current,history);
  if(from&&to&&/(電車|駅|乗換|乗り換え|時刻|何時|行き方|経路|次)/i.test(`${recentUserContext(history)} ${current}`))return `${from}駅から${to}駅までの交通情報`;
  const context=`${recentUserContext(history)} ${current}`;
  if(PC_RE.test(context)&&PURCHASE_RE.test(current))return 'ノートパソコンの購入先';
  if(RETRY_RE.test(current)){const prev=lastUser(history,current);if(prev)return clean(prev.replace(/[。！？!?]+$/g,''),60);}
  return clean(current.replace(/(?:教えて|知りたい|調べて|検索して|お願いします?|ください|かな|ですか|なの|なんだろう|[。！？!?])+$/g,''),70)||'必要な情報';
}
function shouldSearch(text,history){
  const current=clean(text,900);if(!current||TRACE_RE.test(current)||CLOCK_RE.test(current)||DATE_RE.test(current))return false;
  if(SEARCH_RE.test(current)||RETRY_RE.test(current))return true;
  const base=groundingDecisionV22(current,history);return Boolean(base?.search);
}
function rewriteSearch(text,history,now=new Date()){
  const current=clean(text,1000),context=recentUserContext(history),stamp=jstJapanese(now),pair=findStationPair(current,history);
  if(pair.length&&(NEXT_TRANSIT_RE.test(current)||RETRY_RE.test(current)||/(電車|乗換|乗り換え|経路|行き方|運賃)/i.test(current))){
    const [from,to]=pair;return `${stamp}。${from}駅から${to}駅まで、現在時刻以降に利用できる列車を検索して。次に乗れる便を優先し、発車時刻、到着時刻、行先、乗換の有無、運賃を確認して。`;
  }
  if(RETRY_RE.test(current)){
    const prev=lastUser(history,current);if(prev)return `${stamp}。直前の質問「${prev}」について、前回の検索で不足した情報を別の検索元も使って再確認して。具体的な根拠が取れるまで検索して。`;
  }
  if(PC_RE.test(`${context} ${current}`)&&PURCHASE_RE.test(current)){
    const cheap=/(安い|格安|低価格)/i.test(context),laptop=/(ノート|ノートパソコン)/i.test(context);
    return `${laptop?'ノートパソコン':'パソコン'}の購入先を検索して。${cheap?'低価格帯を優先し、':''}メーカー直販、パソコン専門店、大手販売店の公式情報を比較し、保証や販売実態を確認できる具体的な購入先を挙げて。根拠にない販売店名は挙げないで。`;
  }
  if(/(次|今|現在|今日|明日|何時|いつ|最新)/i.test(current))return `${stamp}。${current} 最新の正確な情報を複数の検索元で確認して。`;
  return `${current} 正確な情報を複数の検索元で確認して。`;
}
function buildPlan(text,history,now=new Date()){
  const search=shouldSearch(text,history);return {search,topic:search?topicFrom(text,history):'',resolvedQuestion:search?rewriteSearch(text,history,now):clean(text,900),jst:jstJapanese(now)};
}
function wrap(response){const headers=new Headers(response.headers);headers.set('x-talksys-revision',REVISION);headers.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health'){
      return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:'@cf/zai-org/glm-5.3-flash',sttModel:STT_MODEL,sttPrompt:false,sttHallucinationGuard:true,sttSignalGate:true,ttsModel:'browser/speechSynthesis',ttsLanguage:'ja-JP',ttsVoice:'stable-ja-preferred',serverTtsEnabled:false,searchContextRewrite:true,genericSearchFallback:true,searchAnnouncements:true,searchTrace:true,bargeIn:true,falseBargeResume:true,serverTimeJst:jstJapanese(),legacyWebSocketVoice:false,durableObjectVoice:false});
    }
    if(request.method==='GET'&&['/talk-v37.js','/talk-v36.js'].includes(url.pathname))return new Response(TALK_CLIENT_V37,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV36.fetch(request,env);const html=(await base.text()).replace('/talk-v36.js','/talk-v37.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/transcribe')return transcribeHardened(request,env);
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.json();}catch{return json({ok:false,error:'invalid json'},400);}const history=historyOf(body?.history);return json({ok:true,...buildPlan(body?.text,history)});
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1200),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      if(TRACE_RE.test(text)){const answer=traceAnswer(body?.searchTrace);if(answer)return json({ok:true,answer,search:false,route:'search-trace-v37',searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local'});}
      if(CLOCK_RE.test(text))return json({ok:true,answer:`現在の日本時間は${jstJapanese()}です。`,search:false,route:'server-jst-clock',searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local'});
      if(DATE_RE.test(text))return json({ok:true,answer:`今日は${jstJapanese()}です。`,search:false,route:'server-jst-date',searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local'});
      const plan=buildPlan(text,history);
      if(plan.search){
        const rewritten=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,text:plan.resolvedQuestion})});
        // v37 already resolved the conversational intent. Search through v34 directly so v36 cannot rewrite it a second time.
        return wrap(await workerV34.fetch(rewritten,env));
      }
    }
    return wrap(await workerV36.fetch(request,env));
  }
};

export const __test={jstParts,jstJapanese,stationPair,findStationPair,traceAnswer,topicFrom,shouldSearch,rewriteSearch,buildPlan,analyzeWav,weakSpeechSignal,isLikelySttHallucination};
