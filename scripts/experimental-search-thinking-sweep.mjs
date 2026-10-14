import fs from 'node:fs';
import { currentJstInstruction, normalizeSpokenJapanese } from '../src/integrated-entry.js';

const KEY = String(process.env.GEMINI_API_KEY || '').trim();
const MODEL = String(process.env.AUDIT_MODEL || 'gemini-3.5-flash-lite').trim();
const REPEATS = Math.max(1, Number(process.env.REPEATS || 5));
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT = 'artifacts/search-thinking-sweep';
const LEVELS = ['low','medium'];
if (!KEY) throw new Error('GEMINI_API_KEY is required');

const now = new Date();
function compact(v,max=20000){return String(v??'').replace(/\r/g,'').replace(/[\t ]+/g,' ').replace(/\n{3,}/g,'\n\n').trim().slice(0,max)}
function outputText(payload={}){return compact((Array.isArray(payload?.steps)?payload.steps:[]).filter(s=>s?.type==='model_output').flatMap(s=>Array.isArray(s?.content)?s.content:[]).filter(p=>p?.type==='text'&&typeof p?.text==='string').map(p=>p.text).join(''),20000)}
function evidence(payload={}){const queries=[];const sources=[];for(const step of Array.isArray(payload?.steps)?payload.steps:[]){if(step?.type==='google_search_call'){for(const q of Array.isArray(step?.arguments?.queries)?step.arguments.queries:[]){const x=compact(q,300);if(x&&!queries.includes(x))queries.push(x)}}if(step?.type==='google_search_result'){const rows=Array.isArray(step?.result)?step.result:(Array.isArray(step?.result?.results)?step.result.results:[]);for(const item of rows){const x=compact(item?.url||item?.uri||item?.title||item?.name,500);if(x&&!sources.includes(x))sources.push(x)}}if(step?.type==='model_output')for(const part of Array.isArray(step?.content)?step.content:[])for(const a of Array.isArray(part?.annotations)?part.annotations:[])if(a?.type==='url_citation'){const x=compact(a?.url||a?.title,500);if(x&&!sources.includes(x))sources.push(x)}}return{searched:queries.length>0,sourceCount:sources.length,queries,sources}}
function norm(v=''){return String(v).replace(/[，,\s]/g,'').replace(/点/g,'.').toLowerCase()}

const cases=[
 {id:'apple-current-price',prompt:'Apple日本公式の現在の購入ページを優先して、iPhone 17e 256GBの今の税込価格を確認してください。古い発売時価格ではなく、現在購入できる価格だけを短く答えてください。',validate:t=>{const s=norm(t);return s.includes('124800')||s.includes('12万4800')}},
 {id:'python-current-stable',prompt:'Python公式の現在のダウンロード・リリース情報を優先して、最新の安定版系統を短く教えてください。',validate:t=>norm(t).includes('3.15')},
 {id:'japan-current-pm',prompt:'首相官邸の現在の公式情報を優先して、日本の現在の内閣総理大臣の氏名を答えてください。',validate:t=>t.includes('高市')&&t.includes('早苗')},
 {id:'cloudflare-current-ceo',prompt:'Cloudflare公式の現在のLeadershipまたは会社情報を優先して、現在のCEOの氏名を答えてください。',validate:t=>/Matthew\s*Prince/i.test(t)||t.includes('マシュー・プリンス')||t.includes('マシュー プリンス')},
 {id:'japan-current-consumption-tax',prompt:'国税庁の現在の公式情報を優先して、日本の消費税の標準税率を答えてください。軽減税率ではなく標準税率です。',validate:t=>norm(t).includes('10%')||norm(t).includes('10％')||t.includes('10パーセント')},
];

const system=[
 '<role>あなたはTalkSysの日本語音声アシスタントです。電話でそのまま読み上げます。</role>',
 '<priority>質問条件と現在の事実を最優先します。固有名詞・製品名・公式名称を保持します。</priority>',
 `<time>${currentJstInstruction(now)}</time>`,
 '<grounding>Google検索を使い、現在の根拠で答えます。現在値は古いニュースや発売時記事ではなく、現行の公式Store、download/release、Leadership、政府・官公庁ページなど質問に直接対応する一次情報を最優先します。検索結果の日時と対象条件を照合し、古い値を現在値として使いません。</grounding>',
 '<speech>通常1〜3文。本題から答え、検索過程は説明しません。</speech>',
 '<final_check>答える直前に、質問対象・現在性・数値・固有名詞が検索根拠と一致するか確認します。</final_check>',
].join('\n');

async function call(tc,level){const body={model:MODEL,input:`Google検索を使って現在の公式情報を確認してから答えてください。利用者発言: ${tc.prompt}`,system_instruction:system,tools:[{type:'google_search'}],generation_config:{thinking_level:level}};const started=Date.now();const res=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const raw=await res.text();if(!res.ok)throw new Error(`gemini_${res.status}:${compact(raw,900)}`);const payload=JSON.parse(raw);return{text:normalizeSpokenJapanese(outputText(payload)),ms:Date.now()-started,evidence:evidence(payload)}}
function percentile(values,p){if(!values.length)return null;const xs=[...values].sort((a,b)=>a-b);return xs[Math.min(xs.length-1,Math.max(0,Math.ceil(p*xs.length)-1))]}

const rows=[];
for(let repeat=1;repeat<=REPEATS;repeat++)for(const tc of cases)for(const level of LEVELS){try{const r=await call(tc,level);rows.push({repeat,id:tc.id,level,pass:Boolean(tc.validate(r.text)),text:r.text,ms:r.ms,evidence:r.evidence,error:null})}catch(err){rows.push({repeat,id:tc.id,level,pass:false,text:'',ms:null,evidence:{searched:false,sourceCount:0,queries:[],sources:[]},error:String(err?.message||err)})}}
const summary={};for(const level of LEVELS){const rs=rows.filter(r=>r.level===level&&Number.isFinite(r.ms));const ms=rs.map(r=>r.ms);summary[level]={samples:rs.length,pass:rs.filter(r=>r.pass).length,passRate:rs.filter(r=>r.pass).length/rs.length,meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),p50Ms:percentile(ms,.5),p95Ms:percentile(ms,.95),searchExecutedRate:rs.filter(r=>r.evidence.searched).length/rs.length,sourcePresentRate:rs.filter(r=>r.evidence.sourceCount>0).length/rs.length}}
const report={generatedAt:new Date().toISOString(),model:MODEL,repeats:REPEATS,summary,rows};fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));
const lines=['# Search thinking-level sweep','',`- Generated: ${report.generatedAt}`,`- Model: ${MODEL}`,`- Repeats: ${REPEATS}`,'','| Level | Pass | Mean | P50 | P95 | Search | Source |','|---|---:|---:|---:|---:|---:|---:|'];for(const [lv,s] of Object.entries(summary))lines.push(`| ${lv} | ${(s.passRate*100).toFixed(1)}% (${s.pass}/${s.samples}) | ${s.meanMs} ms | ${s.p50Ms} ms | ${s.p95Ms} ms | ${(s.searchExecutedRate*100).toFixed(1)}% | ${(s.sourcePresentRate*100).toFixed(1)}% |`);lines.push('','## Failures','');for(const r of rows.filter(x=>!x.pass))lines.push(`- ${r.level} r${r.repeat} ${r.id}: ${r.ms??'ERR'}ms sources=${r.evidence.sourceCount}; ${compact(r.text,500)} error=${r.error??'-'}`);lines.push('','## All runs','');for(const r of rows)lines.push(`- ${r.level} r${r.repeat} ${r.id}: ${r.pass?'PASS':'FAIL'} ${r.ms??'ERR'}ms sources=${r.evidence.sourceCount}; ${compact(r.text,300)}`);fs.writeFileSync(`${OUT}/report.md`,lines.join('\n'));console.log(JSON.stringify({summary,failures:rows.filter(x=>!x.pass).map(x=>({level:x.level,repeat:x.repeat,id:x.id,ms:x.ms,text:compact(x.text,240),sources:x.evidence.sourceCount,error:x.error}))},null,2));
