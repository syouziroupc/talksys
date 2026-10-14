import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.AUDIT_MODEL || 'gemini-3.5-flash-lite';
if (!API_KEY) throw new Error('GEMINI_API_KEY is required');

const OUT = 'artifacts/dynamic-grounding-strategies';
await fs.mkdir(OUT, { recursive: true });

const nowJst = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date()).replace(' ', 'T') + '+09:00';

const cases = [
  { id:'rail-beppu-oita', category:'rail', q:'今この時刻から別府駅を出て大分駅へ行く次に乗れる列車を1本だけ。発車時刻と列車種別を答えて。', risk:'realtime' },
  { id:'rail-beppu-hakata', category:'rail', q:'今この時刻から別府駅を出て博多駅へ行く次に乗れる特急を1本だけ。発車時刻と列車名を答えて。', risk:'realtime' },
  { id:'stock-toyota', category:'stock', q:'トヨタ自動車 7203 の現在の株価を円で答えて。取引時間外なら直近終値と、それがいつの値かを答えて。', risk:'realtime' },
  { id:'stock-sony', category:'stock', q:'ソニーグループ 6758 の現在の株価を円で答えて。取引時間外なら直近終値と、それがいつの値かを答えて。', risk:'realtime' },
  { id:'weather-beppu', category:'weather', q:'今の別府市の天気と気温を簡潔に答えて。', risk:'realtime' },
  { id:'weather-tokyo', category:'weather', q:'今の東京都心の天気と気温を簡潔に答えて。', risk:'realtime' },
  { id:'apple-price', category:'price', q:'Apple日本公式で現在販売中のiPhone 17e 256GBの税込価格はいくら？', risk:'current' },
  { id:'python-stable', category:'software', q:'Python公式の現在の最新安定版は何？', risk:'current' },
  { id:'japan-pm', category:'officeholder', q:'現在の日本の内閣総理大臣は誰？', risk:'current' },
];

const prompts = {
  plain: `あなたは電話向けAIです。日本語で簡潔に答えてください。現在情報はGoogle検索で確認してください。現在時刻は {{NOW}} です。`,
  guarded: `あなたは電話向けAIです。日本語で簡潔に答えてください。現在時刻は {{NOW}} です。\n現在情報・価格・株価・天気・交通・最新版・現職者はGoogle検索で確認してください。\n検索結果にない具体的な数字・時刻・価格・氏名・バージョンを推測で作らないでください。\n現在値では古いニュース記事より、現在有効な公式ページ・運行ページ・市場情報・最新観測を優先してください。\n現在時刻より前の列車を「次」として答えないでください。\n複数の候補が矛盾する場合は断定せず、最も新しく直接的な情報を優先してください。`,
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
    searches: (gm.webSearchQueries||[]),
    sources: (gm.groundingChunks||[]).map(x=>x.web?.uri).filter(Boolean),
  };
}

async function verify(original, q, now) {
  const sys = `あなたは検索回答の検証器です。現在時刻は ${now}。Google検索を使い、元回答の具体的な数値・時刻・価格・氏名が現在の情報と一致するか検証してください。古い情報や検索断片の取り違えを見逃さないでください。JSONだけで返してください。形式: {"verdict":"pass|fail|uncertain","reason":"短い理由","corrected":"必要なら訂正版、不要なら空文字"}`;
  const prompt = `質問: ${q}\n元回答: ${original}`;
  const r = await call(sys, prompt, 'low');
  let parsed = null;
  try { parsed = JSON.parse(r.text.replace(/^```json\s*|\s*```$/g,'')); } catch {}
  return { ...r, parsed };
}

const strategies = [
  { id:'plain_once', prompt:'plain', verify:false },
  { id:'guarded_once', prompt:'guarded', verify:false },
  { id:'guarded_verify', prompt:'guarded', verify:true },
];

const rows=[];
for (let rep=1; rep<=2; rep++) {
  for (const tc of cases) {
    for (const st of strategies) {
      const now = nowJst();
      const system = prompts[st.prompt].replace('{{NOW}}', now);
      const first = await call(system, tc.q, 'minimal');
      let finalText = first.text;
      let check = null;
      if (st.verify) {
        check = await verify(first.text, tc.q, now);
        if (check.parsed?.verdict === 'fail' && check.parsed.corrected) finalText = check.parsed.corrected;
      }
      rows.push({ rep, case:tc.id, category:tc.category, strategy:st.id, now, first, verify:check, finalText, totalMs:first.ms+(check?.ms||0) });
    }
  }
}

const summary={};
for (const st of strategies) {
  const xs=rows.filter(r=>r.strategy===st.id);
  const ms=xs.map(x=>x.totalMs).sort((a,b)=>a-b);
  const verdicts=xs.map(x=>x.verify?.parsed?.verdict).filter(Boolean);
  summary[st.id]={
    n:xs.length,
    meanMs:Math.round(ms.reduce((a,b)=>a+b,0)/ms.length),
    p50Ms:ms[Math.floor((ms.length-1)*0.5)],
    p95Ms:ms[Math.floor((ms.length-1)*0.95)],
    searchRate:xs.filter(x=>x.first.searches.length>0).length/xs.length,
    sourceRate:xs.filter(x=>x.first.sources.length>0).length/xs.length,
    verifyPass:verdicts.filter(v=>v==='pass').length,
    verifyFail:verdicts.filter(v=>v==='fail').length,
    verifyUncertain:verdicts.filter(v=>v==='uncertain').length,
  };
}

const report={model:MODEL, generatedAt:new Date().toISOString(), summary, rows};
await fs.writeFile(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
let md='# Dynamic grounding strategies\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n\n';
for (const r of rows) md += `## ${r.case} / ${r.strategy} / rep ${r.rep}\n- total: ${r.totalMs} ms\n- search: ${r.first.searches.length}, sources: ${r.first.sources.length}\n- answer: ${r.finalText}\n${r.verify?.parsed ? `- verify: ${JSON.stringify(r.verify.parsed)}\n` : ''}\n`;
await fs.writeFile(path.join(OUT,'report.md'),md);
console.log(JSON.stringify({summary, sample:rows.slice(0,6)},null,2));
