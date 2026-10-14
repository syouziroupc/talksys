import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.AUDIT_MODEL || 'gemini-3.5-flash-lite';
if (!API_KEY) throw new Error('GEMINI_API_KEY is required');

const OUT = 'artifacts/prompt-minimization-sweep';
await fs.mkdir(OUT, { recursive: true });

const nowJst = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date()).replace(' ', 'T') + '+09:00';

const cases = [
  { id:'rail-beppu-oita', category:'rail', q:'今この時刻から別府駅を出て大分駅へ行く次に乗れる列車を1本だけ。発車時刻と列車種別を答えて。' },
  { id:'rail-beppu-hakata', category:'rail', q:'今この時刻から別府駅を出て博多駅へ行く次に乗れる特急を1本だけ。発車時刻と列車名を答えて。' },
  { id:'stock-toyota', category:'stock', q:'トヨタ自動車 7203 の現在の株価を円で答えて。取引時間外なら直近終値と、それがいつの値かを答えて。' },
  { id:'stock-sony', category:'stock', q:'ソニーグループ 6758 の現在の株価を円で答えて。取引時間外なら直近終値と、それがいつの値かを答えて。' },
  { id:'weather-beppu', category:'weather', q:'今の別府市の天気と気温を簡潔に答えて。' },
  { id:'weather-tokyo', category:'weather', q:'今の東京都心の天気と気温を簡潔に答えて。' },
  { id:'apple-price', category:'price', q:'Apple日本公式で現在販売中のiPhone 17e 256GBの税込価格はいくら？' },
  { id:'python-stable', category:'software', q:'Python公式の現在の最新安定版は何？' },
  { id:'japan-pm', category:'officeholder', q:'現在の日本の内閣総理大臣は誰？' },
];

const prompts = {
  bare: `あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在時刻は {{NOW}} です。`,
  search: `あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在時刻は {{NOW}} です。現在情報はGoogle検索で確認してください。`,
  grounded: `あなたは電話向けAIです。日本語で正確かつ簡潔に答えてください。現在時刻は {{NOW}} です。現在情報はGoogle検索で確認し、確認できた内容に基づいて答えてください。`,
};

function reqBody(system, q, level='minimal') {
  return {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role:'user', parts:[{ text:q }] }],
    tools: [{ google_search: {} }],
    generationConfig: { thinkingConfig: { thinkingLevel: level }, temperature: 0.1 },
  };
}

async function call(system, q, level='minimal') {
  const started = Date.now();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(reqBody(system,q,level))
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  const c = j.candidates?.[0];
  const text = (c?.content?.parts || []).map(p=>p.text||'').join('').trim();
  const gm = c?.groundingMetadata || {};
  return {
    ms: Date.now()-started,
    text,
    searches: gm.webSearchQueries || [],
    sources: (gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean),
  };
}

function obviousIssue(row) {
  const t = row.answer.text;
  const now = new Date(row.now);
  const hh = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',hour12:false}).format(now));
  const mm = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',minute:'2-digit'}).format(now));
  if (row.category === 'rail') {
    const m = t.match(/(\d{1,2})[:時](\d{2})/);
    if (m) {
      const ans = Number(m[1])*60 + Number(m[2]);
      const cur = hh*60 + mm;
      if (ans < cur) return 'past_train';
    }
  }
  if (row.id === 'python-stable' && !/(3[\.点]15(?:[\.点]0)?)/.test(t)) return 'python_version';
  if (row.id === 'japan-pm' && !/高市/.test(t)) return 'pm';
  if (row.id === 'apple-price' && !/124[,，]?800/.test(t)) return 'apple_price';
  if (row.answer.searches.length === 0) return 'no_search';
  if (row.answer.sources.length === 0) return 'no_source';
  return null;
}

const rows=[];
for (let rep=1; rep<=3; rep++) {
  for (const tc of cases) {
    for (const [promptId,prompt] of Object.entries(prompts)) {
      const now = nowJst();
      const answer = await call(prompt.replace('{{NOW}}', now), tc.q, 'minimal');
      const row = { rep, id:tc.id, category:tc.category, prompt:promptId, now, answer };
      row.obviousIssue = obviousIssue(row);
      rows.push(row);
    }
  }
}

const summary={};
for (const promptId of Object.keys(prompts)) {
  const xs=rows.filter(r=>r.prompt===promptId);
  const ms=xs.map(x=>x.answer.ms).sort((a,b)=>a-b);
  const issues=xs.filter(x=>x.obviousIssue);
  summary[promptId]={
    n:xs.length,
    meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),
    p50Ms:ms[Math.floor((ms.length-1)*0.5)],
    p95Ms:ms[Math.floor((ms.length-1)*0.95)],
    searchRate:xs.filter(x=>x.answer.searches.length>0).length/xs.length,
    sourceRate:xs.filter(x=>x.answer.sources.length>0).length/xs.length,
    obviousIssues:issues.length,
    issueTypes:Object.fromEntries([...new Set(issues.map(x=>x.obviousIssue))].map(k=>[k,issues.filter(x=>x.obviousIssue===k).length])),
  };
}

const report={model:MODEL, generatedAt:new Date().toISOString(), prompts, summary, rows};
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
let md='# Prompt minimization sweep\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n\n';
for (const r of rows) md += `## ${r.id} / ${r.prompt} / rep ${r.rep}\n- ${r.answer.ms} ms / search=${r.answer.searches.length} / sources=${r.answer.sources.length}\n- issue=${r.obviousIssue||'none'}\n- ${r.answer.text}\n\n`;
await fs.writeFile(path.join(OUT,'report.md'),md);
console.log(JSON.stringify({summary, rows},null,2));
