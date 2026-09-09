import workerV42 from './worker-v42.js';
import { collectResilientEvidenceV42 } from './search-v42.js';
import { persistTalkLog } from './log-v42.js';

const REVISION='talksys-v42-search-judgment-persistent-logs';
const MODEL='@cf/zai-org/glm-5.3-flash';
const PHONE_RE=/(スマホ|スマートフォン|携帯|Android|アンドロイド|iPhone|Xperia|エクスペリア|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|Redmi)/i;
const REPAIR_OR_REPLACE_RE=/(修理|買い替え|買替|乗り換え|乗換|背面.{0,8}割|画面.{0,8}割|割れ|壊れ|故障|終わってしま|中古.{0,16}(?:安い|乗り換え|乗換)|(?:安い|中古).{0,16}(?:スマホ|携帯))/i;
const LOOKUP_RE=/(調べ|検索|探して|探せ|見つけ|在庫|実売|価格|値段|相場|いくら|どこで買|販売店|店舗|通販|具体的な機種|候補.{0,8}機種|機種.{0,8}候補|おすすめ.{0,8}(?:スマホ|携帯|機種)|最新|現在)/i;
const RETRY_RE=/(もうちょっと|もう少し|もっと|再度|もう一度|引き続き|詳しく|ちゃんと).*?(?:調べ|探|検索|確認)|(?:調べ|探|検索).*?(?:直して|続けて|もっと)/i;
const GIVEUP_RE=/(申し訳ありません.{0,80}(?:確認|情報|検索)|具体的な.{0,40}(?:ご案内|提案).{0,20}できません|自分で.{0,20}(?:検索|確認)|(?:店舗|通販サイト|商品ページ)で.{0,30}(?:検索|確認)して(?:ください|みて))/i;

function clean(v,max=9000){return String(v??'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-16).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1800)})).filter(x=>x.content):[];}
function userHistory(v){return historyOf(v).filter(x=>x.role==='user');}
function userText(v){return userHistory(v).map(x=>x.content).join(' ');}
function phoneContext(text,history=[]){return PHONE_RE.test(clean(`${userText(history)} ${text}`,6500));}
function budgetQualified(text){return /(?:[0-9０-９]{1,3}\s*万\s*円?|[0-9０-９]{4,6}\s*円)\s*(?:以下|以内|まで)/.test(clean(text,1800));}
function explicitLookup(text,history=[]){return phoneContext(text,history)&&(LOOKUP_RE.test(text)||RETRY_RE.test(text)||budgetQualified(text));}
function localDecision(text,history=[]){return phoneContext(text,history)&&REPAIR_OR_REPLACE_RE.test(clean(`${userText(history)} ${text}`,6500))&&!explicitLookup(text,history);}
function budgetFrom(text,history=[]){const all=clean(`${userText(history)} ${text}`,6500);let m=all.match(/([0-9０-９]{1,3})\s*万\s*円?\s*(以下|以内|まで)/);if(m)return `${m[1]}万円${m[2]}`;m=all.match(/([0-9０-９]{4,6})\s*円\s*(以下|以内|まで)/);return m?`${m[1]}円${m[2]}`:'';}
function flags(text,history=[]){const all=clean(`${userText(history)} ${text}`,6500);return {budget:budgetFrom(text,history),used:/中古/.test(all),newPhone:/新品/.test(all),androidOld:/(Android|アンドロイド).{0,24}(?:古い|古く|バージョン.{0,12}古)|(?:古い|古く).{0,24}(?:Android|アンドロイド)/i.test(all),simFree:/(SIM\s*フリー|シムフリー)/i.test(all),warranty:/(保証|返品|交換)/i.test(all)};}
function generalPlan(text){return {ok:true,search:false,topic:'',resolvedQuestion:clean(text,1500),searchInstruction:'',ack:'',planner:'device-decision-local-v42',plannerMs:0,jst:''};}
function searchPlan(text,history=[]){
  const f=flags(text,history),parts=[];
  if(f.budget)parts.push(f.budget);if(f.used)parts.push('中古');if(f.newPhone)parts.push('新品');parts.push('スマホ');
  const subject=parts.join('');
  const inst=[`${subject}について、現在販売を確認できる具体的な機種名と実売価格を販売元の情報から調べる。`];
  if(f.androidOld)inst.push('Androidが古いことが買い替え理由なので、候補ごとにAndroid/OS更新またはセキュリティサポートの根拠も確認し、価格だけで推薦しない。');
  if(f.simFree)inst.push('利用者がSIMフリーを条件にしているため、その条件も確認する。');
  if(f.warranty)inst.push('利用者が保証を条件にしているため、その条件も確認する。');
  inst.push('利用者が言っていないAndroid 13、SIMフリー、保証付き等を勝手に必須条件へ追加しない。情報が薄い場合は検索語と候補を変えて継続する。');
  return {ok:true,search:true,topic:subject,resolvedQuestion:`${subject}の具体的な購入候補と現在の実売情報を知りたい。`,searchInstruction:inst.join(''),ack:RETRY_RE.test(text)?'もう少し広く探します。':'候補を探します。',planner:'phone-shopping-local-v42',plannerMs:0,jst:''};
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function schedule(ctx,env,input){const p=persistTalkLog(env,{...input,revision:REVISION});if(ctx?.waitUntil)ctx.waitUntil(p);else p.catch(()=>{});}
function extractText(result){if(typeof result==='string')return clean(result);if(!result)return '';for(const v of [result.response,result.result,result.text,result.output_text])if(typeof v==='string'&&v.trim())return clean(v);const c=result.choices?.[0]?.message?.content;if(typeof c==='string')return clean(c);if(Array.isArray(c))return clean(c.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''));return clean(result.choices?.[0]?.text||'');}
async function glm(env,messages,max=440){const t=Date.now();const r=await env.AI.run(MODEL,{messages,stream:false,modalities:['text'],max_completion_tokens:max,temperature:0.12,reasoning_effort:'low'});const text=extractText(r);if(!text)throw new Error('empty model answer');return {text,ms:Date.now()-t};}
const GENERAL_PROMPT=`あなたはTalkSysの日本語電話相談AIです。Web検索を使わず、利用者自身が述べた事実と安定した一般原則だけで判断してください。修理か買い替えかなら、購入額、故障部位、使用期間、重要データの有無、現在使えるかを材料に、どちら寄りかを最初に示してください。未検索の修理料金、中古相場、保証、下取り額は作らないでください。「それは大変でしたね」「まず見積もりを」だけで終わらせず、判断理由を2〜4文で自然に答えてください。`;
const SEARCH_PROMPT=`あなたはTalkSysの日本語電話相談AIです。取得済み検索根拠だけで意思決定に役立つ回答を作ってください。「申し訳ありません、確認できませんでした」「具体的な機種は案内できません」「自分で検索してください」のような検索失敗定型文で終わらせず、確認できた有用な事実を先に答えてください。利用者が言っていないAndroid 13、SIMフリー、保証付き等を必須条件に追加しないでください。買い替え理由がAndroidの古さなら、価格と同じ候補についてOS更新・サポート根拠が確認できたものを優先し、発売年だけで推測しないでください。根拠にない価格・在庫・修理代・保証・OSバージョンは作らないでください。3〜6文で、URLや内部検索回数は読み上げないでください。`;
function evidenceBlock(s){return (s?.sources||[]).slice(0,14).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}
async function localTurn(body,env){
  const started=Date.now(),text=clean(body?.text,2000),hist=userHistory(body?.history);const g=await glm(env,[{role:'system',content:GENERAL_PROMPT},...hist,{role:'user',content:text}],300);
  return {ok:true,answer:g.text,search:false,route:'device-decision-v42',searchUseful:false,resolvedQuestion:text,queries:[],sources:[],timings:{totalMs:Date.now()-started,searchMs:0,glmMs:g.ms},model:MODEL,planner:'device-decision-local-v42',languageMode:'ja-only'};
}
async function searchTurn(body,plan,env){
  const started=Date.now(),hist=historyOf(body?.history),resolved=clean(plan?.resolvedQuestion,1800)||clean(body?.text,1800),instruction=clean(plan?.searchInstruction,3000);const t=Date.now();const s=await collectResilientEvidenceV42(resolved,hist,instruction);const searchMs=Date.now()-t;const verified=Array.isArray(s?.verifiedCandidates)?s.verifiedCandidates:[];
  const prompt=`相談: ${resolved}\n利用者が明示した検索条件: ${instruction}\nverifiedCandidates: ${JSON.stringify(verified)}\n\n取得根拠:\n${evidenceBlock(s)||'(根拠なし)'}\n\n利用者の質問へ直接答えてください。`;
  let g=await glm(env,[{role:'system',content:SEARCH_PROMPT},...hist,{role:'user',content:prompt}],520);
  if(GIVEUP_RE.test(g.text))g=await glm(env,[{role:'system',content:SEARCH_PROMPT+' 前の草案が検索失敗の定型文に逃げました。謝罪や自己検索依頼を削除し、取得できた事実を先にした完成回答だけを書いてください。'},...hist,{role:'user',content:prompt}],480);
  return {ok:true,answer:g.text,search:true,route:'resilient-search-v42',searchUseful:Boolean(s?.sources?.length),resolvedQuestion:s?.resolvedQuestion||resolved,queries:(s?.queries||[]).slice(0,24),sources:(s?.sources||[]).slice(0,14).map(x=>({title:clean(x?.title,220),url:clean(x?.url,700)})),searchPasses:Number(s?.searchPasses)||1,maxSearchPasses:Number(s?.maxSearchPasses)||5,concreteShoppingEvidence:Boolean(s?.concreteShoppingEvidence),androidFreshnessRequired:Boolean(s?.androidFreshnessRequired),androidRequirementEvidence:Boolean(s?.androidRequirementEvidence),verifiedCandidates:verified,sourceQuality:s?.sourceQuality||'',timings:{totalMs:Date.now()-started,searchMs,glmMs:g.ms,plannerMs:Number(plan?.plannerMs)||0},model:MODEL,planner:'phone-shopping-local-v42',searchPlan:instruction,languageMode:'ja-only'};
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1800),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      if(explicitLookup(text,history)){const data=searchPlan(text,history);schedule(ctx,env,{request,body,result:data,event:'plan',status:200});return json(data);}
      if(localDecision(text,history)){const data=generalPlan(text);schedule(ctx,env,{request,body,result:data,event:'plan',status:200});return json(data);}
      return workerV42.fetch(request,env,ctx);
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,2000),history=historyOf(body?.history);if(!text)return json({ok:false,error:'text required'},400);
      try{
        if(explicitLookup(text,history)||body?.searchPlan?.planner==='phone-shopping-local-v42'){const plan=body?.searchPlan?.planner==='phone-shopping-local-v42'?body.searchPlan:searchPlan(text,history);const data=await searchTurn(body,plan,env);schedule(ctx,env,{request,body:{...body,searchPlan:plan},result:data,event:'turn',status:200});return json(data);}
        if(localDecision(text,history)||body?.searchPlan?.planner==='device-decision-local-v42'){const plan=generalPlan(text),data=await localTurn(body,env);schedule(ctx,env,{request,body:{...body,searchPlan:plan},result:data,event:'turn',status:200});return json(data);}
      }catch(error){const data={ok:false,error:clean(error?.message||error,1200),route:'v42-hotfix-intercept-error'};schedule(ctx,env,{request,body,result:data,event:'turn-error',status:500});return json(data,500);}
      return workerV42.fetch(request,env,ctx);
    }
    return workerV42.fetch(request,env,ctx);
  }
};

export const __test={explicitLookup,localDecision,searchPlan,generalPlan,flags};
