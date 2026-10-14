import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.GEMINI_API_KEY;
if(!API_KEY) throw new Error('GEMINI_API_KEY is required');
const OUT='artifacts/minimal-vs-medium-calculation';
await fs.mkdir(OUT,{recursive:true});
const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';
const cases=[
{id:'rail-next-oita',cat:'rail',q:'今から別府駅から大分駅へ行く次に実際に乗れる列車を調べて。発車時刻、列車名または普通列車か、到着時刻を答えて。'},
{id:'rail-next-hakata',cat:'rail',q:'今から別府駅から博多駅へ行く次に実際に乗れる特急を調べて。別府発と博多着を答えて。'},
{id:'rail-deadline',cat:'rail',q:'今から別府駅を出て博多駅に16時30分までに着ける？次に乗れる列車を確認して判断して。'},
{id:'fx-now',cat:'fx',q:'現在の米ドル円（USD/JPY）は1ドル何円くらい？確認した値と、その値が何時点のものか分かる範囲で答えて。'},
{id:'fx-calc',cat:'fx_math',q:'現在の米ドル円を確認して、500ドルを円換算し、そこから3.25%の決済手数料を引いた受取額を円で計算して。1円未満は切り捨て。'},
{id:'fx-compare',cat:'fx',q:'現在の米ドル円を確認して、昨日の同じ時間帯と比べて円高か円安かを答えて。差が確認できないならその旨も言って。'},
{id:'stock-toyota',cat:'stock',q:'トヨタ自動車（7203）の現在の株価を確認して、100株の評価額を計算して。株価がリアルタイムか遅延値か、分かる範囲で基準時刻も答えて。'},
{id:'stock-softbank',cat:'stock',q:'ソフトバンクグループ（9984）の現在の株価を確認して、前日終値との差額と騰落率を計算して。'},
{id:'weather-evening',cat:'weather',q:'今日の別府市の18時から22時ごろの天気を確認して、徒歩で外出するなら傘を持つべきか判断して。降水確率や雨量が確認できるなら使って。'},
{id:'weather-tomorrow',cat:'weather',q:'明日の別府市で、朝8時と夜20時ではどちらが雨に遭う可能性が高い？現在の予報を確認して比較して。'},
{id:'apple-current',cat:'price',q:'Apple日本公式で現在のiPhone 17e 256GBの税込価格を確認して。発売時価格ではなく、今買う場合の価格を答えて。'},
{id:'python-current',cat:'version',q:'Pythonの現在の最新安定版を公式情報で確認して、バージョンと公開日を答えて。'},
{id:'margin-multi',cat:'math',q:'20着を50000円で販売。仕入れは1着1500円、国際送料8400円、決済手数料3.25%、梱包材600円。利益額と売上に対する利益率を求めて。手数料は1円未満切り捨て。'},
{id:'break-even',cat:'math',q:'1台29800円でPCを売る。仕入れ16500円、整備費2200円、送料1500円、決済手数料3.25%。固定広告費8000円も回収したい。何台売れば広告費込みで黒字になる？手数料は1円未満切り捨て。'},
{id:'mixed-cost',cat:'math',q:'月100件の問い合わせがあり、40%がPC、35%がHP、25%が着物。成約率がそれぞれ25%、12%、20%なら期待成約件数は合計何件？さらに1件あたり粗利益がPC8000円、HP45000円、着物6000円なら期待粗利益はいくら？'},
{id:'term-preserve',cat:'language',q:'「ブラウザ」「Cloudflare」「Windows Update」という用語はそのまま残して、初心者にも分かるように1文ずつ説明して。'}
];
const cfg={model:'gemini-3.5-flash-lite',thinkingConfig:{thinkingLevel:'medium'}};
const system=(now)=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在日時は ${now} です。`;
function body(sys,q){return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig:{thinkingConfig:cfg.thinkingConfig,temperature:0.1}};}
async function call(sys,q){const s=Date.now();const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(sys,q))});const j=await r.json();if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(j)}`);const c=j.candidates?.[0];const gm=c?.groundingMetadata||{};return {ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean),usage:j.usageMetadata||null};}
function norm(s){return s.replace(/[，,\s]/g,'');}
function pass(id,text){const t=norm(text);
 if(id==='apple-current') return /124800円/.test(t);
 if(id==='python-current') return /3\.15\.0/.test(text)&&/2026年10月9日/.test(text);
 if(id==='margin-multi') return /9375円/.test(t)&&/18\.75%/.test(text);
 if(id==='break-even') return /1台/.test(t);
 if(id==='mixed-cost') return /19\.2件/.test(text)&&(/278000円/.test(t)||/27万8000円/.test(t));
 if(id==='term-preserve') return ['ブラウザ','Cloudflare','WindowsUpdate'].every(x=>t.includes(x));
 return null;
}
const rows=[];
for(let rep=1;rep<=2;rep++){
 for(const tc of cases){
  const now=nowJst();
  const q=`現在日時は ${now}（日本時間）です。\n${tc.q}`;
  const answer=await call(system(now),q);
  rows.push({rep,id:tc.id,cat:tc.cat,now,deterministicPass:pass(tc.id,answer.text),answer});
 }
}
const ms=rows.map(x=>x.answer.ms).sort((a,b)=>a-b);const judged=rows.filter(x=>x.deterministicPass!==null);const thoughts=rows.map(x=>x.answer.usage?.thoughtsTokenCount||0);
const summary={model:cfg.model,thinking:'medium',n:rows.length,meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),p50Ms:ms[Math.floor((ms.length-1)*.5)],p95Ms:ms[Math.floor((ms.length-1)*.95)],searchRate:rows.filter(x=>x.answer.searches.length).length/rows.length,sourceRate:rows.filter(x=>x.answer.sources.length).length/rows.length,deterministicPass:`${judged.filter(x=>x.deterministicPass).length}/${judged.length}`,meanThoughtTokens:Math.round(thoughts.reduce((a,b)=>a+b,0)/thoughts.length)};
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({summary,rows},null,2));
let md='# Gemini 3.5 Flash-Lite medium hallucination stress test\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n';for(const r of rows)md+=`\n## ${r.id}/rep${r.rep}\n- ${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} pass=${r.deterministicPass}\n- ${r.answer.text}\n`;await fs.writeFile(path.join(OUT,'report.md'),md);console.log(JSON.stringify({summary,rows},null,2));