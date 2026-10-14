import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.GEMINI_API_KEY;
const MODEL=process.env.AUDIT_MODEL||'gemini-3.5-flash-lite';
if(!API_KEY) throw new Error('GEMINI_API_KEY is required');
const OUT='artifacts/minimal-vs-medium-calculation';
await fs.mkdir(OUT,{recursive:true});
const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';
const cases=[
{id:'margin-simple',cat:'arithmetic',q:'売上50000円、仕入30000円、送料8400円、決済手数料は売上の3.25%。利益はいくら？計算式も示して。'},
{id:'tax-rounding',cat:'arithmetic',q:'税込19800円を税率10%として税抜額と消費税相当額に分けて。1円未満が出た場合は切り捨て。'},
{id:'fee-rounding',cat:'arithmetic',q:'52200円の3.25%を決済手数料として1円未満切り捨てにした場合、手数料と入金額はいくら？'},
{id:'multi-stage',cat:'arithmetic_reasoning',q:'20着を50000円で販売。仕入れは1着1500円、国際送料8400円、決済手数料3.25%、梱包材600円。利益額と売上に対する利益率を求めて。手数料は1円未満切り捨て。'},
{id:'break-even',cat:'arithmetic_reasoning',q:'1台29800円でPCを売る。仕入れ16500円、整備費2200円、送料1500円、決済手数料3.25%。固定広告費8000円も回収したい。何台売れば広告費込みで黒字になる？手数料は1円未満切り捨て。'},
{id:'weighted',cat:'arithmetic_reasoning',q:'問い合わせ10件のうちPC修理4件、HP制作3件、着物輸出3件。成約率がそれぞれ50%、30%、20%なら、期待成約件数はいくつ？'},
{id:'latency-budget',cat:'technical_reasoning',q:'STT 1.8秒、LLM 1.2秒、TTS開始0.5秒が完全直列。体感3秒以内にするには最低何秒短縮が必要？LLMだけで吸収するならLLMは何秒以下必要？'},
{id:'rail-deadline',cat:'dynamic_reasoning',q:'今から別府駅を出て博多駅に15時30分までに着ける？列車で現実的に間に合うか、次に乗れる候補を確認して判断して。'},
{id:'python-current',cat:'dynamic_reasoning',q:'Pythonの現在の最新安定版を公式情報で確認して、バージョン、公開日、3.14系より新しいかを答えて。'},
{id:'cloudflare',cat:'dynamic_reasoning',q:'Cloudflare Workers Freeプランを個人の小規模APIに使う場合、現在の公式制限のうちリクエスト数とCPU時間ではどちらが先にボトルネックになりやすい？数値を確認して答えて。'}
];
const variants=['minimal','medium'];
const system=(now)=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在日時は ${now} です。`;
function body(sys,q,thinking){return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig:{thinkingConfig:{thinkingLevel:thinking},temperature:0.1}};}
async function call(sys,q,thinking){const s=Date.now();const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(sys,q,thinking))});const j=await r.json();if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(j)}`);const c=j.candidates?.[0];const gm=c?.groundingMetadata||{};return {ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean)};}
function norm(s){return s.replace(/[，,\s]/g,'');}
function pass(id,text){const t=norm(text);
 if(id==='margin-simple') return /9975円/.test(t);
 if(id==='tax-rounding') return /18000円/.test(t)&&/1800円/.test(t);
 if(id==='fee-rounding') return /1696円/.test(t)&&/50504円/.test(t);
 if(id==='multi-stage') return /936?5円|936?4円/.test(t)||(/936?5/.test(t)&&/18\.7/.test(t));
 if(id==='break-even') return /1台/.test(text)||/1台/.test(t);
 if(id==='weighted') return /3\.5/.test(text)||/3.5/.test(text);
 if(id==='latency-budget') return /0\.5秒/.test(text)&&/0\.7秒/.test(text);
 return null;
}
const rows=[];
for(let rep=1;rep<=2;rep++){
 for(const tc of cases){
  for(const v of variants){
   const now=nowJst();
   const q=`現在日時は ${now}（日本時間）です。\n${tc.q}`;
   const answer=await call(system(now),q,v);
   rows.push({rep,id:tc.id,cat:tc.cat,variant:v,now,deterministicPass:pass(tc.id,answer.text),answer});
  }
 }
}
const summary={};
for(const v of variants){const xs=rows.filter(r=>r.variant===v);const ms=xs.map(x=>x.answer.ms).sort((a,b)=>a-b);const judged=xs.filter(x=>x.deterministicPass!==null);summary[v]={n:xs.length,meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),p50Ms:ms[Math.floor((ms.length-1)*.5)],p95Ms:ms[Math.floor((ms.length-1)*.95)],searchRate:xs.filter(x=>x.answer.searches.length).length/xs.length,sourceRate:xs.filter(x=>x.answer.sources.length).length/xs.length,deterministicPass:`${judged.filter(x=>x.deterministicPass).length}/${judged.length}`};}
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({model:MODEL,summary,rows},null,2));
let md='# Minimal vs Medium calculation sweep\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n';for(const r of rows)md+=`\n## ${r.id}/${r.variant}/rep${r.rep}\n- ${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} pass=${r.deterministicPass}\n- ${r.answer.text}\n`;await fs.writeFile(path.join(OUT,'report.md'),md);console.log(JSON.stringify({summary,rows},null,2));