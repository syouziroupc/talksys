import { collectResilientEvidenceV41, __test as v41 } from './search-v41.js';
import { searchBingRss, dedupeSearchResults } from './search-fallbacks.js';

export const SEARCH_V42_REVISION='evidence-v42-escalating-quality-user-only';
const PHONE_RE=/(スマホ|スマートフォン|携帯|Android|アンドロイド|iPhone|Xperia|エクスペリア|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|Redmi|motorola)/i;
const PRICE_RE=/(?:\d{1,3}(?:,\d{3})+|\d{3,6})\s*円|\d+(?:\.\d+)?\s*万円/i;
const OS_RE=/Android\s*\d{1,2}|OS\s*(?:アップデート|更新|バージョンアップ)|ソフトウェア\s*(?:アップデート|更新)|セキュリティ\s*(?:アップデート|更新)|バージョンアップ/i;
const SELLER_HOST_RE=/(?:^|\.)(?:iosys\.co\.jp|janpara\.co\.jp|geo-online\.co\.jp|sofmap\.com|bookoffonline\.co\.jp)$/i;
const OFFICIAL_HOST_RE=/(?:^|\.)(?:k-tai\.sharp\.co\.jp|sharp\.co\.jp|sony\.jp|support\.google\.com|store\.google\.com|samsung\.com|au\.com|docomo\.ne\.jp|softbank\.jp|motorola\.co\.jp|oppo\.com|mi\.com)$/i;
const JUNK_RE=/(ローマ数字|ランキング\d*選|おすすめランキング|まとめ\d*選|人気機種ランキング|アプリの鎖|知恵袋|reddit|youtube|tiktok)/i;
const ALT_MODELS=['Pixel 6a','AQUOS sense6','Xperia 10 IV','Galaxy A53 5G','Redmi Note 11 Pro 5G'];

function clean(v,max=7000){return String(v||'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function hostOf(url){try{return new URL(String(url||'')).hostname.toLowerCase();}catch{return '';}}
function textOf(item,max=7000){return clean(`${item?.title||''} ${item?.excerpt||item?.snippet||''}`,max);}
function normalizeModel(v){return clean(v,100).toLowerCase().replace(/[\s　_-]+/g,'');}
function containsModel(text,model){return normalizeModel(text).includes(normalizeModel(model));}
function phoneContext(text){return PHONE_RE.test(clean(text,5000));}
function userOnlyHistory(history){return Array.isArray(history)?history.filter(x=>x?.role==='user').slice(-12):[];}
function userConstraintText(history,resolved=''){return clean(`${userOnlyHistory(history).map(x=>x?.content||'').join(' ')} ${resolved}`,6500);}
function explicitConstraintFlags(text){return {numericAndroid:/Android\s*\d{1,2}/i.test(text),simFree:/(SIM\s*フリー|シムフリー)/i.test(text),warranty:/(保証|返品|交換)/i.test(text)};}
function sanitizeQuery(query,constraints){
  let q=clean(query,900);
  if(!constraints.numericAndroid)q=q.replace(/Android\s*\d{1,2}(?:\s*(?:以降|以上|以下|まで))?/gi,'Android アップデート');
  if(!constraints.simFree)q=q.replace(/SIM\s*フリー|シムフリー/gi,'');
  if(!constraints.warranty)q=q.replace(/保証(?:付き)?|返品|交換/gi,'');
  return clean(q,900);
}
function sanitizeQueries(queries,userText){
  const flags=explicitConstraintFlags(userText),out=[];
  for(const raw of queries||[]){const q=sanitizeQuery(raw,flags);if(q&&!out.some(x=>x.toLowerCase()===q.toLowerCase()))out.push(q);}
  return out;
}
function isTrustedPhoneSource(item){
  const host=hostOf(item?.url), text=textOf(item,6000);
  if(!text||JUNK_RE.test(`${item?.title||''} ${host}`))return false;
  if(SELLER_HOST_RE.test(host))return PHONE_RE.test(text)||PRICE_RE.test(text);
  if(OFFICIAL_HOST_RE.test(host))return PHONE_RE.test(text)&&OS_RE.test(text);
  return false;
}
function extractPricedModels(sources){
  const out=[];
  for(const source of sources||[]){
    if(!SELLER_HOST_RE.test(hostOf(source?.url))||!PRICE_RE.test(textOf(source,9000)))continue;
    const models=v41.extractPhoneModels([source]);
    for(const model of models){if(!out.some(x=>normalizeModel(x)===normalizeModel(model)))out.push(model);if(out.length>=8)return out;}
  }
  return out;
}
function osEvidenceForModel(sources,model){return (sources||[]).find(x=>isTrustedPhoneSource(x)&&OFFICIAL_HOST_RE.test(hostOf(x?.url))&&containsModel(textOf(x,9000),model)&&OS_RE.test(textOf(x,9000)))||null;}
function priceEvidenceForModel(sources,model){return (sources||[]).find(x=>SELLER_HOST_RE.test(hostOf(x?.url))&&containsModel(textOf(x,9000),model)&&PRICE_RE.test(textOf(x,9000)))||null;}
function pricedCandidates(sources){
  return extractPricedModels(sources).flatMap(model=>{const price=priceEvidenceForModel(sources,model);return price?[{model,priceSource:{title:clean(price.title,220),url:clean(price.url,700),text:textOf(price,1800)}}]:[];}).slice(0,8);
}
function verifiedCandidates(sources){
  return extractPricedModels(sources).flatMap(model=>{
    const price=priceEvidenceForModel(sources,model),os=osEvidenceForModel(sources,model);
    return price&&os?[{model,priceSource:{title:clean(price.title,220),url:clean(price.url,700),text:textOf(price,1800)},osSource:{title:clean(os.title,220),url:clean(os.url,700),text:textOf(os,1800)}}]:[];
  }).slice(0,5);
}
function officialQueries(model){
  if(/^AQUOS/i.test(model))return [`site:k-tai.sharp.co.jp/support "${model}" アップデート`,`site:k-tai.sharp.co.jp "${model}" Android`,`site:au.com "${model}" Android バージョンアップ`,`site:docomo.ne.jp "${model}" Android`];
  if(/^Xperia/i.test(model))return [`site:sony.jp "${model}" Android アップデート`,`site:au.com "${model}" OS アップデート`,`site:docomo.ne.jp "${model}" Android`];
  if(/^Pixel/i.test(model))return [`site:support.google.com/pixelphone "${model}" Android`,`site:store.google.com "${model}" アップデート`];
  if(/^Galaxy/i.test(model))return [`site:samsung.com/jp "${model}" Android アップデート`,`site:au.com "${model}" OS アップデート`,`site:docomo.ne.jp "${model}" Android`];
  if(/^Redmi|^Xiaomi/i.test(model))return [`site:mi.com/jp "${model}" Android アップデート`,`"${model}" Android バージョン`];
  if(/^OPPO/i.test(model))return [`site:oppo.com/jp "${model}" Android アップデート`,`"${model}" Android バージョン`];
  if(/^motorola/i.test(model))return [`site:motorola.co.jp "${model}" Android アップデート`,`"${model}" Android バージョン`];
  return [`"${model}" Android OS アップデート 公式`,`"${model}" Android バージョン`];
}
async function runQueries(queries){
  const settled=await Promise.allSettled(queries.slice(0,14).map(q=>searchBingRss(q,{timeoutMs:6200,limit:10})));
  return settled.flatMap(x=>x.status==='fulfilled'&&Array.isArray(x.value)?x.value:[]);
}
function filterTargeted(results,models){
  return (results||[]).filter(item=>{
    if(!isTrustedPhoneSource(item))return false;
    const text=textOf(item,8000);return models.some(model=>containsModel(text,model));
  });
}
async function targetedVerification(sources,models){
  const queries=[...new Set(models.flatMap(officialQueries))].slice(0,14);if(!queries.length)return {queries:[],sources:[]};
  const results=filterTargeted(await runQueries(queries),models);return {queries,sources:results};
}
async function alternateDiscovery(){
  const priceQueries=ALT_MODELS.flatMap(model=>[`site:iosys.co.jp "${model}" 中古 円`,`site:janpara.co.jp "${model}" 中古 円`]).slice(0,10);
  const priceResults=(await runQueries(priceQueries)).filter(item=>SELLER_HOST_RE.test(hostOf(item?.url))&&PRICE_RE.test(textOf(item,6000))&&ALT_MODELS.some(m=>containsModel(textOf(item,6000),m)));
  const priced=ALT_MODELS.filter(model=>priceResults.some(x=>containsModel(textOf(x,6000),model)));
  const verify=await targetedVerification(priceResults,priced);
  return {queries:[...priceQueries,...verify.queries],sources:[...priceResults,...verify.sources]};
}
function compactEvidence(sources){return (sources||[]).slice(0,14).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}

export async function collectResilientEvidenceV42(resolved,history=[],instruction='',options={}){
  const uHistory=userOnlyHistory(history),uText=userConstraintText(history,resolved),combined=clean(`${uText} ${instruction}`,6000);
  const base=await collectResilientEvidenceV41(resolved,uHistory,instruction,options);
  if(!phoneContext(combined))return {...base,revision:SEARCH_V42_REVISION,maxSearchPasses:3};

  let sources=dedupeSearchResults((base.sources||[]).filter(isTrustedPhoneSource),20),queries=sanitizeQueries(base.queries||[],uText),pass=Number(base.searchPasses)||1;
  let models=extractPricedModels(sources).slice(0,5),verified=verifiedCandidates(sources);

  if(!verified.length&&models.length){
    const extra=await targetedVerification(sources,models);queries=[...new Set([...queries,...extra.queries])];sources=dedupeSearchResults([...sources,...extra.sources],22);pass=Math.max(pass,4);verified=verifiedCandidates(sources);
    options.onProgress?.({phase:'model_os_verification',revision:SEARCH_V42_REVISION,pass:4,evidenceCount:sources.length,message:'候補機種ごとのOS情報を公式情報で追加確認'});
  }
  if(!verified.length){
    const alt=await alternateDiscovery();queries=[...new Set([...queries,...alt.queries])];sources=dedupeSearchResults([...sources,...alt.sources],24);pass=Math.max(pass,5);models=extractPricedModels(sources).slice(0,8);verified=verifiedCandidates(sources);
    options.onProgress?.({phase:'alternate_candidate_search',revision:SEARCH_V42_REVISION,pass:5,evidenceCount:sources.length,message:'別候補へ広げて価格とOS情報を再確認'});
  }

  queries=sanitizeQueries(queries,uText);
  const priced=pricedCandidates(sources),hasPrice=priced.length>0;
  return {...base,revision:SEARCH_V42_REVISION,queries:queries.slice(0,30),sources,evidence:compactEvidence(sources),searchPasses:pass,maxSearchPasses:5,searchUseful:sources.length>0,concreteShoppingEvidence:verified.length>0,androidRequirementEvidence:verified.length>0,verifiedCandidates:verified,pricedCandidates:priced,priceEvidenceAvailable:hasPrice,sourceQuality:'trusted-phone-seller-or-official-v42',historyPolicy:'user-only'};
}

export const __test={hostOf,isTrustedPhoneSource,extractPricedModels,osEvidenceForModel,priceEvidenceForModel,pricedCandidates,verifiedCandidates,officialQueries,filterTargeted,normalizeModel,containsModel,userOnlyHistory,userConstraintText,explicitConstraintFlags,sanitizeQuery,sanitizeQueries};
