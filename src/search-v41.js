import { collectGroundedEvidenceV26 } from './search-v26.js';
import { searchBingRss, dedupeSearchResults } from './search-fallbacks.js';

export const SEARCH_V41_REVISION='evidence-v41-multipass-resilient';
const SMARTPHONE_RE=/(スマホ|スマートフォン|携帯|Android|iPhone|Xperia|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|MOTOROLA)/i;
const SHOPPING_RE=/(中古|新品|買|購入|乗り換え|乗換|機種|候補|価格|値段|予算|円|万円|在庫|販売|安い)/i;
const PRICE_SIGNAL_RE=/(?:\d{1,3}(?:,\d{3})+|\d{3,6})\s*円|\d+(?:\.\d+)?\s*万円/i;
const PHONE_SIGNAL_RE=/(スマホ|スマートフォン|Android|iPhone|Xperia|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|MOTOROLA|DIGNO|Redmi)/i;
const OS_SIGNAL_RE=/Android\s*(?:1[0-9]|[2-9][0-9])|OS\s*(?:アップデート|更新|サポート)|セキュリティ(?:更新|アップデート|サポート)/i;
const OS_FRESHNESS_RE=/(?:Android|アンドロイド).{0,28}(?:古い|古く|新しい|新しめ|最新|バージョン|アップデート|更新|サポート)|(?:OS|基本ソフト).{0,28}(?:古い|古く|新しい|新しめ|最新|バージョン|アップデート|更新|サポート)|セキュリティ.{0,18}(?:更新|アップデート|サポート)/i;

function clean(v,max=5000){return String(v||'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function hostOf(url){try{return new URL(String(url||'')).hostname.toLowerCase();}catch{return '';}}
function stripHtml(v){return String(v||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<svg\b[\s\S]*?<\/svg>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();}
function historyText(history){return Array.isArray(history)?history.slice(-10).map(x=>clean(x?.content,900)).filter(Boolean).join(' '):'';}
function budgetToken(text){const v=clean(text,2000);let m=v.match(/([0-9０-９]{1,3})\s*万\s*円?\s*(以下|以内|まで)/);if(m)return `${m[1]}万円${m[2]}`;m=v.match(/([0-9０-９]{4,6})\s*円\s*(以下|以内|まで)/);return m?`${m[1]}円${m[2]}`:'';}
function androidToken(text){const m=clean(text,2600).match(/Android\s*([0-9]{1,2})(?:\s*(?:以降|以上|またはそれ以降))?/i);return m?`Android ${m[1]}以降`:'';}
function requiredAndroidVersion(text){const token=androidToken(text),m=token.match(/(\d+)/);return m?Number(m[1]):0;}
function needsAndroidFreshness(text){const v=clean(text,5000);return requiredAndroidVersion(v)>0||OS_FRESHNESS_RE.test(v);}
function compactCore(text){return clean(text,700).replace(/相談内容[:：]?/g,' ').replace(/検索条件[:：]?/g,' ').replace(/(?:検索して|調べて|確認して|ください|ほしい|お願いします?)[。！？!?]*$/g,' ').replace(/\s+/g,' ').trim().slice(0,180);}
function isPhoneShopping(goal){return SMARTPHONE_RE.test(goal)&&SHOPPING_RE.test(goal);}
function sourceText(item,max=5000){return clean(`${item?.title||''} ${item?.excerpt||item?.snippet||''}`,max);}
function normalizeModel(v){return clean(v,100).toLowerCase().replace(/[\s　\-_.]+/g,'');}

function searchResultRelevant(item,goal){
  const text=sourceText(item,4200);if(!text)return false;
  if(SMARTPHONE_RE.test(goal)){
    if(!PHONE_SIGNAL_RE.test(text))return false;
    if(SHOPPING_RE.test(goal)){
      const commerce=/(中古|販売|価格|円|在庫|商品|保証|スマホ)/i.test(text);
      const osEvidence=needsAndroidFreshness(goal)&&OS_SIGNAL_RE.test(text);
      if(!commerce&&!osEvidence)return false;
    }
    return true;
  }
  const terms=[...new Set(compactCore(goal).split(/[\s、。・/]+/).filter(x=>x.length>=2).slice(0,10))];return !terms.length||terms.some(t=>text.toLowerCase().includes(t.toLowerCase()));
}

function extractPhoneModels(sources){
  const all=(sources||[]).map(x=>sourceText(x,9000)).join(' '),out=[];
  const patterns=[/AQUOS\s+sense\s*\d+(?:\s*(?:plus|lite|basic|G))?/gi,/Pixel\s+\d+[a-z]?/gi,/Xperia\s+(?:1|5|10|Ace)\s*(?:II|III|IV|V|VI|VII|[234])?/gi,/Galaxy\s+(?:S|A|M|Z|Note)\s*\d+[A-Za-z0-9+\-]*/gi,/OPPO\s+Reno\s*\d+\s*A?/gi,/Redmi\s+(?:Note\s+)?\d+[A-Za-z0-9+\-]*/gi,/arrows\s+[A-Za-z0-9+\-]+/gi];
  for(const re of patterns)for(const m of all.matchAll(re)){const v=clean(m[0],80);if(v&&!out.some(x=>normalizeModel(x)===normalizeModel(v)))out.push(v);if(out.length>=8)return out;}
  return out;
}
function modelMentioned(text,model){const normalized=normalizeModel(text);return normalized.includes(normalizeModel(model));}
function sourceHasAndroidEvidenceForModel(item,model,min=0){
  const text=sourceText(item,7500);if(!modelMentioned(text,model))return false;
  const versions=[...text.matchAll(/Android\s*([0-9]{1,2})/gi)].map(m=>Number(m[1])).filter(Number.isFinite);
  if(min>0&&versions.some(v=>v>=min))return true;
  if(min===0&&versions.length)return true;
  return /OS\s*(?:アップデート|更新|サポート)|セキュリティ(?:更新|アップデート|サポート)/i.test(text);
}
function hasAndroidRequirementEvidence(sources,goal){
  if(!needsAndroidFreshness(goal))return true;
  const min=requiredAndroidVersion(goal),models=extractPhoneModels(sources);
  if(!models.length)return false;
  return models.some(model=>(sources||[]).some(item=>sourceHasAndroidEvidenceForModel(item,model,min)));
}
function hasConcreteShoppingEvidence(sources,goal){
  if(!SHOPPING_RE.test(goal))return (sources||[]).length>=2;
  const relevant=(sources||[]).filter(x=>searchResultRelevant(x,goal));
  if(SMARTPHONE_RE.test(goal)){
    const priceOk=relevant.some(x=>PRICE_SIGNAL_RE.test(sourceText(x,5000)));
    return priceOk&&relevant.length>=2&&hasAndroidRequirementEvidence(relevant,goal);
  }
  return relevant.length>=3;
}
function modelVerificationQueries(sources,goal){
  if(!needsAndroidFreshness(goal))return [];
  const min=requiredAndroidVersion(goal),models=extractPhoneModels(sources).slice(0,5);
  return models.flatMap(model=>min>0
    ?[`${model} Android ${min} アップデート 公式`,`${model} Android バージョン サポート 公式`]
    :[`${model} Android 最新 バージョン 公式`,`${model} OS アップデート サポート 公式`]
  ).slice(0,10);
}

export function buildRetryQueries(resolved,history=[],instruction='',pass=1){
  const combined=clean(`${historyText(history)} ${resolved} ${instruction}`,2800),core=compactCore(resolved)||compactCore(instruction),budget=budgetToken(combined),android=androidToken(combined);
  if(isPhoneShopping(combined)){
    const price=budget||'2万円以下',os=android||(needsAndroidFreshness(combined)?'Android 新しめ':'Android');
    const first=[`中古 ${os} スマホ ${price} 価格`,`中古 Xperia Pixel AQUOS Galaxy ${price}`,`site:iosys.co.jp 中古 Android スマホ ${price}`,`site:janpara.co.jp 中古 Android スマホ ${price}`,`site:ec.geo-online.co.jp 中古 スマホ ${price}`];
    const second=[`${price} 中古 スマホ ${os} SIMフリー`,`中古 スマホ ${price} 保証 在庫`,`site:iosys.co.jp/items/smartphone ${price} Android`,`site:ec.geo-online.co.jp/shop/c/c1001 ${price} スマホ`,`site:janpara.co.jp Android 中古 ${price}`];
    const third=[`中古 Android スマホ 10000円 20000円 価格`,`中古 SIMフリー スマホ ${price} 商品 価格`,`中古 Xperia Pixel AQUOS Galaxy ${os} 価格`,`site:sofmap.com 中古 Android スマホ ${price}`,`site:bookoffonline.co.jp 中古 スマホ Android ${price}`];
    const selected=pass<=1?first:pass===2?second:third;return [...new Set(selected.map(x=>clean(x)))].slice(0,6);
  }
  const suffix=pass<=1?['公式','価格 在庫','販売 公式']:pass===2?['別の情報源','詳細 公式','比較 価格']:['一次情報','別サイト','具体例 価格'];return [...new Set([core,...suffix.map(s=>`${core} ${s}`)].map(x=>clean(x)).filter(x=>x.length>=2))].slice(0,5);
}

async function fetchDirect(url,title,needles=[]){
  try{const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(5200),headers:{accept:'text/html,application/xhtml+xml','accept-language':'ja-JP,ja;q=0.9','user-agent':'Mozilla/5.0 (compatible; TalkSys/1.0; +https://talksys.syouziroupc.workers.dev)'}});if(!r.ok)return null;const text=stripHtml(await r.text());if(text.length<80)return null;let pos=-1;for(const n of needles){const p=text.toLowerCase().indexOf(String(n).toLowerCase());if(p>=0&&(pos<0||p<pos))pos=p;}const start=pos>=0?Math.max(0,pos-500):0;const excerpt=clean(text.slice(start,start+7000),6500);return {title,url:r.url||url,excerpt,snippet:excerpt,engine:'trusted-direct-v41'};}catch{return null;}
}
async function trustedPhoneDirect(goal){if(!isPhoneShopping(goal))return [];const settled=await Promise.allSettled([
  fetchDirect('https://www.iosys.co.jp/items/smartphone','イオシス スマートフォン商品一覧',['20,000円','中古','Android']),
  fetchDirect('https://ec.geo-online.co.jp/shop/c/c1001/','ゲオオンラインストア スマホ・タブレット',['中古','スマホ','円']),
  fetchDirect('https://www.janpara.co.jp/','じゃんぱら 中古スマホ販売',['スマートフォン','中古','Android'])
]);return settled.flatMap(x=>x.status==='fulfilled'&&x.value?[x.value]:[]).filter(x=>searchResultRelevant(x,goal));}
async function searchQueries(queries,goal){if(!queries.length)return [];const settled=await Promise.allSettled(queries.map(q=>searchBingRss(q,{timeoutMs:6000,limit:10})));return settled.flatMap(x=>x.status==='fulfilled'&&Array.isArray(x.value)?x.value:[]).filter(x=>searchResultRelevant(x,goal));}
function normalizeSources(base,goal){return (Array.isArray(base?.sources)?base.sources:[]).filter(x=>searchResultRelevant(x,goal));}
function evidenceText(sources){return (sources||[]).slice(0,12).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}

async function verifyCandidateOs(sources,queries,goal){
  if(!needsAndroidFreshness(goal)||hasAndroidRequirementEvidence(sources,goal))return {sources,queries};
  const verifyQs=modelVerificationQueries(sources,goal);if(!verifyQs.length)return {sources,queries};
  const verified=await searchQueries(verifyQs,goal);
  return {sources:dedupeSearchResults([...sources,...verified],14),queries:[...new Set([...queries,...verifyQs])].slice(0,24)};
}

export async function collectResilientEvidenceV41(resolved,history=[],instruction='',options={}){
  const combined=clean(`${historyText(history)} ${resolved} ${instruction}`,5000),goal=clean(`${resolved} ${instruction}`,2600),phoneShopping=isPhoneShopping(combined);let base;
  if(phoneShopping)base={resolvedQuestion:resolved,queries:[],sources:[]};
  else{try{base=await collectGroundedEvidenceV26(resolved,history,options);}catch(error){base={resolvedQuestion:resolved,queries:[],sources:[],error:clean(error?.message||error,180)};}}
  let sources=normalizeSources(base,combined),queries=[...(Array.isArray(base?.queries)?base.queries:[])],passes=0;
  const direct=await trustedPhoneDirect(combined);sources=dedupeSearchResults([...sources,...direct],14);

  if(phoneShopping&&needsAndroidFreshness(combined)&&!hasAndroidRequirementEvidence(sources,combined)){
    const verified=await verifyCandidateOs(sources,queries,combined);sources=verified.sources;queries=verified.queries;passes=1;
    options.onProgress?.({phase:'requirement_verification',revision:SEARCH_V41_REVISION,pass:1,resolvedQuestion:resolved,queries:modelVerificationQueries(sources,combined),evidenceCount:sources.length,message:'候補機種のAndroid対応状況を追加確認'});
  }

  for(let pass=Math.max(1,passes+1);pass<=3&&!hasConcreteShoppingEvidence(sources,combined);pass++){
    const qs=buildRetryQueries(resolved,history,instruction,pass),extra=await searchQueries(qs,combined);queries=[...new Set([...queries,...qs])].slice(0,24);sources=dedupeSearchResults([...sources,...extra],14);passes=pass;
    options.onProgress?.({phase:phoneShopping?(pass===1?'targeted_search':'retry_search'):'retry_search',revision:SEARCH_V41_REVISION,pass,resolvedQuestion:resolved,queries:qs,evidenceCount:sources.length,message:pass===1?'検索条件を組み直して追加検索':pass===2?'別の販売元と条件で追加検索':'条件を広げて三巡目の検索'});
    if(phoneShopping&&needsAndroidFreshness(combined)&&!hasAndroidRequirementEvidence(sources,combined)){
      const verified=await verifyCandidateOs(sources,queries,combined);sources=verified.sources;queries=verified.queries;
    }
  }
  const useful=sources.length>0;
  return {...base,revision:SEARCH_V41_REVISION,resolvedQuestion:clean(base?.resolvedQuestion||resolved,1000),queries,sources,evidence:evidenceText(sources),searchUseful:useful,searchPasses:passes||1,concreteShoppingEvidence:hasConcreteShoppingEvidence(sources,combined),androidRequirement:requiredAndroidVersion(combined)||null,androidFreshnessRequired:needsAndroidFreshness(combined),androidRequirementEvidence:hasAndroidRequirementEvidence(sources,combined),trustedDirectEvidence:direct.length};
}

export const __test={budgetToken,androidToken,requiredAndroidVersion,needsAndroidFreshness,compactCore,isPhoneShopping,searchResultRelevant,hasAndroidRequirementEvidence,hasConcreteShoppingEvidence,extractPhoneModels,sourceHasAndroidEvidenceForModel,modelVerificationQueries,buildRetryQueries,hostOf,stripHtml};
