import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.GEMINI_API_KEY;
if(!API_KEY) throw new Error('GEMINI_API_KEY is required');
const MODEL='gemini-3.5-flash-lite';
const OUT='artifacts/minimal-vs-medium-calculation';
await fs.mkdir(OUT,{recursive:true});

const nowJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')+'+09:00';
const cases=[
{id:'rail-next-oita',cat:'rail',q:'今から別府駅から大分駅へ行く次に実際に乗れる列車を調べて。発車時刻、列車名または普通列車か、到着時刻を答えて。'},
{id:'rail-next-hakata',cat:'rail',q:'今から別府駅から博多駅へ行く次に実際に乗れる特急を調べて。別府発と博多着を答えて。'},
{id:'rail-deadline',cat:'dynamic_reasoning',q:'今から別府駅を出て博多駅に16時30分までに着ける？次に乗れる列車を確認して判断して。'},
{id:'fx-now',cat:'fx',q:'現在の米ドル円（USD/JPY）は1ドル何円くらい？確認した値と、その値が何時点のものか分かる範囲で答えて。'},
{id:'fx-calc',cat:'dynamic_math',q:'現在の米ドル円を確認して、500ドルを円換算し、そこから3.25%の決済手数料を引いた受取額を円で計算して。1円未満は切り捨て。'},
{id:'fx-compare',cat:'dynamic_reasoning',q:'現在の米ドル円を確認して、昨日の同じ時間帯と比べて円高か円安かを答えて。差が確認できないならその旨も言って。'},
{id:'stock-toyota',cat:'dynamic_math',q:'トヨタ自動車（7203）の現在の株価を確認して、100株の評価額を計算して。株価がリアルタイムか遅延値か、分かる範囲で基準時刻も答えて。'},
{id:'stock-softbank',cat:'dynamic_math',q:'ソフトバンクグループ（9984）の現在の株価を確認して、前日終値との差額と騰落率を計算して。'},
{id:'weather-evening',cat:'weather',q:'今日の別府市の18時から22時ごろの天気を確認して、徒歩で外出するなら傘を持つべきか判断して。降水確率や雨量が確認できるなら使って。'},
{id:'weather-tomorrow',cat:'weather',q:'明日の別府市で、朝8時と夜20時ではどちらが雨に遭う可能性が高い？現在の予報を確認して比較して。'},
{id:'apple-current',cat:'price',q:'Apple日本公式で現在のiPhone 17e 256GBの税込価格を確認して。発売時価格ではなく、今買う場合の価格を答えて。'},
{id:'python-current',cat:'version',q:'Pythonの現在の最新安定版を公式情報で確認して、バージョンと公開日を答えて。'},
{id:'margin-multi',cat:'math',q:'20着を50000円で販売。仕入れは1着1500円、国際送料8400円、決済手数料3.25%、梱包材600円。利益額と売上に対する利益率を求めて。手数料は1円未満切り捨て。'},
{id:'break-even',cat:'math',q:'1台29800円でPCを売る。仕入れ16500円、整備費2200円、送料1500円、決済手数料3.25%。固定広告費8000円も回収したい。何台売れば広告費込みで黒字になる？手数料は1円未満切り捨て。'},
{id:'mixed-cost',cat:'math',q:'月100件の問い合わせがあり、40%がPC、35%がHP、25%が着物。成約率がそれぞれ25%、12%、20%なら期待成約件数は合計何件？さらに1件あたり粗利益がPC8000円、HP45000円、着物6000円なら期待粗利益はいくら？'},
{id:'latency-budget',cat:'math',q:'STT 1.8秒、LLM 1.2秒、TTS開始0.5秒が完全直列。体感3秒以内にするには最低何秒短縮が必要？LLMだけで吸収するならLLMは何秒以下必要？'},
{id:'term-preserve',cat:'language',q:'「ブラウザ」「Cloudflare」「Windows Update」という用語はそのまま残して、初心者にも分かるように1文ずつ説明して。'}
];

const variants={
 current_medium:{improved:false,selectiveHigh:false},
 improved_medium:{improved:true,selectiveHigh:false},
 improved_selective_high:{improved:true,selectiveHigh:true}
};
const system=(now)=>`あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在日時は ${now} です。`;
const hardCats=new Set(['dynamic_reasoning','dynamic_math']);
const dynamicCats=new Set(['rail','dynamic_reasoning','dynamic_math','fx','stock','weather','price','version']);

function buildBody(sys,q,thinking,improved){
 const generationConfig={thinkingConfig:{thinkingLevel:thinking}};
 if(!improved) generationConfig.temperature=0.1;
 return {system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:q}]}],tools:[{google_search:{}}],generationConfig};
}

async function geminiCall(sys,q,thinking,improved){
 const s=Date.now();
 const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(buildBody(sys,q,thinking,improved))});
 const j=await r.json();
 if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(j)}`);
 const c=j.candidates?.[0];
 const gm=c?.groundingMetadata||{};
 return {ms:Date.now()-s,text:(c?.content?.parts||[]).map(p=>p.text||'').join('').trim(),searches:gm.webSearchQueries||[],sources:(gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean),groundingSupports:gm.groundingSupports||[],usage:j.usageMetadata||null};
}

function localMath(id){
 if(id==='margin-multi'){
  const revenue=50000,cost=1500*20+8400+600,fee=Math.floor(revenue*0.0325),profit=revenue-cost-fee;
  return `利益額は${profit.toLocaleString('ja-JP')}円、利益率は${(profit/revenue*100).toFixed(2)}%です。内訳は、仕入れ30,000円、送料8,400円、梱包材600円、決済手数料${fee.toLocaleString('ja-JP')}円です。`;
 }
 if(id==='break-even'){
  const revenue=29800,fee=Math.floor(revenue*0.0325),margin=revenue-16500-2200-1500-fee,n=Math.floor(8000/margin)+1;
  return `1台あたりの粗利益は${margin.toLocaleString('ja-JP')}円なので、広告費8,000円を回収して黒字になるのは${n}台です。`;
 }
 if(id==='mixed-cost'){
  const pc=100*.4*.25,hp=100*.35*.12,kimono=100*.25*.2,total=pc+hp+kimono,profit=pc*8000+hp*45000+kimono*6000;
  return `期待成約件数は合計${total}件、期待粗利益は${profit.toLocaleString('ja-JP')}円です。`;
 }
 if(id==='latency-budget'){
  const total=1.8+1.2+.5,cut=total-3,llm=1.2-cut;
  return `合計は${total.toFixed(1)}秒なので、3秒以内には最低${cut.toFixed(1)}秒の短縮が必要です。LLMだけで吸収するならLLMは${llm.toFixed(1)}秒以下が必要です。`;
 }
 return null;
}

function parseHHMM(text){
 const m=text.match(/(?:^|[^0-9])(\d{1,2})[:時](\d{2})/);
 return m?{h:Number(m[1]),m:Number(m[2])}:null;
}
function nowMinutes(now){const d=new Date(now);return d.getUTCHours()*60+d.getUTCMinutes()+9*60>=1440?d.getUTCHours()*60+d.getUTCMinutes()+9*60-1440:d.getUTCHours()*60+d.getUTCMinutes()+9*60;}
function shouldRetry(tc,ans,now){
 if(!dynamicCats.has(tc.cat)) return false;
 if(ans.sources.length===0 || ans.searches.length===0) return true;
 if(tc.cat==='rail' || tc.id==='rail-deadline'){
  const t=parseHHMM(ans.text); if(t){const dep=t.h*60+t.m; if(dep<nowMinutes(now)-1) return true;}
 }
 if(tc.id==='stock-toyota'||tc.id==='stock-softbank'||tc.id==='fx-now'||tc.id==='fx-calc'){
  const t=parseHHMM(ans.text); if(t){const age=nowMinutes(now)-(t.h*60+t.m); if(age>90 && age<720) return true;}
 }
 return false;
}

function norm(s){return s.replace(/[，,\s]/g,'');}
function pass(id,text){const t=norm(text);
 if(id==='apple-current') return /124800円/.test(t);
 if(id==='python-current') return /3\.15\.0/.test(text)&&/2026年10月9日/.test(text);
 if(id==='margin-multi') return /9375円/.test(t)&&/18\.75%/.test(text);
 if(id==='break-even') return /1台/.test(t);
 if(id==='mixed-cost') return /19\.2件/.test(text)&&(/299000円/.test(t)||/29万9000円/.test(t));
 if(id==='latency-budget') return /0\.5秒/.test(text)&&/0\.7秒/.test(text);
 if(id==='term-preserve') return ['ブラウザ','Cloudflare','WindowsUpdate'].every(x=>t.includes(x));
 return null;
}

const rows=[];
for(let rep=1;rep<=2;rep++){
 for(const tc of cases){
  for(const [variant,opt] of Object.entries(variants)){
   const now=nowJst();
   const q=`現在日時は ${now}（日本時間）です。\n${tc.q}`;
   const thinking=opt.selectiveHigh&&hardCats.has(tc.cat)?'high':'medium';
   let answer,retried=false,local=false;
   const localAnswer=opt.improved?localMath(tc.id):null;
   if(localAnswer){answer={ms:0,text:localAnswer,searches:[],sources:[],groundingSupports:[],usage:null};local=true;}
   else {
    answer=await geminiCall(system(now),q,thinking,opt.improved);
    if(opt.improved&&shouldRetry(tc,answer,now)){
      retried=true;
      const retryQ=`現在日時は ${now}（日本時間）です。\n${tc.q}\n直前の回答は使わず、現在時点の検索結果をもう一度確認して答えてください。`;
      const second=await geminiCall(system(now),retryQ,thinking,true);
      answer={...second,ms:answer.ms+second.ms};
    }
   }
   rows.push({rep,id:tc.id,cat:tc.cat,variant,thinking,now,retried,local,deterministicPass:pass(tc.id,answer.text),answer});
  }
 }
}

const summary={};
for(const variant of Object.keys(variants)){
 const xs=rows.filter(r=>r.variant===variant),ms=xs.map(x=>x.answer.ms).sort((a,b)=>a-b),judged=xs.filter(x=>x.deterministicPass!==null),thoughts=xs.map(x=>x.answer.usage?.thoughtsTokenCount||0);
 summary[variant]={n:xs.length,meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),p50Ms:ms[Math.floor((ms.length-1)*.5)],p95Ms:ms[Math.floor((ms.length-1)*.95)],searchRate:xs.filter(x=>x.answer.searches.length).length/xs.length,sourceRate:xs.filter(x=>x.answer.sources.length).length/xs.length,retryRate:xs.filter(x=>x.retried).length/xs.length,localCalcRate:xs.filter(x=>x.local).length/xs.length,deterministicPass:`${judged.filter(x=>x.deterministicPass).length}/${judged.length}`,meanThoughtTokens:Math.round(thoughts.reduce((a,b)=>a+b,0)/thoughts.length)};
}
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify({model:MODEL,summary,rows},null,2));
let md='# Medium current vs improved vs selective high\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n';
for(const r of rows) md+=`\n## ${r.id}/${r.variant}/rep${r.rep}\n- thinking=${r.thinking} ${r.answer.ms}ms search=${r.answer.searches.length} sources=${r.answer.sources.length} retry=${r.retried} local=${r.local} pass=${r.deterministicPass}\n- ${r.answer.text}\n`;
await fs.writeFile(path.join(OUT,'report.md'),md);
console.log(JSON.stringify({summary,rows},null,2));