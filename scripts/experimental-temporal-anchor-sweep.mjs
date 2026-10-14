import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.AUDIT_MODEL || 'gemini-3.5-flash-lite';
if (!API_KEY) throw new Error('GEMINI_API_KEY is required');
const OUT='artifacts/temporal-anchor-sweep';
await fs.mkdir(OUT,{recursive:true});

const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';
const cases=[
 {id:'rail-beppu-oita',cat:'rail',q:'今この時刻から別府駅を出て大分駅へ行く次に乗れる列車を1本だけ。発車時刻と列車種別を答えて。'},
 {id:'rail-beppu-hakata',cat:'rail',q:'今この時刻から別府駅を出て博多駅へ行く次に乗れる特急を1本だけ。発車時刻と列車名を答えて。'},
 {id:'stock-toyota',cat:'stock',q:'トヨタ自動車 7203 の現在の株価を円で答えて。取引時間外なら直近終値と、それがいつの値かを答えて。'},
 {id:'stock-sony',cat:'stock',q:'ソニーグループ 6758 の現在の株価を円で答えて。取引時間外なら直近終値と、それがいつの値かを答えて。'},
 {id:'weather-beppu',cat:'weather',q:'今の別府市の天気と気温を簡潔に答えて。'},
 {id:'weather-tokyo',cat:'weather',q:'今の東京都心の天気と気温を簡潔に答えて。'},
 {id:'apple-price',cat:'price',q:'Apple日本公式で現在販売中のiPhone 17e 256GBの税込価格はいくら？'},
];
const system=(now)=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在時刻は ${now} です。`;
const variants=[
 {id:'system_time_t01',anchor:false,temp:0.1},
 {id:'user_time_t01',anchor:true,temp:0.1},
 {id:'user_time_t00',anchor:true,temp:0.0},
];
function body(sys,q,temp){return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig:{thinkingConfig:{thinkingLevel:'minimal'},temperature:temp}};}
async function call(sys,q,temp){const s=Date.now(); const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(sys,q,temp))}); const j=await r.json(); if(!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); const c=j.candidates?.[0]; const gm=c?.groundingMetadata||{}; return {ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean)};}
function mins(h,m){return Number(h)*60+Number(m)}
function issue(row){const t=row.answer.text; if(row.cat==='rail'){const m=t.match(/(\d{1,2})[:時](\d{2})/); const n=row.now.match(/T(\d{2}):(\d{2})/); if(m&&n&&mins(m[1],m[2])<mins(n[1],n[2])) return 'past_train';}
 if(row.id==='apple-price'&&!/124[,，]?800/.test(t)) return 'apple_price'; if(row.answer.searches.length===0) return 'no_search'; if(row.answer.sources.length===0) return 'no_source'; return null;}
const rows=[];
for(let rep=1;rep<=3;rep++) for(const tc of cases) for(const v of variants){const now=nowJst(); const uq=v.anchor?`現在日時は ${now}（日本時間）です。\n${tc.q}`:tc.q; const answer=await call(system(now),uq,v.temp); const row={rep,id:tc.id,cat:tc.cat,variant:v.id,now,answer}; row.issue=issue(row); rows.push(row);}
const summary={}; for(const v of variants){const xs=rows.filter(r=>r.variant===v.id); const a=xs.map(x=>x.answer.ms).sort((x,y)=>x-y); summary[v.id]={n:xs.length,meanMs:Math.round(a.reduce((x,y)=>x+y,0)/a.length),p50Ms:a[Math.floor((a.length-1)*.5)],p95Ms:a[Math.floor((a.length-1)*.95)],searchRate:xs.filter(x=>x.answer.searches.length).length/xs.length,sourceRate:xs.filter(x=>x.answer.sources.length).length/xs.length,obviousIssues:xs.filter(x=>x.issue).length,types:Object.fromEntries([...new Set(xs.filter(x=>x.issue).map(x=>x.issue))].map(k=>[k,xs.filter(x=>x.issue===k).length]))};}
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({model:MODEL,summary,rows},null,2)); let md='# Temporal anchor sweep\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n'; for(const r of rows) md+=`\n## ${r.id}/${r.variant}/rep${r.rep}\n- ${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} issue=${r.issue||'none'}\n- ${r.answer.text}\n`; await fs.writeFile(path.join(OUT,'report.md'),md); console.log(JSON.stringify({summary,rows},null,2));