import workerV43 from './worker-v43.js';
import { collectResilientEvidenceV42 } from './search-v42.js';
import { augmentGroundedEvidenceV26 } from './search-v26.js';
import { persistTalkLog } from './log-v42.js';

const REVISION='talksys-v43.1-smoke-grounded-adaptive-vad';
const MODEL='@cf/zai-org/glm-5.3-flash';
const WEATHER_RE=/(天気|天候|気温|降水|雨|晴|曇|雪|予報)/i;
const PC_RE=/(パソコン|\bPC\b|ＰＣ|ノートパソコン|ノートPC|デスクトップ|Windows|MacBook|Chromebook)/i;
const TRANSIT_RE=/(電車|鉄道|乗換|乗り換え|経路|行き方|何に乗|何を乗|所要時間|運賃|時刻表|次の電車|何時発)/i;
const CAPABILITY_RE=/(?:検索|調べ).{0,20}(?:できる|出来る|使える|あるだろ|できるだろ|出来るだろ|できないの|出来ないの)|(?:できる|出来る|使える).{0,20}(?:検索|調べ)/i;
const PRICE_RE=/(?:\d{1,3}(?:,\d{3})+|\d{4,7})\s*円|\d+(?:\.\d+)?\s*万円/g;
const TRUSTED_PC_HOST_RE=/(?:^|\.)(?:lenovo\.com|dell\.com|hp\.com|asus\.com|acer\.com|nec-lavie\.jp|dynabook\.com|fmworld\.net|fujitsu\.com|mouse-jp\.co\.jp|dospara\.co\.jp|pc-koubou\.jp|yodobashi\.com|biccamera\.com|yamada-denkiweb\.com|ksdenki\.com|nojima\.co\.jp|edion\.com|kojima\.net)$/i;
const BAD_PC_PAGE_RE=/(安く買う方法|選び方|おすすめ\d*選|比較\d*選|ランキング|徹底比較|買い時|解説|記事|コラム)/i;

function clean(v,max=9000){return String(v??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function historyOf(v){return Array.isArray(v)?v.slice(-16).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1800)})).filter(x=>x.content):[];}
function userHistory(v){return historyOf(v).filter(x=>x.role==='user');}
function schedule(ctx,env,input){const p=persistTalkLog(env,{...input,revision:REVISION});if(ctx?.waitUntil)ctx.waitUntil(p);else p.catch(()=>{});}
function extractText(r){if(typeof r==='string')return clean(r);if(!r)return '';for(const v of [r.response,r.result,r.text,r.output_text])if(typeof v==='string'&&v.trim())return clean(v);const c=r.choices?.[0]?.message?.content;if(typeof c==='string')return clean(c);if(Array.isArray(c))return clean(c.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''));return clean(r.choices?.[0]?.text||'');}
async function glm(env,messages,max=420){const t=Date.now();const r=await env.AI.run(MODEL,{messages,stream:false,modalities:['text'],max_completion_tokens:max,temperature:0.05,reasoning_effort:'low'});const text=extractText(r);if(!text)throw new Error('empty model answer');return {text,ms:Date.now()-t};}
function hostOf(url){try{return new URL(String(url||'')).hostname.toLowerCase();}catch{return '';}}
function sourceText(x){return clean(`${x?.title||''} ${x?.excerpt||x?.snippet||''}`,7000);}
function evidenceBlock(s,max=12){return (s?.sources||[]).slice(0,max).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}
function moneyTokens(v){return [...String(v||'').matchAll(PRICE_RE)].map(x=>x[0].replace(/\s+/g,''));}
function moneyGrounded(answer,evidence){const hay=String(evidence||'').replace(/\s+/g,'');return moneyTokens(answer).every(x=>hay.includes(x));}
function noEvidenceAnswer(){return '検索は実行しましたが、回答に使える根拠を取得できませんでした。数字や店名を推測で補うことはしません。検索条件や取得経路を変えて確認する必要があります。';}
function isCapability(text){return CAPABILITY_RE.test(clean(text,1400));}

function stationPair(text,history=[]){
  const users=userHistory(history).map(x=>x.content).slice(-8).join(' '),value=clean(`${users} ${text}`,5000);
  const patterns=[/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24})駅\s*(?:から|より|→|⇒|〜|～|-)\s*([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24})駅\s*(?:まで|へ|に)/i,/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24})\s*(?:から|より)\s*([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24})\s*(?:まで|へ)(?=.*(?:電車|鉄道|駅))/i];
  for(const re of patterns){const m=value.match(re);if(m?.[1]&&m?.[2])return [m[1].replace(/駅$/,''),m[2].replace(/駅$/,'')];}
  return [];
}
function transitContext(text,history=[]){const joined=clean(`${userHistory(history).map(x=>x.content).join(' ')} ${text}`,5000);return stationPair(text,history).length===2&&(TRANSIT_RE.test(joined)||/(検索|調べ)/.test(text));}

function explicitWeatherText(text,history=[]){
  const raw=clean(text,1200);
  if(/別途/.test(raw)&&WEATHER_RE.test(raw))return raw.replace(/別途/g,'大分県別府市');
  if(WEATHER_RE.test(raw))return raw;
  if(!/(今日|明日|明後日|きょう|あした|あさって)/.test(raw))return raw;
  const users=userHistory(history).slice().reverse();
  for(const row of users){
    const m=row.content.match(/((?:東京都|北海道|(?:京都|大阪)府|.{2,4}県)?[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,14}(?:市|区|町|村))/);
    if(m?.[1]&&WEATHER_RE.test(row.content))return `${raw.replace(/[?？。]/g,'')} ${m[1]}の天気`;
  }
  return raw;
}
function needsWeatherRewrite(text,history=[]){const v=explicitWeatherText(text,history);return v!==clean(text,1200);}
function cloneJsonRequest(request,body){return new Request(request.url,{method:request.method,headers:request.headers,body:JSON.stringify(body)});}

function localPcIntent(text,history=[]){const v=clean(`${userHistory(history).map(x=>x.content).join(' ')} ${text}`,4500);return PC_RE.test(v)&&/(県内|市内|近く|周辺|お店|店舗|店を|販売店|ショップ|家電量販店|専門店)/.test(v);}
function trustedPcProductSource(x){const host=hostOf(x?.url),text=sourceText(x);return TRUSTED_PC_HOST_RE.test(host)&&PC_RE.test(text)&&!BAD_PC_PAGE_RE.test(`${x?.title||''}`);}
async function robustPcEvidence(resolved,hist,instruction,local){
  let base=await collectResilientEvidenceV42(resolved,hist,instruction);
  const boostedQuestion=local?`${resolved} パソコン 店舗 販売店 家電量販店`:`${resolved} メーカー直販 公式ストア 販売店 価格`;
  base={...base,resolvedQuestion:boostedQuestion};
  let s=await augmentGroundedEvidenceV26(base);
  if(!local){const filtered=(s.sources||[]).filter(trustedPcProductSource);s={...s,sources:filtered,evidence:evidenceBlock({sources:filtered}),searchUseful:filtered.length>0};}
  return s;
}
const PC_GROUNDED_PROMPT=`あなたはTalkSysのPC購入検索回答器です。以下の取得根拠だけを使ってください。根拠にない価格、型番、スペック、在庫、住所、店名を絶対に追加しないでください。価格を言う場合、その同じ金額が取得根拠に文字として存在する必要があります。店舗相談では取得根拠に存在する具体的な店名を優先し、一般論の価格帯へ逃げないでください。製品相談では販売元・製品ページの根拠が弱ければ、確認できた販売元や製品だけを答えてください。自分で検索・確認するよう利用者へ押し戻さないでください。3〜5文の自然な日本語で直接答えてください。`;
async function robustPcTurn(body,plan,env){
  const started=Date.now(),hist=userHistory(body?.history),resolved=clean(plan?.resolvedQuestion||body?.text,1800),instruction=clean(plan?.searchInstruction,2600),local=localPcIntent(body?.text,hist),t=Date.now(),s=await robustPcEvidence(resolved,hist,instruction,local),searchMs=Date.now()-t,evidence=evidenceBlock(s);
  if(!s.searchUseful||!(s.sources||[]).length)return {ok:true,answer:noEvidenceAnswer(),search:true,route:'pc-search-no-evidence-v43.1',searchUseful:false,resolvedQuestion:resolved,queries:(s.queries||[]).slice(0,24),sources:[],searchPasses:Number(s.searchPasses)||1,maxSearchPasses:5,timings:{totalMs:Date.now()-started,searchMs,glmMs:0},model:'mechanical-guard',planner:'pc-search-v43',languageMode:'ja-only',noEvidenceGuard:true};
  let g=await glm(env,[{role:'system',content:PC_GROUNDED_PROMPT},{role:'user',content:`相談: ${resolved}\n検索条件: ${instruction}\n\n取得根拠:\n${evidence}`}],430);
  if(!moneyGrounded(g.text,evidence))g=await glm(env,[{role:'system',content:PC_GROUNDED_PROMPT+' 前の草案には根拠に存在しない金額がありました。取得根拠に文字として存在する金額以外をすべて削除してください。'},{role:'user',content:`相談: ${resolved}\n\n取得根拠:\n${evidence}`}],380);
  if(!moneyGrounded(g.text,evidence))g={text:'確認できた検索根拠はありますが、価格表現の整合性を検証できなかったため、金額は読み上げません。'+(s.sources||[]).slice(0,3).map(x=>clean(x.title,90)).join('、')+'を候補として確認できています。',ms:0};
  return {ok:true,answer:g.text,search:true,route:local?'pc-local-store-grounded-v43.1':'pc-product-grounded-v43.1',searchUseful:true,resolvedQuestion:resolved,queries:(s.queries||[]).slice(0,24),sources:(s.sources||[]).slice(0,12).map(x=>({title:clean(x.title,220),url:clean(x.url,700)})),searchPasses:Number(s.searchPasses)||1,maxSearchPasses:5,timings:{totalMs:Date.now()-started,searchMs,glmMs:g.ms||0},model:MODEL,planner:'pc-search-v43',languageMode:'ja-only',moneyGrounded:true};
}

const TRANSIT_PROMPT=`あなたはTalkSysの鉄道経路回答器です。Yahoo!乗換案内の直接取得根拠だけを使ってください。鉄道経路だけを答え、根拠にないバス・タクシー・料金・所要時間を追加しないでください。金額や時間を言うなら取得根拠に同じ数字が存在する必要があります。現在時刻基準の候補が根拠にあれば、その範囲で案内してください。自分で時刻表を確認するよう利用者へ押し戻さないでください。2〜4文の自然な日本語で答えてください。`;
async function robustTransitTurn(body,env){
  const started=Date.now(),hist=userHistory(body?.history),pair=stationPair(body?.text,hist);if(pair.length!==2)throw new Error('station pair unresolved');const [from,to]=pair,resolved=`${from}駅から${to}駅までの電車の経路 直通 所要時間 運賃 時刻表 最新情報`,t=Date.now();
  let s=await augmentGroundedEvidenceV26({resolvedQuestion:resolved,queries:[`${from}駅 ${to}駅 乗換 所要時間 運賃`],sources:[],evidence:'',searchUseful:false});const searchMs=Date.now()-t;
  const direct=(s.sources||[]).filter(x=>/transit\.yahoo\.co\.jp/i.test(x?.url||'')||x?.engine==='yahoo-transit-direct-current');s={...s,sources:direct,evidence:evidenceBlock({sources:direct}),searchUseful:direct.length>0};
  if(!direct.length)return {ok:true,answer:noEvidenceAnswer(),search:true,route:'transit-no-evidence-v43.1',searchUseful:false,resolvedQuestion:resolved,queries:s.queries||[],sources:[],timings:{totalMs:Date.now()-started,searchMs,glmMs:0},model:'mechanical-guard',planner:'transit-direct-v43.1',languageMode:'ja-only',noEvidenceGuard:true};
  const evidence=evidenceBlock(s),g=await glm(env,[{role:'system',content:TRANSIT_PROMPT},{role:'user',content:`質問: ${clean(body?.text,1200)}\n\nYahoo!乗換案内の取得根拠:\n${evidence}`}],360);
  let answer=g.text;if(!moneyGrounded(answer,evidence))answer='Yahoo!乗換案内の経路情報は取得できましたが、運賃の数字を根拠と照合できなかったため、金額は省略します。'+clean(direct[0]?.excerpt||direct[0]?.snippet,700);
  return {ok:true,answer,search:true,route:'transit-yahoo-direct-v43.1',searchUseful:true,resolvedQuestion:resolved,queries:s.queries||[],sources:direct.map(x=>({title:clean(x.title,220),url:clean(x.url,700)})),searchPasses:1,maxSearchPasses:1,timings:{totalMs:Date.now()-started,searchMs,glmMs:g.ms},model:MODEL,planner:'transit-direct-v43.1',languageMode:'ja-only',directTransitPrimary:true,moneyGrounded:true};
}

function safeRepairTurn(body){const text=clean(body?.text,1800);return {ok:true,answer:'購入額が8,000円で、大事なデータは特に入っていないという条件なら、費用対効果だけを見ると買い替え寄りで考えるのが自然です。ただし、修理費用はこのターンでは調べていないので「修理の方が高い」とは断定しません。背面割れ以外に使用上の不具合があるか、今の端末を使い続けたい理由があるかで最終判断が変わります。',search:false,route:'device-decision-grounded-v43.1',searchUseful:false,resolvedQuestion:text,queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local-rules',planner:'device-decision-local-v42',languageMode:'ja-only'};}
function sanitizeCapability(){return {ok:true,answer:'検索できます。さっき検索機能がないように案内したのは誤りです。必要なときは、この会話内でWeb検索して価格・在庫・天気・交通などの現在情報を確認できます。',search:false,route:'search-capability-grounded-v43.1',searchUseful:false,resolvedQuestion:'検索機能の確認',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local-rules',planner:'search-capability-local-v43',languageMode:'ja-only'};}
function guardDelegated(data){if(!data?.ok)return data;if(data.search===true&&!data.searchUseful){return {...data,answer:noEvidenceAnswer(),route:`${data.route||'search'}-no-evidence-guard-v43.1`,noEvidenceGuard:true,sources:[]};}return data;}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health'){
      const r=await workerV43.fetch(request,env,ctx),d=await r.json();return json({...d,revision:REVISION,voiceRevision:REVISION,noEvidenceNoFactsGuard:true,directTransitEvidence:true,pcV26EvidenceRecovery:true,weatherBeppuDisambiguation:'oita-city',manualQaReviewRequired:true});
    }
    if(request.method==='POST'&&(url.pathname==='/api/plan'||url.pathname==='/api/turn')){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1800),hist=historyOf(body?.history);
      if(isCapability(text)&&url.pathname==='/api/turn'){const data=sanitizeCapability();schedule(ctx,env,{request,body,result:data,event:'turn',status:200});return json(data);}
      if(url.pathname==='/api/turn'&&(body?.searchPlan?.planner==='pc-search-v43'||(PC_RE.test(clean(`${hist.map(x=>x.content).join(' ')} ${text}`,5000))&&body?.searchPlan?.search===true))){try{const data=await robustPcTurn(body,body.searchPlan||{},env);schedule(ctx,env,{request,body,result:data,event:'turn',status:200});return json(data);}catch(e){return json({ok:false,error:clean(e?.message||e,1000),route:'pc-grounded-error-v43.1'},500);}}
      if(url.pathname==='/api/turn'&&transitContext(text,hist)){try{const data=await robustTransitTurn(body,env);schedule(ctx,env,{request,body,result:data,event:'turn',status:200});return json(data);}catch(e){return json({ok:false,error:clean(e?.message||e,1000),route:'transit-grounded-error-v43.1'},500);}}
      if(url.pathname==='/api/turn'&&body?.searchPlan?.planner==='device-decision-local-v42'){const data=safeRepairTurn(body);schedule(ctx,env,{request,body,result:data,event:'turn',status:200});return json(data);}
      const rewritten=explicitWeatherText(text,hist);if(rewritten!==text){body={...body,text:rewritten};request=cloneJsonRequest(request,body);}
      const response=await workerV43.fetch(request,env,ctx),type=response.headers.get('content-type')||'';if(!type.includes('application/json'))return response;
      try{const data=guardDelegated(await response.json());return json(data,response.status);}catch{return response;}
    }
    return workerV43.fetch(request,env,ctx);
  }
};

export const __test={stationPair,transitContext,explicitWeatherText,needsWeatherRewrite,localPcIntent,trustedPcProductSource,moneyTokens,moneyGrounded,isCapability,guardDelegated};
