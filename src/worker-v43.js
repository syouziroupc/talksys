import workerV42 from './worker-v42-hotfix.js';
import { TALK_CLIENT_V43 } from './talk-client-v43.js';
import { collectResilientEvidenceV42 } from './search-v42.js';
import { persistTalkLog } from './log-v42.js';

const REVISION='talksys-v43-smoke-weather-adaptive-vad';
const MODEL='@cf/zai-org/glm-5.3-flash';
const WEATHER_RE=/(天気|天候|気温|降水|雨|晴|曇|雪|予報)/i;
const PC_RE=/(パソコン|PC|ノートパソコン|ノートPC|デスクトップ|Windows|MacBook|Chromebook)/i;
const PC_BUY_RE=/(買おう|買いたい|購入|欲しい|検討|悩ん|選び|買い替え|買替|何がいい)/i;
const PC_LOOKUP_RE=/(検索|調べ|探して|価格|値段|相場|在庫|店舗|お店|店を|販売店|どこで買|現在|最新|具体的な機種|おすすめ.{0,8}(?:機種|店)|安い.{0,8}(?:店|店舗|ショップ))/i;
const CAPABILITY_RE=/(?:検索|調べ).{0,18}(?:できる|出来る|使える|あるだろ|できるだろ|出来るだろ|できないの|出来ないの)|(?:できる|出来る|使える).{0,18}(?:検索|調べ)/i;
const NO_SEARCH_CAPABILITY_RE=/(?:この|当|今の)?(?:電話|通話|環境|仕組み).{0,28}(?:検索|Web検索).{0,28}(?:できない|できません|使えない|使えません)|(?:検索|Web検索).{0,18}(?:できない仕組み|利用できません|使えません)/i;
const GIVEUP_RE=/(申し訳ありません.{0,100}(?:確認|検索|情報)|(?:自分|ご自身).{0,30}(?:検索|確認)して(?:ください|みて)|(?:ホームページ|アプリ|商品ページ).{0,40}(?:確認|検索)して(?:ください|みて))/i;

function clean(v,max=8000){return String(v??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-16).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1800)})).filter(x=>x.content):[];}
function userHistory(v){return historyOf(v).filter(x=>x.role==='user');}
function userContext(text,history=[]){return clean(`${userHistory(history).map(x=>x.content).join(' ')} ${text}`,6500);}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function wrap(response){const h=new Headers(response.headers);h.set('x-talksys-revision',REVISION);h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function schedule(ctx,env,input){const p=persistTalkLog(env,{...input,revision:REVISION});if(ctx?.waitUntil)ctx.waitUntil(p);else p.catch(()=>{});}
function extractText(result){if(typeof result==='string')return clean(result);if(!result)return '';for(const v of [result.response,result.result,result.text,result.output_text])if(typeof v==='string'&&v.trim())return clean(v);const c=result.choices?.[0]?.message?.content;if(typeof c==='string')return clean(c);if(Array.isArray(c))return clean(c.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''));return clean(result.choices?.[0]?.text||'');}
async function glm(env,messages,max=360){const t=Date.now();const r=await env.AI.run(MODEL,{messages,stream:false,modalities:['text'],max_completion_tokens:max,temperature:0.08,reasoning_effort:'low'});const text=extractText(r);if(!text)throw new Error('empty model answer');return {text,ms:Date.now()-t};}

function isWeather(text,history=[]){return WEATHER_RE.test(clean(text,1200))||(/明日|明後日|今日/.test(text)&&WEATHER_RE.test(userContext(text,history)));}
function weatherOffset(text){const v=clean(text,1200);if(/明後日/.test(v))return 2;if(/明日/.test(v))return 1;return 0;}
function normalizeWeatherLocationText(text){
  let v=clean(text,1000);
  if(WEATHER_RE.test(v))v=v.replace(/別途/g,'別府');
  v=v.replace(/(?:今日|きょう|明日|あした|明後日|あさって)(?:の)?/g,' ')
    .replace(/(?:の)?(?:天気予報|天気|天候|気温|降水確率|降水|予報)/g,' ')
    .replace(/(?:を|は|って|について|教えて|知りたい|どう|どうですか|どうなる|お願いします|お願い|かな|ですか|でしょうか)/g,' ')
    .replace(/[?？!！、。]/g,' ')
    .replace(/\s+/g,' ').trim();
  return v;
}
function weatherLocation(text,history=[]){
  const now=normalizeWeatherLocationText(text);if(now&&now.length>=2)return now;
  const users=userHistory(history).slice().reverse();
  for(const row of users){const v=normalizeWeatherLocationText(row.content);if(v&&v.length>=2&&/(都|道|府|県|市|区|町|村|別府|東京|大阪|京都|札幌|福岡|大分)/.test(v))return v;}
  return '';
}
function weatherPlan(text,history=[]){const loc=weatherLocation(text,history),offset=weatherOffset(text),day=offset===2?'明後日':offset===1?'明日':'今日';return {ok:true,search:true,topic:`${loc||'指定地域'}の${day}の天気`,resolvedQuestion:`${loc||'指定地域'}の${day}の天気・最高気温・最低気温・降水確率を知りたい。`,searchInstruction:'気象データAPIから対象地域を特定し、対象日の予報値を直接取得する。',ack:'天気を確認します。',planner:'weather-direct-v43',plannerMs:0,jst:''};}
function pcContext(text,history=[]){return PC_RE.test(userContext(text,history));}
function pcLookup(text,history=[]){return pcContext(text,history)&&PC_LOOKUP_RE.test(clean(text,1600));}
function pcAdvice(text,history=[]){return pcContext(text,history)&&PC_BUY_RE.test(userContext(text,history))&&!pcLookup(text,history);}
function capabilityQuestion(text){return CAPABILITY_RE.test(clean(text,1200));}
function pcAdvicePlan(text){return {ok:true,search:false,topic:'PC購入相談',resolvedQuestion:clean(text,1500),searchInstruction:'',ack:'',planner:'pc-advice-local-v43',plannerMs:0,jst:''};}
function pcSearchPlan(text,history=[]){
  const users=userHistory(history).map(x=>x.content).slice(-6).join(' '),resolved=clean(`${users} ${text}`,1200);
  const local=/(県内|市内|近く|周辺|お店|店舗|店を|販売店|ショップ)/.test(resolved);
  return {ok:true,search:true,topic:'PC購入情報',resolvedQuestion:resolved,searchInstruction:local?'会話で明示された地域とPC条件を引き継ぎ、実在するPC販売店・取扱店を複数経路で検索し、店名とPC取扱いの根拠を確認する。存在しない店舗や未確認の価格を作らない。':'会話で明示された用途・予算・条件を引き継ぎ、現在購入できる具体的なPC候補、実売価格、販売元を検索する。未確認の価格や在庫を作らない。',ack:local?'近くの販売店を確認します。':'候補を確認します。',planner:'pc-search-v43',plannerMs:0,jst:''};
}
function capabilityPlan(text){return {ok:true,search:false,topic:'検索機能',resolvedQuestion:clean(text,1200),searchInstruction:'',ack:'',planner:'search-capability-local-v43',plannerMs:0,jst:''};}

const PC_ADVICE_PROMPT=`あなたはTalkSysの日本語電話相談AIです。パソコン購入の初期相談を扱います。このターンでは現在価格や在庫をまだ検索していません。利用者が言っていない金額、相場、現在の具体的な製品価格を作らないでください。TalkSysにはWeb検索機能があるので「この電話では検索できない」「検索機能がない」とは絶対に言わないでください。まず用途、予算、持ち運び、画面サイズなど意思決定に必要な条件を整理し、質問は最後に1つまでにしてください。必要な条件がそろえば、この会話内で具体的な機種・価格・販売店を検索できることは自然に案内して構いません。2〜4文の自然な日本語で答えてください。`;
const SEARCH_PROMPT=`あなたはTalkSysの日本語電話相談AIです。今回のターンではWeb検索済みです。取得した根拠だけで、利用者の質問へ具体的に答えてください。検索機能がない、検索できないとは絶対に言わないでください。確認できた店名・製品・価格などがあれば先に答え、根拠にない価格・在庫・住所・仕様を作らないでください。「自分で検索してください」「ホームページを確認してください」で調査を利用者へ押し戻さないでください。根拠が弱ければ、確認できた範囲と未確認点を短く分けてください。3〜6文、URLや内部検索回数は読み上げません。`;
const REPAIR_PROMPT=`あなたはTalkSysの回答補正器です。TalkSysにはWeb検索機能があります。元回答に「検索できない」「この電話では検索できない」など誤った能力説明があれば削除してください。利用者の質問への実質的な回答は保ちつつ、検索が必要な現在情報については「必要ならこの会話内で検索できる」と正しく案内してください。新しい価格・在庫・天気などの外部事実は作らないでください。自然な日本語の完成回答だけを返してください。`;
function evidenceBlock(s){return (s?.sources||[]).slice(0,14).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}
async function pcAdviceTurn(body,env){const started=Date.now(),hist=userHistory(body?.history),text=clean(body?.text,1800),g=await glm(env,[{role:'system',content:PC_ADVICE_PROMPT},...hist,{role:'user',content:text}],320);return {ok:true,answer:g.text,search:false,route:'pc-advice-v43',searchUseful:false,resolvedQuestion:text,queries:[],sources:[],timings:{totalMs:Date.now()-started,searchMs:0,glmMs:g.ms},model:MODEL,planner:'pc-advice-local-v43',languageMode:'ja-only'};}
async function pcSearchTurn(body,plan,env){const started=Date.now(),hist=userHistory(body?.history),resolved=clean(plan?.resolvedQuestion,1600)||clean(body?.text,1600),instruction=clean(plan?.searchInstruction,2400),t=Date.now(),s=await collectResilientEvidenceV42(resolved,hist,instruction),searchMs=Date.now()-t,prompt=`相談: ${resolved}\n検索条件: ${instruction}\n\n取得根拠:\n${evidenceBlock(s)||'(有効な根拠なし)'}\n\n利用者へ直接答えてください。`;const g=await glm(env,[{role:'system',content:SEARCH_PROMPT},...hist,{role:'user',content:prompt}],460);return {ok:true,answer:g.text,search:true,route:'pc-search-v43',searchUseful:Boolean(s?.sources?.length),resolvedQuestion:s?.resolvedQuestion||resolved,queries:(s?.queries||[]).slice(0,24),sources:(s?.sources||[]).slice(0,14).map(x=>({title:clean(x?.title,220),url:clean(x?.url,700)})),searchPasses:Number(s?.searchPasses)||1,maxSearchPasses:Number(s?.maxSearchPasses)||5,timings:{totalMs:Date.now()-started,searchMs,glmMs:g.ms},model:MODEL,planner:'pc-search-v43',searchPlan:instruction,languageMode:'ja-only'};}
function weatherCode(code){const m={0:'快晴',1:'晴れ',2:'一部くもり',3:'くもり',45:'霧',48:'着氷性の霧',51:'弱い霧雨',53:'霧雨',55:'強い霧雨',61:'弱い雨',63:'雨',65:'強い雨',71:'弱い雪',73:'雪',75:'強い雪',80:'弱いにわか雨',81:'にわか雨',82:'強いにわか雨',85:'弱いにわか雪',86:'強いにわか雪',95:'雷雨',96:'ひょうを伴う雷雨',99:'強いひょうを伴う雷雨'};return m[Number(code)]||'天気変化';}
function jstDate(offset=0){const d=new Date(Date.now()+offset*86400000);return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
async function geocodeLocation(query){
  const attempts=[query,query.replace(/^(.*?[都道府県])/,''),query.replace(/[市区町村]$/,'')].filter((x,i,a)=>x&&a.indexOf(x)===i);
  for(const q of attempts){const u=`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=ja&format=json&countryCode=JP`;const r=await fetch(u,{headers:{'user-agent':'TalkSys/43'}});if(!r.ok)continue;const j=await r.json();const rows=Array.isArray(j?.results)?j.results:[];if(rows.length){const best=rows.find(x=>clean(`${x.name||''}${x.admin1||''}${x.admin2||''}`,200).includes(q.replace(/[都道府県市区町村]/g,'')))||rows[0];return {row:best,url:u};}}
  return null;
}
async function weatherTurn(body,env){
  const started=Date.now(),text=clean(body?.text,1600),hist=userHistory(body?.history),loc=weatherLocation(text,hist),offset=weatherOffset(text),day=offset===2?'明後日':offset===1?'明日':'今日';
  if(!loc)return {ok:true,answer:'天気を調べる地域がまだ特定できません。「大分県別府市」のように市区町村まで教えてください。',search:false,route:'weather-location-needed-v43',searchUseful:false,resolvedQuestion:text,queries:[],sources:[],timings:{totalMs:Date.now()-started,searchMs:0,glmMs:0},model:'local',planner:'weather-direct-v43',languageMode:'ja-only'};
  const t=Date.now(),geo=await geocodeLocation(loc);if(!geo)throw new Error(`weather location not found: ${loc}`);const p=geo.row;const forecastUrl=`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(p.latitude)}&longitude=${encodeURIComponent(p.longitude)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=4`;const fr=await fetch(forecastUrl,{headers:{'user-agent':'TalkSys/43'}});if(!fr.ok)throw new Error(`weather forecast HTTP ${fr.status}`);const f=await fr.json(),target=jstDate(offset),times=f?.daily?.time||[],idx=times.indexOf(target);if(idx<0)throw new Error(`weather target date missing: ${target}`);const code=f.daily.weather_code?.[idx],hi=f.daily.temperature_2m_max?.[idx],lo=f.daily.temperature_2m_min?.[idx],rain=f.daily.precipitation_probability_max?.[idx],name=clean(`${p.admin1||''}${p.name||loc}`,120);const parts=[`${name}の${day}は${weatherCode(code)}の予報です。`];if(Number.isFinite(Number(hi))&&Number.isFinite(Number(lo)))parts.push(`最高気温は${Math.round(Number(hi))}度、最低気温は${Math.round(Number(lo))}度です。`);if(Number.isFinite(Number(rain)))parts.push(`降水確率の最大値は${Math.round(Number(rain))}%です。`);return {ok:true,answer:parts.join(''),search:true,route:'weather-direct-v43',searchUseful:true,resolvedQuestion:`${name}の${day}の天気`,queries:[`Open-Meteo geocoding: ${loc}`,`Open-Meteo forecast: ${name} ${target}`],sources:[{title:'Open-Meteo Geocoding API',url:geo.url},{title:'Open-Meteo Forecast API',url:forecastUrl}],searchPasses:1,maxSearchPasses:1,sourceQuality:'direct-weather-api-v43',timings:{totalMs:Date.now()-started,searchMs:Date.now()-t,glmMs:0},model:'direct-api',planner:'weather-direct-v43',languageMode:'ja-only'};
}
async function repairDenial(body,data,env){if(!data?.ok||typeof data.answer!=='string'||!NO_SEARCH_CAPABILITY_RE.test(data.answer))return data;const hist=userHistory(body?.history),g=await glm(env,[{role:'system',content:REPAIR_PROMPT},...hist,{role:'user',content:`利用者: ${clean(body?.text,1600)}\n元回答: ${clean(data.answer,3000)}`}],320);return {...data,answer:g.text,route:`${data.route||'fallback'}-capability-repaired-v43`,capabilityRepair:true};}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:MODEL,languageMode:'ja-only',searchCapabilityGuard:true,pcAdviceNoInventedPrice:true,pcSearchExplicit:true,weatherDirect:'open-meteo',weatherBeppuSttRepair:true,preDeploySmokeGate:true,adaptiveNoiseVad:true,adaptiveNoiseCalibration:true,adaptiveFalseTriggerPenalty:true,persistentConversationLogs:'d1-private',rawAudioLogged:false,sttModel:'@cf/openai/whisper-large-v3-turbo',ttsPrimary:'browser ja-JP',serverTtsEnabled:false,bargeIn:true,legacyWebSocketVoice:false,durableObjectVoice:false});
    if(request.method==='GET'&&['/talk-v43.js','/talk-v42.js'].includes(url.pathname))return new Response(TALK_CLIENT_V43,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){const base=await workerV42.fetch(request,env,ctx),html=(await base.text()).replace('/talk-v42.js','/talk-v43.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1800),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      let data=null;if(isWeather(text,history))data=weatherPlan(text,history);else if(capabilityQuestion(text))data=capabilityPlan(text);else if(pcLookup(text,history))data=pcSearchPlan(text,history);else if(pcAdvice(text,history))data=pcAdvicePlan(text);
      if(data){schedule(ctx,env,{request,body,result:data,event:'plan',status:200});return json(data);}
      return wrap(await workerV42.fetch(request,env,ctx));
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1800),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      try{
        let data=null;
        if(isWeather(text,history)||body?.searchPlan?.planner==='weather-direct-v43')data=await weatherTurn(body,env);
        else if(capabilityQuestion(text)||body?.searchPlan?.planner==='search-capability-local-v43')data={ok:true,answer:'検索できます。直前に「この電話では検索できない」と案内していたなら、その説明は誤りです。必要なときは、この会話内でWeb検索して価格・在庫・天気・交通などの現在情報を確認できます。',search:false,route:'search-capability-v43',searchUseful:false,resolvedQuestion:text,queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local',planner:'search-capability-local-v43',languageMode:'ja-only'};
        else if(body?.searchPlan?.planner==='pc-search-v43'||pcLookup(text,history))data=await pcSearchTurn(body,body?.searchPlan?.planner==='pc-search-v43'?body.searchPlan:pcSearchPlan(text,history),env);
        else if(body?.searchPlan?.planner==='pc-advice-local-v43'||pcAdvice(text,history))data=await pcAdviceTurn(body,env);
        if(data){schedule(ctx,env,{request,body,result:data,event:'turn',status:200});return json(data);}
      }catch(error){const err={ok:false,error:clean(error?.message||error,1200),route:'v43-intercept-error'};schedule(ctx,env,{request,body,result:err,event:'turn-error',status:500});return json(err,500);}
      const response=await workerV42.fetch(request,env,ctx),type=response.headers.get('content-type')||'';if(!type.includes('application/json'))return wrap(response);
      try{let data=await response.json();data=await repairDenial(body,data,env);if(data?.capabilityRepair)schedule(ctx,env,{request,body,result:data,event:'turn-repair',status:response.status});return json(data,response.status);}catch{return wrap(response);}
    }
    return wrap(await workerV42.fetch(request,env,ctx));
  }
};

export const __test={isWeather,weatherOffset,normalizeWeatherLocationText,weatherLocation,weatherPlan,pcContext,pcLookup,pcAdvice,pcSearchPlan,capabilityQuestion,NO_SEARCH_CAPABILITY_RE,GIVEUP_RE};
