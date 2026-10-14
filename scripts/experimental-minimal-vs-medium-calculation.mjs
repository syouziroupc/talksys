import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.GEMINI_API_KEY;
if(!API_KEY) throw new Error('GEMINI_API_KEY is required');
const OUT='artifacts/minimal-vs-medium-calculation';
await fs.mkdir(OUT,{recursive:true});
const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';
const cases=[
{id:'rail-next',cat:'dynamic_search',q:'今から別府駅から大分駅へ行く次に乗れる列車を調べて。発車時刻と列車種別を答えて。'},
{id:'rail-deadline',cat:'dynamic_reasoning',q:'今から別府駅を出て博多駅に16時30分までに着ける？次に乗れる列車を確認して現実的に判断して。'},
{id:'fx-now',cat:'dynamic_search',q:'現在の米ドル円（USD/JPY）は1ドル何円くらい？できるだけ現在値に近い情報を確認して答えて。'},
{id:'fx-calc',cat:'dynamic_math',q:'現在の米ドル円を確認して、500ドルを円換算し、そこから3.25%の決済手数料を引いた受取額を円で計算して。1円未満は切り捨て。'},
{id:'stock-value',cat:'dynamic_math',q:'トヨタ自動車（7203）の現在の株価を確認して、100株持っている場合の評価額を計算して。株価の基準時刻も簡潔に示して。'},
{id:'weather-judgment',cat:'dynamic_reasoning',q:'今日の別府市の18時から22時ごろの天気を確認して、徒歩で外出するなら傘を持つべきか判断して。'},
{id:'apple-price-diff',cat:'dynamic_math',q:'Apple日本公式で現在のiPhone 17e 256GBの価格を確認し、15万円との差額を計算して。'},
{id:'python-current',cat:'dynamic_search',q:'Pythonの現在の最新安定版を公式情報で確認して、バージョンと公開日を答えて。'},
{id:'margin-multi',cat:'arithmetic_reasoning',q:'20着を50000円で販売。仕入れは1着1500円、国際送料8400円、決済手数料3.25%、梱包材600円。利益額と売上に対する利益率を求めて。手数料は1円未満切り捨て。'},
{id:'break-even',cat:'arithmetic_reasoning',q:'1台29800円でPCを売る。仕入れ16500円、整備費2200円、送料1500円、決済手数料3.25%。固定広告費8000円も回収したい。何台売れば広告費込みで黒字になる？手数料は1円未満切り捨て。'},
{id:'latency-budget',cat:'technical_reasoning',q:'STT 1.8秒、LLM 1.2秒、TTS開始0.5秒が完全直列。体感3秒以内にするには最低何秒短縮が必要？LLMだけで吸収するならLLMは何秒以下必要？'},
{id:'mixed-cost',cat:'arithmetic_reasoning',q:'月100件の問い合わせがあり、40%がPC、35%がHP、25%が着物。成約率がそれぞれ25%、12%、20%なら期待成約件数は合計何件？さらに1件あたり粗利益がPC8000円、HP45000円、着物6000円なら期待粗利益はいくら？'}
];
const variants={
  '2.5-flash-dynamic':{model:'gemini-2.5-flash',thinkingConfig:{thinkingBudget:-1}},
  '3.5-lite-medium':{model:'gemini-3.5-flash-lite',thinkingConfig:{thinkingLevel:'medium'}}
};
const system=(now)=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在日時は ${now} です。`;
function body(sys,q,cfg){return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig:{thinkingConfig:cfg.thinkingConfig,temperature:0.1}};}
async function call(sys,q,cfg){const s=Date.now();const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(sys,q,cfg))});const j=await r.json();if(!r.ok)throw new Error(`${cfg.model}: ${r.status} ${JSON.stringify(j)}`);const c=j.candidates?.[0];const gm=c?.groundingMetadata||{};return {model:cfg.model,ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean),usage:j.usageMetadata||null};}
function norm(s){return s.replace(/[，,\s]/g,'');}
function pass(id,text){const t=norm(text);
 if(id==='margin-multi') return /9375円/.test(t)&&/18\.75%/.test(t);
 if(id==='break-even') return /1台/.test(t);
 if(id==='latency-budget') return /0\.5秒/.test(text)&&/0\.7秒/.test(text);
 if(id==='mixed-cost') return /19\.2件/.test(text)&&(/278000円/.test(t)||/27万8000円/.test(t));
 if(id==='apple-price-diff') return /124800円/.test(t)&&/25200円/.test(t);
 return null;
}
const rows=[];
for(let rep=1;rep<=2;rep++){
 for(const tc of cases){
  for(const [variant,cfg] of Object.entries(variants)){
   const now=nowJst();
   const q=`現在日時は ${now}（日本時間）です。\n${tc.q}`;
   const answer=await call(system(now),q,cfg);
   rows.push({rep,id:tc.id,cat:tc.cat,variant,now,deterministicPass:pass(tc.id,answer.text),answer});
  }
 }
}
const summary={};
for(const variant of Object.keys(variants)){
 const xs=rows.filter(r=>r.variant===variant);const ms=xs.map(x=>x.answer.ms).sort((a,b)=>a-b);const judged=xs.filter(x=>x.deterministicPass!==null);
 const thoughts=xs.map(x=>x.answer.usage?.thoughtsTokenCount||0);const outputs=xs.map(x=>x.answer.usage?.candidatesTokenCount||0);
 summary[variant]={n:xs.length,meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),p50Ms:ms[Math.floor((ms.length-1)*.5)],p95Ms:ms[Math.floor((ms.length-1)*.95)],searchRate:xs.filter(x=>x.answer.searches.length).length/xs.length,sourceRate:xs.filter(x=>x.answer.sources.length).length/xs.length,deterministicPass:`${judged.filter(x=>x.deterministicPass).length}/${judged.length}`,meanThoughtTokens:Math.round(thoughts.reduce((a,b)=>a+b,0)/thoughts.length),meanOutputTokens:Math.round(outputs.reduce((a,b)=>a+b,0)/outputs.length)};
}
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({summary,rows},null,2));
let md='# Gemini 2.5 Flash vs 3.5 Flash-Lite medium\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n';for(const r of rows)md+=`\n## ${r.id}/${r.variant}/rep${r.rep}\n- ${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} pass=${r.deterministicPass}\n- ${r.answer.text}\n`;await fs.writeFile(path.join(OUT,'report.md'),md);console.log(JSON.stringify({summary,rows},null,2));