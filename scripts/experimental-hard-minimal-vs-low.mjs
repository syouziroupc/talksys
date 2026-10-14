import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.GEMINI_API_KEY;
const MODEL=process.env.AUDIT_MODEL||'gemini-3.5-flash-lite';
if(!API_KEY) throw new Error('GEMINI_API_KEY is required');
const OUT='artifacts/hard-minimal-vs-low';
await fs.mkdir(OUT,{recursive:true});
const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';

const cases=[
 {id:'rail-deadline',cat:'dynamic_reasoning',q:'今から別府駅を出て博多駅へ行きたい。15時30分までに着ける列車があるなら、次に乗れる現実的な経路を1つだけ、別府の発車時刻・博多の到着時刻・乗換の有無で答えて。なければ無理と言って。'},
 {id:'apple-cheapest-compare',cat:'dynamic_reasoning',q:'Apple日本公式で今買える新品iPhoneのうち最安モデルを特定して、その最小容量と税込価格を答えて。さらにiPhone 17e 256GBとの差額も計算して。'},
 {id:'python-current',cat:'dynamic_reasoning',q:'Pythonの現在の最新安定版を公式情報で確認して、バージョン、公開日、3.14系より新しいかを簡潔に答えて。'},
 {id:'cloudflare-workers',cat:'dynamic_reasoning',q:'Cloudflare Workersを個人の小規模APIに使う場合、現在のFreeプランで主に何が上限になりやすい？公式情報を踏まえて、リクエスト数とCPU時間の観点から答えて。'},
 {id:'tax-calc',cat:'calculation',q:'税込19,800円、消費税率10%の取引について、税抜価格と消費税相当額を円単位で答えて。計算過程は短く。',expect:['18000','1800']},
 {id:'margin-calc',cat:'calculation',q:'商品を50,000円で販売し、仕入れ30,000円、送料8,400円、決済手数料3.25%が売上に対してかかる。その他費用なしとして、利益はいくら？円未満は四捨五入。',expect:['996?','9975']},
 {id:'logic-conditions',cat:'logic',q:'条件A: 8世代以降のCore i5またはi7。条件B: RAM 8GB以上。条件C: SSD 256GB以上。候補は①i7-7600U/16GB/512GB、②i5-8365U/8GB/256GB、③i3-10110U/16GB/512GB。条件を全部満たすものだけ番号で答えて。',expect:['②']},
 {id:'sql-idempotency',cat:'technical',q:'SQLiteで予約通知先を登録する処理が再実行されても同じuser_idを重複登録したくない。user_idにUNIQUE制約がある前提で、最も単純なINSERT文を1行だけ示して。',expect:['INSERT OR IGNORE']},
 {id:'http-retry',cat:'technical',q:'外部TTS APIが502を返すことがある。電話会話の遅延を増やしすぎず一時障害だけ吸収したい。無制限retryは不可。実装方針を3文以内で答えて。'},
 {id:'context-correction',cat:'reasoning',q:'さっき「100万6万3808人」と読んだ数字は1,063,808だった。日本語として自然な読み方に直して、数字表記も併記して。',expect:['106万3808','1,063,808']},
 {id:'percentage',cat:'calculation',q:'52,200円の売上から3.25%の決済手数料が引かれる。手数料と入金額をそれぞれ円未満四捨五入で答えて。',expect:['1697','50503']},
 {id:'compare-technical',cat:'reasoning',q:'音声AIで、STTが2秒、LLMが1.4秒、TTS開始まで0.6秒かかる。完全直列ならユーザー発話終了から音声応答開始まで何秒？LLMを0.5秒短縮した場合の改善率も答えて。',expect:['4.0','12.5']}
];

const variants=[{id:'minimal',thinking:'minimal'},{id:'low',thinking:'low'}];
const system=(now)=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在日時は ${now} です。`;
function body(sys,q,thinking){return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig:{thinkingConfig:{thinkingLevel:thinking},temperature:0.1}};}
async function call(sys,q,thinking){const s=Date.now();const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(sys,q,thinking))});const j=await r.json();if(!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);const c=j.candidates?.[0];const gm=c?.groundingMetadata||{};return {ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean)};}
function deterministicPass(tc,text){if(!tc.expect)return null;if(tc.id==='margin-calc') return /9[,，]?975/.test(text);return tc.expect.every(x=>text.includes(x));}
const rows=[];
for(let rep=1;rep<=2;rep++) for(const tc of cases) for(const v of variants){const now=nowJst();const uq=`現在日時は ${now}（日本時間）です。\n${tc.q}`;const answer=await call(system(now),uq,v.thinking);rows.push({rep,id:tc.id,cat:tc.cat,variant:v.id,now,deterministicPass:deterministicPass(tc,answer.text),answer});}
const summary={};for(const v of variants){const xs=rows.filter(r=>r.variant===v.id);const a=xs.map(x=>x.answer.ms).sort((x,y)=>x-y);const scored=xs.filter(x=>x.deterministicPass!==null);summary[v.id]={n:xs.length,meanMs:Math.round(a.reduce((s,x)=>s+x,0)/a.length),p50Ms:a[Math.floor((a.length-1)*.5)],p95Ms:a[Math.floor((a.length-1)*.95)],searchRate:xs.filter(x=>x.answer.searches.length).length/xs.length,sourceRate:xs.filter(x=>x.answer.sources.length).length/xs.length,deterministicPass:`${scored.filter(x=>x.deterministicPass).length}/${scored.length}`};}
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({model:MODEL,summary,rows},null,2));let md='# Hard minimal vs low\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n';for(const r of rows)md+=`\n## ${r.id} / ${r.variant} / rep${r.rep}\n- latency=${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} deterministic=${r.deterministicPass}\n- ${r.answer.text}\n`;await fs.writeFile(path.join(OUT,'report.md'),md);console.log(JSON.stringify({summary,rows},null,2));