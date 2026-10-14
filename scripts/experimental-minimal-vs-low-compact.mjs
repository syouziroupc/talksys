import fs from 'node:fs';
import { currentJstInstruction, normalizeSpokenJapanese } from '../src/integrated-entry.js';

const KEY=String(process.env.GEMINI_API_KEY||'').trim();
const MODEL=String(process.env.AUDIT_MODEL||'gemini-3.5-flash-lite').trim();
const ENDPOINT='https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT='artifacts/minimal-vs-low-compact';
if(!KEY) throw new Error('GEMINI_API_KEY is required');
const repeats=2;
const cases=[
 {id:'browser',p:'ブラウザって何ですか？「ブラウザ」という言葉を使ったまま簡単に説明してください。',s:false,ok:['ブラウザ']},
 {id:'math',p:'17箱に24個ずつ入っています。全部で何個ですか？',s:false,ok:['408']},
 {id:'python',p:'Python公式の現在の情報を優先して、最新の安定版系統を教えてください。',s:true,ok:['3.15']},
 {id:'apple',p:'Apple日本公式の現在の購入ページを優先して、iPhone 17e 256GBの今の税込価格を教えてください。',s:true,ok:['124,800','12万4,800']},
 {id:'capital',p:'日本の首都はどこですか？',s:false,ok:['東京']},
 {id:'cloudflare',p:'Cloudflareとは何ですか？Cloudflareという名前を残して短く説明してください。',s:false,ok:['Cloudflare']},
];
function sys(search){return [
 '<role>あなたはTalkSysの日本語音声アシスタントです。電話でそのまま読み上げます。</role>',
 '<priority>最優先は事実の正確さです。固有名詞・製品名・利用者が残すよう指定した用語は保持します。</priority>',
 '<speech>通常2〜4文。本題から答えます。難語は勝手に別名へ置換せず、必要なら短く説明します。</speech>',
 `<time>${currentJstInstruction(new Date())}</time>`,
 search?'<grounding>Google検索を使い、現在値は古い記事ではなく現行の公式ページを優先します。</grounding>':'<grounding>現在性不要の一般知識は検索なしで答えます。</grounding>',
 '<final_check>固有名詞・数値・質問条件だけ確認し、問題があれば回答だけ直します。</final_check>'
].join('\n');}
function text(payload={}){return (payload.steps||[]).filter(x=>x?.type==='model_output').flatMap(x=>x.content||[]).filter(x=>x?.type==='text').map(x=>x.text||'').join('').trim();}
async function call(tc,level){const body={model:MODEL,input:tc.s?`Google検索で確認して答えてください。${tc.p}`:tc.p,system_instruction:sys(tc.s),generation_config:{thinking_level:level},...(tc.s?{tools:[{type:'google_search'}]}:{})}; const t=Date.now(); const r=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}); const raw=await r.text(); if(!r.ok) throw new Error(raw); const payload=JSON.parse(raw); return {ms:Date.now()-t,text:normalizeSpokenJapanese(text(payload))};}
function pass(tc,t){return tc.ok.some(x=>t.includes(x));}
const rows=[];
for(let rep=1;rep<=repeats;rep++) for(const tc of cases) for(const level of ['minimal','low']){const x=await call(tc,level); rows.push({rep,id:tc.id,level,...x,pass:pass(tc,x.text)});}
const summary={}; for(const level of ['minimal','low']){const a=rows.filter(x=>x.level===level),ms=a.map(x=>x.ms).sort((x,y)=>x-y); summary[level]={n:a.length,pass:a.filter(x=>x.pass).length,passRate:a.filter(x=>x.pass).length/a.length,meanMs:Math.round(ms.reduce((s,x)=>s+x,0)/ms.length),p50Ms:ms[Math.floor((ms.length-1)*.5)],p95Ms:ms[Math.floor((ms.length-1)*.95)]};}
fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(`${OUT}/report.json`,JSON.stringify({model:MODEL,repeats,cases,summary,rows},null,2));
const md=['# Minimal vs Low / compact prompt','',`Model: ${MODEL}`,`Repeats: ${repeats}`,'', '| Level | Pass | Mean | P50 | P95 |','|---|---:|---:|---:|---:|',...Object.entries(summary).map(([k,v])=>`| ${k} | ${v.pass}/${v.n} | ${v.meanMs} ms | ${v.p50Ms} ms | ${v.p95Ms} ms |`),'','## Rows','',...rows.map(r=>`- ${r.level} / ${r.id} / ${r.ms}ms / ${r.pass?'PASS':'FAIL'} — ${r.text.replace(/\n/g,' ')}`)];fs.writeFileSync(`${OUT}/report.md`,md.join('\n'));console.log(JSON.stringify({summary,rows},null,2));
