import workerV35 from './worker-v35.js';
import { TALK_CLIENT_V36 } from './talk-client-v36.js';

const REVISION='talksys-v36-search-voice-barge';
const SEARCH_REQUEST_RE=/(検索して|検索を|調べて|調べよう|ウェブで|Webで|ネットで確認)/i;
const STORE_REQUEST_RE=/(お店|店|店舗|ショップ|販売店|家電量販店|専門店|どこで買|どこにある|近く|周辺|県内|市内)/i;
const PC_RE=/(パソコン|\bPC\b|ＰＣ|Windows|ノート|デスクトップ|Core\s*i[3579]|Ryzen|メモリ|SSD|HDD)/i;
const DOMAIN_SIGNAL_RE=/(駅|パソコン|\bPC\b|ＰＣ|店|店舗|ショップ|都|道|府|県|市|区|町|村|価格|運賃|時刻|天気|ニュース|在庫|住所|電話番号)/i;

function clean(v,max=4000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-14).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1400)})).filter(x=>x.content):[];}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function locationFrom(text){
  const value=clean(text,1200);
  const matches=[...value.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,18}(?:都|道|府|県|市|区|町|村))(?:内)?/g)];
  return clean(matches.at(-1)?.[1]||'',40);
}
function stationPairFrom(text){
  const value=clean(text,900);
  const pair=value.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24}?駅)\s*(?:から|より)\s*([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24}?駅)\s*(?:まで|へ|に)/i);
  return pair?.[1]&&pair?.[2]?[pair[1],pair[2]]:[];
}
function lastUserSubject(history){
  for(const item of [...history].reverse()){
    if(item.role!=='user')continue;
    const value=clean(item.content,700);
    if(!value)continue;
    if(SEARCH_REQUEST_RE.test(value)&&!DOMAIN_SIGNAL_RE.test(value))continue;
    return value;
  }
  return '';
}
function subjectlessSearch(text){
  const value=clean(text,160);
  if(!SEARCH_REQUEST_RE.test(value))return false;
  if(DOMAIN_SIGNAL_RE.test(value))return false;
  const stripped=value.replace(/(?:今から|じゃあ|では|それ|これ|さっきの|今の|君が|あなたが|ちょっと|少し|一回|一度|検索|調べ|ウェブ|Web|ネット|確認|して|しよう|ほしい|欲しい|ください|くれる|くれ|お願い|頼む|んだけど|みて|見て|を|が|は|に|で|から|。|、|！|!|？|\?)/g,'').trim();
  return stripped.length<5;
}
function buildContextualSearch(text,history){
  const current=clean(text,1000);
  const userContext=history.filter(x=>x.role==='user').slice(-8).map(x=>x.content).join(' ');
  const all=clean(`${userContext} ${current}`,2600);

  if(subjectlessSearch(current)){
    const subject=lastUserSubject(history);
    if(subject){
      const [from,to]=stationPairFrom(subject);
      if(from&&to)return {text:`${from}から${to}までの電車の経路 直通 所要時間 運賃 時刻表 最新情報を検索して`,reason:'context-carry-transit-search'};
      return {text:`${subject} 最新の正確な情報を検索して`,reason:'context-carry-search'};
    }
  }

  if(STORE_REQUEST_RE.test(current)&&PC_RE.test(all)){
    const location=locationFrom(current)||locationFrom(all);
    const laptop=/(ノート|ノートパソコン)/i.test(all);
    const cheap=/(安い|格安|低価格|予算を抑|コスパ)/i.test(all);
    const large=/(画面.{0,8}(?:大き|広い)|大画面|15[\.．]?6\s*インチ|16\s*インチ|17\s*インチ)/i.test(all);
    const parts=[location,laptop?'ノートパソコン':'パソコン',large?'大画面':'',cheap?'安い':'',location?'店舗 おすすめ':'購入先 通販 販売店 比較'].filter(Boolean);
    return {text:`${parts.join(' ')} を検索して`,reason:location?'local-store-search':'store-search'};
  }

  return null;
}
function wrapRevision(response){
  const headers=new Headers(response.headers);headers.set('x-talksys-revision',REVISION);headers.set('cache-control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:'@cf/zai-org/glm-5.3-flash',sttModel:'@cf/openai/whisper-large-v3-turbo',ttsModel:'browser/speechSynthesis',ttsLanguage:'ja-JP',ttsVoice:'stable-ja-preferred',serverTtsEnabled:false,searchContextRewrite:true,bargeIn:true,legacyWebSocketVoice:false,durableObjectVoice:false});
    if(request.method==='GET'&&['/talk-v36.js','/talk-v35.js','/talk-v34.js'].includes(url.pathname))return new Response(TALK_CLIENT_V36,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV35.fetch(request,env);const html=(await base.text()).replace('/talk-v35.js','/talk-v36.js');
      return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}
      const history=historyOf(body?.history);const rewrite=buildContextualSearch(body?.text,history);
      if(rewrite){
        const rewritten=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,text:rewrite.text})});
        return wrapRevision(await workerV35.fetch(rewritten,env));
      }
    }
    return wrapRevision(await workerV35.fetch(request,env));
  }
};

export const __test={locationFrom,stationPairFrom,lastUserSubject,subjectlessSearch,buildContextualSearch};
