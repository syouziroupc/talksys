import workerV41 from './worker-v41.js';
import { TALK_CLIENT_V42 } from './talk-client-v42.js';
import { collectResilientEvidenceV42 } from './search-v42.js';
import { persistTalkLog, sessionIdFrom } from './log-v42.js';

const REVISION='talksys-v42-search-judgment-persistent-logs';
const MODEL='@cf/zai-org/glm-5.3-flash';
const PHONE_RE=/(スマホ|スマートフォン|携帯|Android|iPhone|Xperia|エクスペリア|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|Redmi)/i;
const REPAIR_RE=/(修理|買い替え|買替|乗り換え|乗換|背面.{0,6}割|画面.{0,6}割|割れ|壊れ|故障|終わってしま)/i;
const EXPLICIT_LOOKUP_RE=/(調べ|検索|探して|探せ|見つけ|在庫|実売|価格|値段|相場|いくら|どこで買|販売店|店舗|通販|具体的な機種|候補.{0,8}機種|機種.{0,8}候補|おすすめ.{0,8}(?:スマホ|携帯|機種)|最新|現在)/i;
const RETRY_RE=/(もうちょっと|もう少し|もっと|再度|もう一度|引き続き|詳しく|ちゃんと).*?(?:調べ|探|検索|確認)|(?:調べ|探|検索).*?(?:直して|続けて|もっと)/i;
const GIVEUP_RE=/(申し訳ありません.{0,80}(?:確認|情報|検索)|具体的な.{0,40}(?:ご案内|提案).{0,20}できません|自分で.{0,20}(?:検索|確認)|(?:店舗|通販サイト|商品ページ)で.{0,30}(?:検索|確認)して(?:ください|みて))/i;

function clean(v,max=9000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-16).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1800)})).filter(x=>x.content):[];}
function historyText(v){return historyOf(v).map(x=>x.content).join(' ');}
function userHistoryText(v){return historyOf(v).filter(x=>x.role==='user').map(x=>x.content).join(' ');}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function wrap(response){const h=new Headers(response.headers);h.set('x-talksys-revision',REVISION);h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function extractText(result){if(typeof result==='string')return clean(result);if(!result)return '';for(const v of [result.response,result.result,result.text,result.output_text])if(typeof v==='string'&&v.trim())return clean(v);const c=result.choices?.[0]?.message?.content;if(typeof c==='string')return clean(c);if(Array.isArray(c))return clean(c.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''));return clean(result.choices?.[0]?.text||'');}
function scheduleLog(ctx,env,input){const p=persistTalkLog(env,{...input,revision:REVISION});if(ctx?.waitUntil)ctx.waitUntil(p);else p.catch(()=>{});}
function scheduleResponseLog(ctx,env,request,body,response,event,extra={}){const p=(async()=>{let result=null;try{result=await response.clone().json();}catch{result={ok:response.ok,error:response.ok?'':'non-json response'};}await persistTalkLog(env,{request,body,result,event,status:response.status,revision:REVISION,extra});})();if(ctx?.waitUntil)ctx.waitUntil(p);else p.catch(()=>{});}
function phoneContext(text,history=[]){return PHONE_RE.test(clean(`${historyText(history)} ${text}`,6000));}
function budgetFrom(text,history=[]){const v=clean(`${userHistoryText(history)} ${text}`,6000);let m=v.match(/([0-9０-９]{1,3})\s*万\s*円?\s*(以下|以内|まで)/);if(m)return `${m[1]}万円${m[2]}`;m=v.match(/([0-9０-９]{4,6})\s*円\s*(以下|以内|まで)/);return m?`${m[1]}円${m[2]}`:'';}
function hasBudgetPhoneLookup(text,history=[]){const v=clean(text,1400),all=clean(`${historyText(history)} ${text}`,5000);return PHONE_RE.test(all)&&/(?:[0-9０-９]{1,3}\s*万\s*円?|[0-9０-９]{4,6}\s*円)\s*(?:以下|以内|まで)/.test(v);}
function isExplicitPhoneLookup(text,history=[]){return phoneContext(text,history)&&(EXPLICIT_LOOKUP_RE.test(text)||RETRY_RE.test(text)||hasBudgetPhoneLookup(text,history));}
function isGeneralPhoneDecision(text,history=[]){return phoneContext(text,history)&&REPAIR_RE.test(clean(`${historyText(history)} ${text}`,5500))&&!isExplicitPhoneLookup(text,history);}
function userConstraintFlags(text,history=[]){
  const all=clean(`${userHistoryText(history)} ${text}`,6500);
  return {budget:budgetFrom(text,history),used:/(中古)/i.test(all),newPhone:/(新品)/i.test(all),androidOld:/(Android|アンドロイド).{0,22}(?:古い|古く|バージョン.{0,12}古)|(?:古い|古く).{0,22}(?:Android|アンドロイド)/i.test(all),simFree:/(SIM\s*フリー|シムフリー)/i.test(all),warranty:/(保証|返品|交換)/i.test(all)};
}
function makePhoneSearchPlan(text,history=[]){
  const f=userConstraintFlags(text,history),retry=RETRY_RE.test(text),parts=[];
  if(f.budget)parts.push(f.budget);if(f.used)parts.push('中古');if(f.newPhone)parts.push('新品');parts.push('スマホ');
  const resolved=`${parts.join('')}の具体的な購入候補と現在の実売情報を知りたい。`;
  const instructions=[`${parts.join('')}について、現在販売を確認できる具体的な機種名と実売価格を販売元の情報から調べる。`];
  if(f.androidOld)instructions.push('Androidが古いことが買い替え理由なので、候補ごとにAndroid/OS更新またはセキュリティサポートの根拠も確認し、価格だけで推薦しない。');
  if(f.simFree)instructions.push('利用者がSIMフリーを条件にしているため、その条件も確認する。');
  if(f.warranty)instructions.push('利用者が保証を条件にしているため、その条件も確認する。');
  instructions.push('利用者が言っていないAndroid 13、SIMフリー、保証付き等を勝手に必須条件へ追加しない。情報が薄い場合は検索語と候補を変えて継続する。');
  return {ok:true,search:true,topic:clean(parts.join(''),120),resolvedQuestion:resolved,searchInstruction:instructions.join(''),ack:retry?'もう少し広く探します。':'候補を探します。',planner:'phone-shopping-local-v42',plannerMs:0,jst:''};
}
function generalPlan(text){return {ok:true,search:false,topic:'',resolvedQuestion:clean(text,1500),searchInstruction:'',ack:'',planner:'device-decision-local-v42',plannerMs:0,jst:''};}
async function runGlm(env,messages,max=360){const started=Date.now();const result=await env.AI.run(MODEL,{messages,stream:false,modalities:['text'],max_completion_tokens:max,temperature:0.12,reasoning_effort:'low'});const text=extractText(result);if(!text)throw new Error('empty model answer');return {text,elapsedMs:Date.now()-started};}

const GENERAL_DEVICE_PROMPT=`あなたはTalkSysの日本語電話相談AIです。今はWeb検索を使わず、利用者が会話で明示した事実と一般的に安定した判断原則だけで答えてください。\nスマホの故障で「修理か買い替えか」を相談されたら、曖昧に両論併記するだけで終わらず、購入額、故障部位、使用期間、大事なデータの有無、現在使えるかなど与えられた条件から、どちら寄りかを最初に示してください。\n検索していない修理料金、現在の中古相場、店舗保証、下取り額など変動する金額や事実を作らないでください。利用者が自分で言った購入額は使って構いません。\n「それは大変でしたね」「まずは修理店で見積もりを」のような定型文だけで終わらせず、実際の判断に役立つ理由を述べてください。質問が必要なら最後に1つまで。通常2〜4文、自然な話し言葉で答えてください。`;
const SEARCH_PROMPT=`あなたはTalkSysの日本語電話相談AIです。取得済みの検索根拠から、利用者の意思決定に役立つ答えを作ってください。\n最重要: 「申し訳ありません、確認できませんでした」「具体的な機種をご案内できません」「自分で検索してください」のような検索失敗の前置きで終わらせないでください。確認できた有用な事実を先に答えます。\nユーザーが言っていない条件を追加しないでください。特にAndroid 13、SIMフリー、保証付きなどを勝手な必須条件にしません。\n商品候補は、価格を販売元で確認し、買い替え理由がOSの古さなら同じ候補についてOS更新・サポートの根拠も確認できたものを優先してください。発売年が新しいだけで「OSも新しいからおすすめ」と推測しないでください。\nverifiedCandidates がある場合はそれを最優先して具体的に勧めます。verifiedCandidates が空なら、価格だけ確認できた候補をOS面まで確認済みのようには勧めず、確認済みの価格情報と、なぜ推薦確定を保留するかを短く説明してください。ただし利用者へ調査を丸投げせず、次に重視すべき条件までこちらから示してください。\n根拠にない価格・在庫・修理代・保証内容・OSバージョンは作らないでください。通常3〜6文。URL、Markdown、内部の検索回数やモデル名は読み上げません。`;

async function generalDeviceTurn(body,env){
  const started=Date.now(),history=historyOf(body?.history),text=clean(body?.text,2000);const generated=await runGlm(env,[{role:'system',content:GENERAL_DEVICE_PROMPT},...history,{role:'user',content:text}],300);
  return {ok:true,answer:generated.text,search:false,route:'device-decision-v42',searchUseful:false,resolvedQuestion:text,queries:[],sources:[],timings:{totalMs:Date.now()-started,searchMs:0,glmMs:generated.elapsedMs},model:MODEL,planner:'device-decision-local-v42',languageMode:'ja-only'};
}
function evidenceBlock(search){return (search?.sources||[]).slice(0,14).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}
async function phoneSearchTurn(body,plan,env){
  const started=Date.now(),history=historyOf(body?.history),text=clean(body?.text,1800),resolved=clean(plan?.resolvedQuestion,1800)||text,instruction=clean(plan?.searchInstruction,3000);
  const s=Date.now();const search=await collectResilientEvidenceV42(resolved,history,instruction);const searchMs=Date.now()-s;
  const verified=Array.isArray(search?.verifiedCandidates)?search.verifiedCandidates:[];
  const prompt=`相談: ${resolved}\n利用者が明示した検索条件: ${instruction}\nverifiedCandidates: ${JSON.stringify(verified)}\n\n取得根拠:\n${evidenceBlock(search)||'(根拠なし)'}\n\n利用者の質問へ直接答えてください。`;
  let generated=await runGlm(env,[{role:'system',content:SEARCH_PROMPT},...history,{role:'user',content:prompt}],520);
  if(GIVEUP_RE.test(generated.text))generated=await runGlm(env,[{role:'system',content:SEARCH_PROMPT+'\n前の草案が検索失敗の定型文に逃げました。謝罪や自己検索の依頼を削除し、取得できた事実を先にした完成回答だけを書いてください。'},...history,{role:'user',content:prompt}],480);
  return {ok:true,answer:generated.text,search:true,route:'resilient-search-v42',searchUseful:Boolean(search?.sources?.length),resolvedQuestion:search?.resolvedQuestion||resolved,queries:(search?.queries||[]).slice(0,24),sources:(search?.sources||[]).slice(0,14).map(x=>({title:clean(x?.title,220),url:clean(x?.url,700)})),searchPasses:Number(search?.searchPasses)||1,maxSearchPasses:Number(search?.maxSearchPasses)||5,concreteShoppingEvidence:Boolean(search?.concreteShoppingEvidence),androidFreshnessRequired:Boolean(search?.androidFreshnessRequired),androidRequirementEvidence:Boolean(search?.androidRequirementEvidence),verifiedCandidates:verified,sourceQuality:search?.sourceQuality||'',timings:{totalMs:Date.now()-started,searchMs,glmMs:generated.elapsedMs,plannerMs:Number(plan?.plannerMs)||0},model:MODEL,planner:plan?.planner||'phone-shopping-local-v42',searchPlan:instruction,languageMode:'ja-only'};
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:MODEL,languageMode:'ja-only',searchJudgment:'general-advice-local-current-lookup-search',searchMode:'escalating-up-to-five-pass',maxSearchPasses:5,searchGiveupBoilerplateGuard:true,userConstraintOnlyPlanner:true,phoneModelSpecificOsEvidence:true,persistentConversationLogs:'d1-private',logBinding:'TALKSYS_LOG_DB',rawAudioLogged:false,workersObservability:true,sttModel:'@cf/openai/whisper-large-v3-turbo',ttsPrimary:'browser ja-JP',serverTtsEnabled:false,bargeIn:true,legacyWebSocketVoice:false,durableObjectVoice:false});
    if(request.method==='GET'&&['/talk-v42.js','/talk-v41.js','/talk-v40.js'].includes(url.pathname))return new Response(TALK_CLIENT_V42,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV41.fetch(request,env,ctx);const html=(await base.text()).replace('/talk-v41.js','/talk-v42.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/transcribe'){
      const response=wrap(await workerV41.fetch(request,env,ctx));scheduleResponseLog(ctx,env,request,{sessionId:request.headers.get('x-talksys-session')||sessionIdFrom(request,{})},response,'transcribe',{audioBytes:Number(request.headers.get('content-length'))||0});return response;
    }
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1800),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      if(isExplicitPhoneLookup(text,history)){const data=makePhoneSearchPlan(text,history),response=json(data);scheduleLog(ctx,env,{request,body,result:data,event:'plan',status:200});return response;}
      if(isGeneralPhoneDecision(text,history)){const data=generalPlan(text),response=json(data);scheduleLog(ctx,env,{request,body,result:data,event:'plan',status:200});return response;}
      const response=wrap(await workerV41.fetch(request,env,ctx));scheduleResponseLog(ctx,env,request,body,response,'plan');return response;
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,2000),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      try{
        if(isExplicitPhoneLookup(text,history)){const plan=(body?.searchPlan?.planner==='phone-shopping-local-v42')?body.searchPlan:makePhoneSearchPlan(text,history);const data=await phoneSearchTurn(body,plan,env),response=json(data);scheduleLog(ctx,env,{request,body:{...body,searchPlan:plan},result:data,event:'turn',status:200});return response;}
        if(isGeneralPhoneDecision(text,history)){const data=await generalDeviceTurn(body,env),response=json(data);scheduleLog(ctx,env,{request,body:{...body,searchPlan:generalPlan(text)},result:data,event:'turn',status:200});return response;}
      }catch(error){const err={ok:false,error:clean(error?.message||error,1200),route:'v42-intercept-error'},response=json(err,500);scheduleLog(ctx,env,{request,body,result:err,event:'turn-error',status:500});return response;}
      const response=wrap(await workerV41.fetch(request,env,ctx));scheduleResponseLog(ctx,env,request,body,response,'turn');return response;
    }
    return wrap(await workerV41.fetch(request,env,ctx));
  }
};

export const __test={budgetFrom,hasBudgetPhoneLookup,isExplicitPhoneLookup,isGeneralPhoneDecision,userConstraintFlags,makePhoneSearchPlan,generalPlan,GIVEUP_RE,userHistoryText};
