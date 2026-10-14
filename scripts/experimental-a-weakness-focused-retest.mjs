import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.GEMINI_API_KEY;
if(!API_KEY) throw new Error('GEMINI_API_KEY is required');
const MODEL='gemini-3.5-flash-lite';
const OUT='artifacts/a-weakness-focused-retest';
await fs.mkdir(OUT,{recursive:true});

const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';
const cases=[
 {id:'apple-current',cat:'price',q:'Apple日本公式で現在のiPhone 17e 256GBの税込価格を確認して。発売時価格ではなく、今買う場合の価格を答えて。'},
 {id:'rail-next-hakata',cat:'rail',q:'今から別府駅から博多駅へ行く次に実際に乗れる特急を調べて。別府発、列車名、博多着を答えて。'},
 {id:'rail-deadline',cat:'dynamic_reasoning',q:'今から別府駅を出て博多駅に16時30分までに着ける？次に乗れる列車を確認して、発車時刻・列車名・到着時刻と結論を答えて。'},
 {id:'fx-calc',cat:'dynamic_math',q:'現在の米ドル円を確認して、500ドルを円換算し、そこから3.25%の決済手数料を引いた受取額を円で計算して。使った為替レートと基準時刻も答え、1円未満は切り捨て。'},
 {id:'stock-toyota',cat:'dynamic_math',q:'トヨタ自動車（7203）の現在の株価を確認して、100株の評価額を計算して。株価がリアルタイムか遅延値か、分かる範囲で基準時刻も答えて。'},
 {id:'stock-softbank',cat:'dynamic_math',q:'ソフトバンクグループ（9984）の現在の株価を確認して、前日終値との差額と騰落率を計算して。現在値と基準時刻も答えて。'}
];
const variants={
 A_current_medium:{improved:false,selectiveHigh:false},
 B_improved_medium:{improved:true,selectiveHigh:false},
 C_improved_selective_high:{improved:true,selectiveHigh:true}
};
const hardCats=new Set(['dynamic_reasoning','dynamic_math']);
const dynamicCats=new Set(['rail','dynamic_reasoning','dynamic_math','price']);
const system=now=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在日時は ${now} です。`;
function body(sys,q,thinking,improved){const generationConfig={thinkingConfig:{thinkingLevel:thinking}};if(!improved)generationConfig.temperature=0.1;return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig};}
async function call(sys,q,thinking,improved){const s=Date.now();const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(sys,q,thinking,improved))});const j=await r.json();if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(j)}`);const c=j.candidates?.[0],gm=c?.groundingMetadata||{};return {ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean),usage:j.usageMetadata||null};}
function parseHHMM(text){const m=text.match(/(?:^|[^0-9])(\d{1,2})[:時](\d{2})/);return m?{h:Number(m[1]),m:Number(m[2])}:null;}
function nowMinutes(now){const d=new Date(now);return (d.getUTCHours()*60+d.getUTCMinutes()+540)%1440;}
function shouldRetry(tc,a,now){if(!dynamicCats.has(tc.cat))return false;if(a.sources.length===0||a.searches.length===0)return true;if(tc.cat==='rail'||tc.id==='rail-deadline'){const t=parseHHMM(a.text);if(t&&t.h*60+t.m<nowMinutes(now)-1)return true;}if(['stock-toyota','stock-softbank','fx-calc'].includes(tc.id)){const t=parseHHMM(a.text);if(t){const age=nowMinutes(now)-(t.h*60+t.m);if(age>90&&age<720)return true;}}return false;}
function deterministic(id,text){const t=text.replace(/[，,\s]/g,'');if(id==='apple-current')return /124800円/.test(t);return null;}
const rows=[];
for(let rep=1;rep<=5;rep++){
 for(const tc of cases){
  for(const [variant,opt] of Object.entries(variants)){
   const now=nowJst();
   const q=`現在日時は ${now}（日本時間）です。\n${tc.q}`;
   const thinking=opt.selectiveHigh&&hardCats.has(tc.cat)?'high':'medium';
   let answer=await call(system(now),q,thinking,opt.improved),retried=false;
   if(opt.improved&&shouldRetry(tc,answer,now)){
    retried=true;
    const retryQ=`現在日時は ${now}（日本時間）です。\n${tc.q}\n直前の回答は使わず、現在時点の検索結果をもう一度確認して答えてください。`;
    const b=await call(system(now),retryQ,thinking,true);answer={...b,ms:answer.ms+b.ms};
   }
   rows.push({rep,id:tc.id,cat:tc.cat,variant,thinking,now,retried,deterministicPass:deterministic(tc.id,answer.text),answer});
  }
 }
}
const summary={};
for(const variant of Object.keys(variants)){
 const xs=rows.filter(r=>r.variant===variant),ms=xs.map(x=>x.answer.ms).sort((a,b)=>a-b),judged=xs.filter(x=>x.deterministicPass!==null);
 summary[variant]={n:xs.length,meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),p50Ms:ms[Math.floor((ms.length-1)*.5)],p95Ms:ms[Math.floor((ms.length-1)*.95)],searchRate:xs.filter(x=>x.answer.searches.length).length/xs.length,sourceRate:xs.filter(x=>x.answer.sources.length).length/xs.length,retryRate:xs.filter(x=>x.retried).length/xs.length,applePass:`${judged.filter(x=>x.deterministicPass).length}/${judged.length}`};
}
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({model:MODEL,summary,rows},null,2));
let md='# A weakness focused retest\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n';for(const r of rows)md+=`\n## ${r.id}/${r.variant}/rep${r.rep}\n- now=${r.now} thinking=${r.thinking} ${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} retry=${r.retried} deterministic=${r.deterministicPass}\n- searches: ${JSON.stringify(r.answer.searches)}\n- ${r.answer.text}\n`;
await fs.writeFile(path.join(OUT,'report.md'),md);console.log(JSON.stringify({summary,rows},null,2));