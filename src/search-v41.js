import { collectGroundedEvidenceV26 } from './search-v26.js';
import { searchBingRss, dedupeSearchResults } from './search-fallbacks.js';

export const SEARCH_V41_REVISION='evidence-v41-multipass-resilient';
const SMARTPHONE_RE=/(スマホ|スマートフォン|携帯|Android|iPhone|Xperia|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|MOTOROLA)/i;
const SHOPPING_RE=/(中古|新品|買|購入|乗り換え|乗換|機種|候補|価格|値段|予算|円|万円|在庫|販売|安い)/i;
const PRICE_SIGNAL_RE=/(?:\d{1,3}(?:,\d{3})+|\d{3,6})\s*円|\d+(?:\.\d+)?\s*万円/i;
const PHONE_SIGNAL_RE=/(スマホ|スマートフォン|Android|iPhone|Xperia|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|MOTOROLA|DIGNO|Redmi)/i;
const TRUSTED_PHONE_HOST_RE=/(?:^|\.)(?:iosys\.co\.jp|janpara\.co\.jp|geo-online\.co\.jp|sofmap\.com|bookoffonline\.co\.jp)$/i;

function clean(v,max=5000){return String(v||'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function hostOf(url){try{return new URL(String(url||'')).hostname.toLowerCase();}catch{return '';}}
function stripHtml(v){return String(v||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<svg\b[\s\S]*?<\/svg>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();}
function historyText(history){return Array.isArray(history)?history.slice(-10).map(x=>clean(x?.content,900)).filter(Boolean).join(' '):'';}
function budgetToken(text){const v=clean(text,2000);let m=v.match(/([0-9０-９]{1,3})\s*万\s*円?\s*(以下|以内|まで)/);if(m)return `${m[1]}万円${m[2]}`;m=v.match(/([0-9０-９]{4,6})\s*円\s*(以下|以内|まで)/);return m?`${m[1]}円${m[2]}`:'';}
function androidToken(text){const m=clean(text,2000).match(/Android\s*([0-9]{1,2})(?:\s*(?:以降|以上))?/i);return m?`Android ${m[1]}以降`:'';}
function compactCore(text){return clean(text,700).replace(/相談内容[:：]?/g,' ').replace(/検索条件[:：]?/g,' ').replace(/(?:検索して|調べて|確認して|ください|ほしい|お願いします?)[。！？!?]*$/g,' ').replace(/\s+/g,' ').trim().slice(0,180);}
function searchResultRelevant(item,goal){const text=clean(`${item?.title||''} ${item?.excerpt||item?.snippet||''}`,3600);if(!text)return false;if(SMARTPHONE_RE.test(goal)){if(!PHONE_SIGNAL_RE.test(text))return false;if(SHOPPING_RE.test(goal)&&!/(中古|販売|価格|円|在庫|商品|保証|スマホ)/i.test(text))return false;return true;}const terms=[...new Set(compactCore(goal).split(/[\s、。・/]+/).filter(x=>x.length>=2).slice(0,10))];return !terms.length||terms.some(t=>text.toLowerCase().includes(t.toLowerCase()));}
function hasConcreteShoppingEvidence(sources,goal){if(!SHOPPING_RE.test(goal))return (sources||[]).length>=2;const relevant=(sources||[]).filter(x=>searchResultRelevant(x,goal));if(SMARTPHONE_RE.test(goal))return relevant.some(x=>PRICE_SIGNAL_RE.test(clean(`${x?.title||''} ${x?.excerpt||x?.snippet||''}`,4000)))&&relevant.length>=2;return relevant.length>=3;}

export function buildRetryQueries(resolved,history=[],instruction='',pass=1){
  const combined=clean(`${historyText(history)} ${resolved} ${instruction}`,2800), core=compactCore(resolved)||compactCore(instruction), budget=budgetToken(combined), android=androidToken(combined);
  if(SMARTPHONE_RE.test(combined)&&SHOPPING_RE.test(combined)){
    const price=budget||'2万円以下', os=android||'Android';
    const first=[`中古 ${os} スマホ ${price} 価格`,`中古 Xperia Pixel AQUOS Galaxy ${price}`,`site:iosys.co.jp 中古 Android スマホ ${price}`,`site:janpara.co.jp 中古 Android スマホ ${price}`,`site:ec.geo-online.co.jp 中古 スマホ ${price}`];
    const second=[`${price} 中古 スマホ ${os} SIMフリー`,`中古 スマホ ${price} 保証 在庫`,`site:iosys.co.jp/items/smartphone ${price} Android`,`site:ec.geo-online.co.jp/shop/c/c1001 ${price} スマホ`,`site:janpara.co.jp Android 中古 ${price}`];
    return [...new Set((pass<=1?first:second).map(x=>clean(x)))].slice(0,6);
  }
  const suffix=pass<=1?['公式','価格 在庫','販売 公式']:['別の情報源','詳細 公式','比較 価格'];
  return [...new Set([core,...suffix.map(s=>`${core} ${s}`)].map(x=>clean(x)).filter(x=>x.length>=2))].slice(0,5);
}

async function fetchDirect(url,title,needles=[]){
  try{
    const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(5200),headers:{accept:'text/html,application/xhtml+xml','accept-language':'ja-JP,ja;q=0.9','user-agent':'Mozilla/5.0 (compatible; TalkSys/1.0; +https://talksys.syouziroupc.workers.dev)'}});if(!r.ok)return null;const text=stripHtml(await r.text());if(text.length<80)return null;
    let pos=-1;for(const n of needles){const p=text.toLowerCase().indexOf(String(n).toLowerCase());if(p>=0&&(pos<0||p<pos))pos=p;}const start=pos>=0?Math.max(0,pos-500):0;const excerpt=clean(text.slice(start,start+7000),6500);return {title,url:r.url||url,excerpt,snippet:excerpt,engine:'trusted-direct-v41'};
  }catch{return null;}
}
async function trustedPhoneDirect(goal){if(!SMARTPHONE_RE.test(goal)||!SHOPPING_RE.test(goal))return [];const budget=budgetToken(goal)||'2万円以下';const settled=await Promise.allSettled([
  fetchDirect('https://www.iosys.co.jp/items/smartphone','イオシス スマートフォン商品一覧',['20,000円','中古','Android']),
  fetchDirect('https://ec.geo-online.co.jp/shop/c/c1001/','ゲオオンラインストア スマホ・タブレット',['中古','スマホ','円']),
  fetchDirect('https://www.janpara.co.jp/','じゃんぱら 中古スマホ販売',['スマートフォン','中古','Android'])
]);return settled.flatMap(x=>x.status==='fulfilled'&&x.value?[x.value]:[]).filter(x=>searchResultRelevant(x,goal));}
async function searchQueries(queries,goal){const settled=await Promise.allSettled(queries.map(q=>searchBingRss(q,{timeoutMs:6000,limit:10})));return settled.flatMap(x=>x.status==='fulfilled'&&Array.isArray(x.value)?x.value:[]).filter(x=>searchResultRelevant(x,goal));}
function normalizeSources(base,goal){return (Array.isArray(base?.sources)?base.sources:[]).filter(x=>searchResultRelevant(x,goal));}
function evidenceText(sources){return (sources||[]).slice(0,10).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}

export async function collectResilientEvidenceV41(resolved,history=[],instruction='',options={}){
  const goal=clean(`${resolved} ${instruction}`,2200);let base;
  try{base=await collectGroundedEvidenceV26(resolved,history,options);}catch(error){base={resolvedQuestion:resolved,queries:[],sources:[],error:clean(error?.message||error,180)};}
  let sources=normalizeSources(base,goal),queries=[...(Array.isArray(base?.queries)?base.queries:[])],passes=1;
  const direct=await trustedPhoneDirect(goal);sources=dedupeSearchResults([...sources,...direct],12);
  for(let pass=1;pass<=2&&!hasConcreteShoppingEvidence(sources,goal);pass++){
    const qs=buildRetryQueries(resolved,history,instruction,pass);const extra=await searchQueries(qs,goal);queries=[...new Set([...queries,...qs])].slice(0,12);sources=dedupeSearchResults([...sources,...extra],12);passes++;
    options.onProgress?.({phase:'retry_search',revision:SEARCH_V41_REVISION,pass:passes,resolvedQuestion:resolved,queries:qs,evidenceCount:sources.length,message:pass===1?'検索語を短く組み直して再検索':'販売元を変えて追加検索'});
  }
  const useful=sources.length>0;
  return {...base,revision:SEARCH_V41_REVISION,resolvedQuestion:clean(base?.resolvedQuestion||resolved,1000),queries,sources,evidence:evidenceText(sources),searchUseful:useful,searchPasses:passes,concreteShoppingEvidence:hasConcreteShoppingEvidence(sources,goal),trustedDirectEvidence:direct.length};
}

export const __test={budgetToken,androidToken,compactCore,searchResultRelevant,hasConcreteShoppingEvidence,buildRetryQueries,hostOf,stripHtml};
