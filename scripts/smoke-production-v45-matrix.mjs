import { writeFile } from 'node:fs/promises';

const BASE = process.env.TALKSYS_URL || 'https://talksys.syouziroupc.workers.dev';
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.SMOKE_CONCURRENCY || 3)));
const TIMEOUT_MS = Math.max(15000, Number(process.env.SMOKE_TIMEOUT_MS || 90000));

const cases = [
  { id:'weather_beppu', group:'api', text:'別府市の今日の天気は？', tools:['jma_weather'], expectSearch:false },
  { id:'weather_tokyo_tomorrow', group:'api', text:'東京の明日の天気と最高気温は？', tools:['jma_weather'], expectSearch:false },
  { id:'fx_usdjpy', group:'api', text:'100米ドルは日本円でいくら？', tools:['frankfurter'], expectSearch:false },
  { id:'fx_eurjpy_voice', group:'api_voice', text:'50ユーロ、いま何円くらい？', tools:['frankfurter'], expectSearch:false },
  { id:'earthquake_japan', group:'api', text:'日本で直近に発表された地震情報を教えて', anyTools:['jma_earthquake','usgs_earthquake'] },
  { id:'holiday_japan', group:'api', text:'2027年の日本の成人の日はいつ？', tools:['nager_holidays'], expectSearch:false },
  { id:'gdp_japan', group:'api', text:'日本の一人当たりGDPの最新値は？', tools:['world_bank_wdi'], expectSearch:false },
  { id:'gdp_germany', group:'api', text:'ドイツのGDPの最新値を教えて', tools:['world_bank_wdi'], expectSearch:false },
  { id:'crossref_doi', group:'api', text:'DOI 10.1038/s41586-020-2649-2 の論文情報を教えて', tools:['crossref'], expectSearch:false },
  { id:'crossref_title_search', group:'api', text:'NumPyのArray programming with NumPyという論文の書誌情報を調べて', tools:['crossref'] },
  { id:'multi_weather_fx', group:'api_parallel', text:'別府市の今日の天気と、100ドルが何円かをまとめて教えて', tools:['jma_weather','frankfurter'], expectSearch:false },
  { id:'weather_followup', group:'context', text:'明日は？', history:[{role:'user',content:'別府市の今日の天気を教えて'}], tools:['jma_weather'] },
  { id:'voice_fx_loose', group:'voice', text:'ひゃくどるなんえん', anyTools:['frankfurter'] },
  { id:'casual_banana', group:'local', text:'バナナはおやつに入る？', expectSearch:false, allowBase:true },
  { id:'capability', group:'local', text:'検索できるの？', expectSearch:false, allowBase:true },
  { id:'memory', group:'local', text:'さっき何について話してた？', history:[{role:'user',content:'中古パソコンの選び方を相談したい'}], expectSearch:false, allowBase:true },
  { id:'known_pc_spec', group:'web', text:'Panasonic CF-SV8の画面解像度とCPUの公式仕様を確認して', expectSearch:true },
  { id:'shopping_pc_30k', group:'web_shopping', text:'3万円以下の中古ノートPCを動画視聴用に選ぶなら、具体的な機種候補を3つ探して', expectSearch:true, requireSpecificCandidate:true },
  { id:'shopping_pc_battery', group:'web_shopping', text:'中古ノートPCで3万円以下、バッテリー交換しやすく動画視聴向けの具体的な機種を探して', expectSearch:true, requireSpecificCandidate:true },
  { id:'local_usedpc_beppu', group:'web_local', text:'別府市で中古ノートPCを実店舗で買える店を3店探して。現在営業している店だけ', expectSearch:true },
  { id:'smartphone_30k', group:'web_shopping', text:'3万円以下で今買えるAndroidスマホを3機種、OSサポートも確認して選んで', expectSearch:true, requireSpecificCandidate:true },
  { id:'windows_latest', group:'web_current', text:'Windows 11の現在の最新安定版は何？公式情報で確認して', expectSearch:true },
  { id:'current_pm', group:'web_current', text:'現在の日本の内閣総理大臣は誰？就任日も確認して', expectSearch:true },
  { id:'company_ceo', group:'web_current', text:'現在のパナソニック ホールディングスの社長は誰？公式情報で確認して', expectSearch:true },
  { id:'usedgoods_law', group:'web_highstakes', text:'日本で中古PCを買い取って再販売するとき、古物商として本人確認はどんな場合に必要？現行法令で確認して', expectSearch:true },
  { id:'transit_beppu_oita', group:'web_transit', text:'今日このあと別府駅から大分駅へ電車で行くなら、どの路線でだいたい何分？', expectSearch:true },
  { id:'local_clinic', group:'web_local', text:'別府駅の近くで今日診療している内科を3つ探して。営業時間も確認して', expectSearch:true },
  { id:'news_ai', group:'web_news', text:'今日のAI業界の重要ニュースを3件、一次情報か主要報道で確認して', expectSearch:true },
  { id:'comparison_laptops', group:'web_comparison', text:'ThinkPad X1 Carbon Gen 8とLet’s note CF-SV9を中古で買うなら、動画視聴と持ち運び用途でどちらが向く？公式仕様を比較して', expectSearch:true },
  { id:'ambiguous_followup_pc', group:'context', text:'その中で一番軽いのは？', history:[{role:'user',content:'3万円以下の中古ノートPCを3機種探して'}], expectSearch:true },
  { id:'negative_nonsense', group:'robustness', text:'2026年9月10日の別府の天気とX79ASD40 V27 BIOSの公式配布元を一緒に確認して', expectSearch:true },
  { id:'japanese_voice_weather', group:'voice', text:'べっぷし、きょう雨ふる？', anyTools:['jma_weather'] },
];

const badSourcePatterns = [
  /results\.vote\.wa\.gov/i,
  /accounts\.google\.com/i,
  /youtube\.com\/.*(?:login|signin)/i,
  /microsoft\.com\/.*(?:login|signin)/i,
  /gamewith\.jp/i,
];
const giveupRe = /(自分で.*(?:検索|確認)|ご自身で.*(?:検索|確認)|調べられません|検索できません|情報が見つかりませんでしたので.*できません)/i;
const broadCandidateRe = /^(?:レッツノート|Let's note|ThinkPad|Latitude|LIFEBOOK|dynabook|VAIO|MacBook|Surface|Xperia|Pixel|Galaxy|AQUOS)$/i;

function host(url){ try { return new URL(url).hostname.replace(/^www\./,'').toLowerCase(); } catch { return ''; } }
function hasJapanese(s){ return /[ぁ-んァ-ヶ一-龠]/.test(String(s||'')); }

async function callTurn(c){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('smoke timeout')), TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/api/turn`, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({text:c.text, history:c.history || []}), signal:ac.signal,
    });
    const raw = await r.text();
    let d = {}; try { d = JSON.parse(raw); } catch { d = { parseError:true, raw:raw.slice(0,1000) }; }
    return { c, httpStatus:r.status, latencyMs:Date.now()-started, d };
  } catch (e) {
    return { c, httpStatus:0, latencyMs:Date.now()-started, d:{ok:false,error:String(e?.message||e)} };
  } finally { clearTimeout(timer); }
}

function evaluate({c,httpStatus,latencyMs,d}){
  const issues=[];
  const answer=String(d.answer||d.text||'');
  const tools=(d.apiSources||[]).map(x=>x?.tool).filter(Boolean);
  const sources=Array.isArray(d.sources)?d.sources:[];
  const sourceHosts=[...new Set(sources.map(s=>host(s?.url)).filter(Boolean))];
  if(httpStatus!==200) issues.push(`http_${httpStatus}`);
  if(d.ok!==true) issues.push('not_ok');
  if(!answer.trim()) issues.push('empty_answer');
  if(answer && !hasJapanese(answer)) issues.push('answer_not_japanese');
  if(giveupRe.test(answer)) issues.push('giveup_language');
  if(c.expectSearch===true && d.search!==true) issues.push('expected_search_missing');
  if(c.expectSearch===false && d.search===true) issues.push('unnecessary_search');
  for(const t of c.tools||[]) if(!tools.includes(t)) issues.push(`missing_tool:${t}`);
  if(c.anyTools?.length && !c.anyTools.some(t=>tools.includes(t))) issues.push(`missing_any_tool:${c.anyTools.join('|')}`);
  const bad=sources.filter(s=>badSourcePatterns.some(re=>re.test(String(s?.url||'')) || re.test(String(s?.title||''))));
  if(bad.length) issues.push(`bad_source:${bad.map(x=>host(x.url)||x.title).join(',')}`);
  if(d.search===true && sources.length===0) issues.push('search_no_sources');
  if(d.search===true && d.searchUseful===false) issues.push('search_not_useful');
  if(d.search===true && d.searchCoverage?.sufficient===false) issues.push(`coverage_insufficient:${d.searchCoverage?.reason||'unknown'}`);
  if(d.search===true && sourceHosts.length<2 && sources.length>1) issues.push('low_host_diversity');
  const cands=d.searchDiagnostics?.candidateNames || [];
  if(c.requireSpecificCandidate){
    if(!cands.length) issues.push('no_candidate');
    if(cands.length && cands.every(x=>broadCandidateRe.test(String(x).trim()) || !/\d/.test(String(x)))) issues.push(`candidate_too_broad:${cands.join('|')}`);
  }
  if(latencyMs>45000) issues.push('latency_gt_45s');
  else if(latencyMs>25000) issues.push('latency_gt_25s');
  if(tools.includes('crossref') && /被引用数は/.test(answer) && !/Crossref(?:上|で|の)/i.test(answer)) issues.push('crossref_citation_count_wording');
  const probes=d.searchDiagnostics?.probes||[];
  const failures=probes.filter(x=>x?.ok===false);
  const google429=failures.filter(x=>x?.error==='http_429').length;
  if(google429) issues.push(`google_429:${google429}`);
  return {
    id:c.id, group:c.group, text:c.text, pass:issues.length===0, issues,
    latencyMs, httpStatus, route:d.route||'', search:d.search===true,
    apiTools:tools, apiIntents:d.apiIntents||[], answer:answer.slice(0,1200),
    sourceCount:sources.length, sourceHosts, sources:sources.slice(0,8),
    coverage:d.searchCoverage||null, queries:d.queries||[],
    candidateType:d.searchDiagnostics?.candidateType||'', candidateNames:cands,
    probeFailures:failures.length, google429,
    timings:d.timings||{}, apiDiagnostics:d.apiDiagnostics||{}, searchDiagnostics:d.searchDiagnostics||{},
  };
}

async function main(){
  const health = await fetch(`${BASE}/voice-health`).then(r=>r.json()).catch(e=>({ok:false,error:String(e)}));
  const results=[];
  for(let i=0;i<cases.length;i+=CONCURRENCY){
    const batch=cases.slice(i,i+CONCURRENCY);
    const rows=await Promise.all(batch.map(callTurn));
    for(const row of rows){
      const scored=evaluate(row); results.push(scored);
      console.log(`SMOKE ${scored.pass?'PASS':'ISSUE'} ${scored.id} ${scored.latencyMs}ms tools=${scored.apiTools.join(',')||'-'} search=${scored.search} issues=${scored.issues.join(';')||'-'}`);
    }
    await new Promise(r=>setTimeout(r,350));
  }
  const issueCounts={};
  for(const r of results) for(const issue of r.issues){ const k=issue.split(':')[0]; issueCounts[k]=(issueCounts[k]||0)+1; }
  const sortedLatency=[...results].sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,10).map(r=>({id:r.id,latencyMs:r.latencyMs,search:r.search}));
  const report={
    generatedAt:new Date().toISOString(), base:BASE,
    health:{ok:health.ok,voiceRevision:health.voiceRevision,searchRevision:health.searchRevision,apiFirst:health.apiFirst,apiParallel:health.apiParallel,searchDirectorModel:health.searchDirectorModel,weatherDirect:health.weatherDirect,openMeteoExcluded:health.openMeteoExcluded,freeApiRegistry:Object.keys(health.freeApiRegistry||{})},
    summary:{total:results.length,pass:results.filter(x=>x.pass).length,issues:results.filter(x=>!x.pass).length,issueCounts,avgLatencyMs:Math.round(results.reduce((s,x)=>s+x.latencyMs,0)/results.length),sortedLatency},
    results,
  };
  await writeFile('smoke-v45-report.json', JSON.stringify(report,null,2));
  console.log('SMOKE_SUMMARY '+JSON.stringify(report.summary));
  console.log('SMOKE_REPORT smoke-v45-report.json');
}

main().catch(e=>{ console.error(e); process.exitCode=1; });
