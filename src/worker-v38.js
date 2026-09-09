import workerV37 from './worker-v37.js';
import workerV34 from './worker-v34.js';
import workerV33 from './worker-v33.js';
import { TALK_CLIENT_V38 } from './talk-client-v38.js';

const REVISION='talksys-v38-history-search-tts-fallback';
const PLAN_MODEL='@cf/zai-org/glm-5.3-flash';
const CONTEXT_RE=/(もうちょっと|もう少し|もっと|それ|これ|さっき|前の|今の|安い|高い|予算|くらい|ぐらい|どれ|どこ|何がいい|おすすめ|[0-9０-９]+\s*(?:万|円)|[0-9０-９]+[〜～-][0-9０-９]+)/i;
const CASUAL_RE=/^(?:こんにちは|こんばんは|おはよう|もしもし|ありがとう(?:ございます)?|どうも|はい|うん|そう|なるほど)[。．!！?？\s]*$/u;

function clean(v,max=4000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-14).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1400)})).filter(x=>x.content):[];}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function wrap(response){const h=new Headers(response.headers);h.set('x-talksys-revision',REVISION);h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function extractText(result){
  if(typeof result==='string')return clean(result,6000);if(!result)return '';
  for(const value of [result.response,result.result,result.text,result.output_text])if(typeof value==='string'&&value.trim())return clean(value,6000);
  const content=result.choices?.[0]?.message?.content;if(typeof content==='string')return clean(content,6000);
  if(Array.isArray(content))return clean(content.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''),6000);
  return clean(result.choices?.[0]?.text||'',6000);
}
function parseJson(text){const v=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(v);}catch{}const m=v.match(/\{[\s\S]*\}/);if(!m)return null;try{return JSON.parse(m[0]);}catch{return null;}}
function jst(){return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date())+'（日本時間）';}
function ackFor(text){const v=clean(text,300);if(CASUAL_RE.test(v))return '';if(/相談|買い替え|買替/i.test(v))return 'はい、もちろんです。';if(/もう|もっと|安い|高い|予算|くらい|ぐらい/i.test(v))return 'なるほど。';if(/[?？]|どう|どれ|何|なに|どこ/i.test(v))return 'そうですね。';return '分かりました。';}

async function baselinePlan(text,history,env){
  const req=new Request('https://talksys.local/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,history})});
  try{const r=await workerV37.fetch(req,env);const j=await r.json();return j?.ok?j:{ok:true,search:false,topic:'',resolvedQuestion:clean(text,900)};}catch{return {ok:true,search:false,topic:'',resolvedQuestion:clean(text,900)};}
}

const PLANNER=`あなたはTalkSysの検索計画専用AIです。会話履歴と今回の発言を読み、検索が必要なら「今この利用者が本当に知りたいこと」を独立した検索条件へ変換してください。\n必ずJSONだけを返します。キーは search, topic, resolvedQuestion, searchInstruction, ack。\nsearch は真偽値。topic は画面表示用の短い名詞句。resolvedQuestion は今回の意図を履歴込みで1文に復元したもの。searchInstruction は検索エンジンへ渡す独立した具体的な日本語指示。ack は電話会話として自然な短い相槌です。\n重要ルール:\n- 最新の発言で変更された条件は過去条件より優先する。例: 「もうちょっと安い、3万4万」は直前のPC相談を3〜4万円予算へ更新する。\n- 「それ」「もう少し」「どれ」などは履歴から対象を復元する。直前の発言をそのまま再検索してはいけない。\n- 商品、価格、在庫、店舗、交通、ニュース、現在情報など外部の最新事実が必要なら search=true。一般的な相談だけなら false。\n- 商品検索では用途、予算、新品/中古の許容、必要性能など会話で判明した条件をsearchInstructionへ入れ、具体的な機種・実売価格・販売元・保証を確認するよう指示する。\n- 検索失敗の再試行では前回と同じ長文を繰り返さず、足りない事実を狙う。\n- 日時依存なら現在の日本時間を考慮する。\n- ack は毎回同じ「なるほど」に固定しない。長くても20文字程度。検索内容や内部処理はackで説明しない。`;

async function aiPlan(text,history,trace,env,base){
  const started=Date.now();
  const transcript=history.map(x=>`${x.role==='assistant'?'AI':'利用者'}: ${x.content}`).join('\n');
  const traceText=trace&&typeof trace==='object'?`\n直前検索: ${clean(trace.resolvedQuestion,300)}\n検索語: ${(Array.isArray(trace.queries)?trace.queries:[]).map(x=>clean(x,120)).join(' | ')}`:'';
  const prompt=`現在: ${jst()}\n\n会話履歴:\n${transcript||'(なし)'}\n\n今回の利用者発言:\n${clean(text,1200)}${traceText}\n\n参考: 既存判定では検索=${Boolean(base?.search)}。ただし履歴を読んだあなたの判断を優先してください。`;
  try{
    const result=await env.AI.run(PLAN_MODEL,{messages:[{role:'system',content:PLANNER},{role:'user',content:prompt}],stream:false,modalities:['text'],max_completion_tokens:260,temperature:0.08,reasoning_effort:'low'});
    const parsed=parseJson(extractText(result));
    if(!parsed||typeof parsed.search!=='boolean')throw new Error('invalid planner json');
    const search=Boolean(parsed.search);
    const resolvedQuestion=clean(parsed.resolvedQuestion,900)||clean(text,900);
    let instruction=clean(parsed.searchInstruction,1300);
    if(search&&!instruction)instruction=resolvedQuestion+'について、現在の正確な情報を複数の信頼できる情報源で検索して。';
    if(search&&!/(検索|調べ|確認)/.test(instruction))instruction+='。現在の情報を検索して確認して。';
    return {ok:true,search,topic:clean(parsed.topic,100)||(search?'必要な情報':''),resolvedQuestion,searchInstruction:search?instruction:'',ack:clean(parsed.ack,40)||ackFor(text),planner:'glm-history-v38',plannerMs:Date.now()-started,jst:jst()};
  }catch(error){
    return {...base,ok:true,ack:ackFor(text),searchInstruction:base?.search?clean(base.resolvedQuestion,1300):'',planner:'fallback-v37',plannerMs:Date.now()-started,plannerError:clean(error?.message||error,120)};
  }
}

async function makePlan(text,history,trace,env){
  const base=await baselinePlan(text,history,env);
  if(CASUAL_RE.test(clean(text,200)))return {...base,search:false,topic:'',resolvedQuestion:clean(text,900),searchInstruction:'',ack:'',planner:'local-casual-v38',plannerMs:0,jst:jst()};
  if(base.search||CONTEXT_RE.test(text))return aiPlan(text,history,trace,env,base);
  return {...base,ack:ackFor(text),searchInstruction:'',planner:'baseline-v38',plannerMs:0,jst:jst()};
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:'@cf/zai-org/glm-5.3-flash',searchPlannerModel:PLAN_MODEL,historyAwareSearchPlanner:true,searchPlanReuse:true,sttModel:'@cf/openai/whisper-large-v3-turbo',sttPrompt:false,sttHallucinationGuard:true,sttSignalGate:true,ttsPrimary:'browser/speechSynthesis ja-JP',ttsFallback:'@cf/myshell-ai/melotts',ttsFallbackEnabled:true,searchAnnouncements:true,backchannels:true,bargeIn:true,serverTimeJst:jst(),legacyWebSocketVoice:false,durableObjectVoice:false});
    if(request.method==='GET'&&['/talk-v38.js','/talk-v37.js','/talk-v36.js'].includes(url.pathname))return new Response(TALK_CLIENT_V38,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV37.fetch(request,env);const html=(await base.text()).replace('/talk-v37.js','/talk-v38.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/tts')return wrap(await workerV33.fetch(request,env));
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1200),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);return json(await makePlan(text,history,body?.searchTrace,env));
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1200),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      let plan=body?.searchPlan&&typeof body.searchPlan==='object'?body.searchPlan:null;
      if(!plan)plan=await makePlan(text,history,body?.searchTrace,env);
      if(plan?.search){
        const resolved=clean(plan.resolvedQuestion,900)||text;const instruction=clean(plan.searchInstruction,1300)||resolved+'について現在の正確な情報を検索して。';
        const searchText=`相談内容: ${resolved}\n検索条件: ${instruction}`;
        const rewritten=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,text:searchText})});
        const response=await workerV34.fetch(rewritten,env);
        try{
          const data=await response.json();return json({...data,resolvedQuestion:resolved,planner:plan.planner||'client-plan-v38',searchPlan:instruction,timings:{...(data?.timings||{}),plannerMs:Number(plan.plannerMs)||0}},response.status);
        }catch{return wrap(response);}
      }
      return wrap(await workerV37.fetch(request,env));
    }
    return wrap(await workerV37.fetch(request,env));
  }
};

export const __test={clean,historyOf,parseJson,ackFor};
