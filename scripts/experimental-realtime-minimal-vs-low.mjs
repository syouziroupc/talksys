import fs from 'node:fs';
import { currentJstInstruction, normalizeSpokenJapanese } from '../src/integrated-entry.js';

const KEY=String(process.env.GEMINI_API_KEY||'').trim();
const MODEL=String(process.env.AUDIT_MODEL||'gemini-3.5-flash-lite').trim();
const ENDPOINT='https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT='artifacts/realtime-minimal-vs-low';
const REPEATS=3;
if(!KEY) throw new Error('GEMINI_API_KEY is required');

function jstIso(now=new Date()){
  const d=new Date(now.getTime()+9*3600000); const p=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}
function text(payload={}){return (payload.steps||[]).filter(x=>x?.type==='model_output').flatMap(x=>x.content||[]).filter(x=>x?.type==='text').map(x=>x.text||'').join('').trim();}
function evidence(payload={}){const q=[],s=[];for(const step of payload.steps||[]){if(step?.type==='google_search_call')for(const x of step?.arguments?.queries||[])if(x&&!q.includes(x))q.push(x);if(step?.type==='google_search_result'){const rows=Array.isArray(step?.result)?step.result:(step?.result?.results||[]);for(const r of rows){const x=r?.url||r?.uri||r?.title||r?.name;if(x&&!s.includes(x))s.push(x);}}if(step?.type==='model_output')for(const p of step.content||[])for(const a of p.annotations||[])if(a?.type==='url_citation'){const x=a.url||a.title;if(x&&!s.includes(x))s.push(x);}}return{searched:q.length>0,queries:q,sources:s,sourceCount:s.length};}

const cases=[
 {id:'next-beppu-oita',kind:'transit',prompt:'今この時刻から、別府駅を出て大分駅へ行く次の列車の発車時刻と列車種別を教えてください。'},
 {id:'next-beppu-hakata',kind:'transit',prompt:'今この時刻から、別府駅を出て博多駅へ向かう次に乗れる特急列車の発車時刻を教えてください。'},
 {id:'beppu-weather',kind:'realtime',prompt:'今日の別府市の現在の天気と、このあとの天気傾向を短く教えてください。'},
 {id:'current-pm',kind:'realtime',prompt:'現在の日本の内閣総理大臣は誰ですか。公式情報を優先して答えてください。'},
 {id:'apple-current-price',kind:'realtime',prompt:'Apple日本公式の現在の購入ページを優先して、iPhone 17e 256GBの今の税込価格を教えてください。'},
 {id:'python-current-stable',kind:'realtime',prompt:'Python公式の現在のリリース情報を優先して、最新の安定版を教えてください。'},
];

function sys(tc,now){
  const iso=jstIso(now);
  const transit=tc.kind==='transit' ? `<transit>基準時刻は${iso}です。検索結果の発車時刻を必ず現在時刻と比較し、すでに発車した便を「次」として答えてはいけません。現在時刻以後に実際に乗れる便だけを答えてください。日付と時刻を検索条件に含め、JR九州など運行事業者の現行時刻表を優先します。</transit>`:'';
  return [
   '<role>あなたはTalkSysの日本語音声アシスタントです。電話でそのまま読み上げます。</role>',
   '<priority>最優先は現在の事実の正確さです。固有名詞、駅名、列車名、製品名、バージョンを保持します。</priority>',
   '<speech>通常2〜4文で本題から答えます。余計な前置きはしません。</speech>',
   `<time>${currentJstInstruction(now)}</time>`,
   '<grounding>Google検索を必ず使います。現在情報では古い記事や発表時点の情報ではなく、現行の公式ページ、時刻表、購入ページ、リリースページ等を優先します。根拠が取れない具体値は作りません。</grounding>',
   transit,
   '<final_check>回答前に現在時刻、質問条件、固有名詞、数値を確認し、確認過程は出力しません。</final_check>'
  ].filter(Boolean).join('\n');
}

async function call(tc,level){
  const now=new Date();
  const body={model:MODEL,input:`Google検索を使って現在の事実を確認して答えてください。利用者発言: ${tc.prompt}`,system_instruction:sys(tc,now),generation_config:{thinking_level:level},tools:[{type:'google_search'}]};
  const started=Date.now();
  const r=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const raw=await r.text(); if(!r.ok) throw new Error(`gemini_${r.status}:${raw.slice(0,500)}`);
  const payload=JSON.parse(raw); return {startedJst:jstIso(now),ms:Date.now()-started,text:normalizeSpokenJapanese(text(payload)),evidence:evidence(payload)};
}

const rows=[];
for(let rep=1;rep<=REPEATS;rep++) for(const tc of cases) for(const level of ['minimal','low']){
  try{const x=await call(tc,level); rows.push({rep,id:tc.id,kind:tc.kind,level,...x});}
  catch(e){rows.push({rep,id:tc.id,kind:tc.kind,level,startedJst:jstIso(),ms:null,text:'',evidence:{searched:false,queries:[],sources:[],sourceCount:0},error:String(e?.message||e)});}
}
function pct(vals,p){const a=[...vals].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.max(0,Math.ceil(a.length*p)-1))];}
const summary={};for(const level of ['minimal','low']){const a=rows.filter(x=>x.level===level&&Number.isFinite(x.ms)),m=a.map(x=>x.ms);summary[level]={samples:a.length,meanMs:Math.round(m.reduce((s,x)=>s+x,0)/m.length),p50Ms:pct(m,.5),p95Ms:pct(m,.95),searchRate:a.filter(x=>x.evidence.searched).length/a.length,sourceRate:a.filter(x=>x.evidence.sourceCount>0).length/a.length};}
fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(`${OUT}/report.json`,JSON.stringify({generatedAt:new Date().toISOString(),model:MODEL,repeats:REPEATS,summary,rows},null,2));
const md=['# Realtime minimal vs low','',`Model: ${MODEL}`,`Repeats: ${REPEATS}`,'',`Minimal mean ${summary.minimal.meanMs}ms / P50 ${summary.minimal.p50Ms} / P95 ${summary.minimal.p95Ms}`,`Low mean ${summary.low.meanMs}ms / P50 ${summary.low.p50Ms} / P95 ${summary.low.p95Ms}`,'','## Rows','',...rows.map(r=>`- ${r.level} / r${r.rep} / ${r.id} / ${r.ms ?? 'ERR'}ms / search=${r.evidence.searched} / sources=${r.evidence.sourceCount} / ${r.startedJst} — ${r.text.replace(/\n/g,' ')}`)];fs.writeFileSync(`${OUT}/report.md`,md.join('\n'));console.log(JSON.stringify({summary,rows:rows.map(r=>({rep:r.rep,id:r.id,level:r.level,ms:r.ms,search:r.evidence.searched,sources:r.evidence.sourceCount,startedJst:r.startedJst,text:r.text}))},null,2));
