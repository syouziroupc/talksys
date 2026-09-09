import workerV34 from './worker-v34.js';
import { TALK_CLIENT_V35 } from './talk-client-v35.js';

const REVISION='talksys-v35-system-ja-quality';
const GLM_MODEL='@cf/zai-org/glm-5.3-flash';
const PC_TOPIC_RE=/(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|メモリ|RAM|SSD|HDD|USB|Wi-?Fi)/i;
const HARD_SEARCH_RE=/(検索して|調べて|ウェブで|Webで|ネットで確認|最新|現在|今日|ニュース|価格|値段|相場|在庫|営業時間|販売中|現行|発売|予定|日程|電話番号|連絡先|住所|所在地|公式サイト|URL|ランキング|順位|どこで買|近くの|店舗|販売店|家電量販店|経路|行き方|所要時間|運賃)/i;
const SPECIFIC_LOOKUP_RE=/(具体的に.*(?:機種|モデル|製品)|おすすめ.*(?:機種|モデル|製品)|どの(?:機種|モデル|製品)|どれを買|候補を(?:出|挙)|商品名)/i;
const ADVICE_RE=/(相談|どう思う|どう考える|どう選|選び方|した方がいい|すべき|向いている|必要かな|がいい|が欲しい|ほしい|買い替え|使いたい|安い|簡単な|用途)/i;

function clean(v,max=4000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-12).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1200)})).filter(x=>x.content):[];}
function extract(result){
  if(typeof result==='string')return clean(result);
  for(const v of [result?.response,result?.result,result?.text,result?.output_text,result?.choices?.[0]?.message?.content,result?.choices?.[0]?.text])if(typeof v==='string'&&v.trim())return clean(v);
  return '';
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function quick(text){
  const v=clean(text,80).replace(/[！!。．.]+$/u,'');
  if(/^(こんにちは|こんにちわ|やあ|どうも|もしもし)$/u.test(v))return 'こんにちは。どうしました？';
  if(/^(おはよう|おはようございます)$/u.test(v))return 'おはようございます。どうしました？';
  if(/^こんばんは$/u.test(v))return 'こんばんは。どうしました？';
  if(/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(v))return 'どういたしまして。';
  return '';
}
function useDirectAdvice(text,history){
  if(HARD_SEARCH_RE.test(text)||SPECIFIC_LOOKUP_RE.test(text))return false;
  const context=`${history.slice(-6).map(x=>x.content).join(' ')} ${text}`;
  return PC_TOPIC_RE.test(context)||ADVICE_RE.test(text);
}
function compact(text){
  const normalized=clean(text,1200).replace(/\s*([。！？?])\s*/g,'$1');
  const parts=normalized.match(/[^。！？?]+[。！？?]?/g)||[];
  return (parts.length>3?parts.slice(0,3).join(''):normalized).slice(0,360).trim();
}

const GENERAL=`あなたはTalkSysという日本語の電話相談AIです。
同じ通話の履歴を使い、分かっている条件を聞き直さないでください。
返答は電話で聞きやすい自然な日本語で1〜3文。最初の一文で役立つ結論を言ってください。前置き、過剰な相槌、同じ内容の言い換えは禁止です。
「具体的な内容を教えてください」「ご相談をお聞かせください」のような丸投げ回答は禁止です。情報不足でも分かる範囲の方向性を先に示し、必要なら最後に質問を1つだけしてください。
この経路ではWeb検索していません。価格・相場・在庫・ランキング・現行商品の販売状況など変化する事実は述べないでください。特に円・万円など具体的な価格額を出してはいけません。
URL、Markdown、内部処理、モデル名は出さないでください。`;
const PC=`${GENERAL}
パソコン相談では販売・修理の実務者として、用途から必要十分な性能クラスを判断してください。過剰性能を勧めず、仕様一覧を読み上げないでください。
買い替えで用途がまだ不明なら、買い替え方針を一言示してから主用途を1つだけ聞いてください。
ネット閲覧など軽い用途と「安い」という希望が分かっているなら、それだけで必要十分なクラスを明言してください。予算額を聞き直す前に、メモリやSSDなど最低限見るべき点を短く示してください。`;

async function directTurn(body,env){
  const started=Date.now(),text=clean(body?.text,1800),history=historyOf(body?.history);
  if(!text)return json({ok:false,error:'text required'},400);
  const q=quick(text);if(q)return json({ok:true,answer:q,search:false,route:'instant-casual-v35',timings:{totalMs:Date.now()-started,searchMs:0,glmMs:0},model:'local'});
  const pc=PC_TOPIC_RE.test(`${history.map(x=>x.content).join(' ')} ${text}`);
  const messages=[{role:'system',content:pc?PC:GENERAL},...history,{role:'user',content:text}];
  let last='';
  for(let attempt=0;attempt<2;attempt++){
    try{
      const t=Date.now();
      const result=await env.AI.run(GLM_MODEL,{messages,stream:false,modalities:['text'],max_completion_tokens:140,temperature:0.1,reasoning_effort:'low'});
      const answer=compact(extract(result));
      if(answer)return json({ok:true,answer,search:false,route:pc?'pc-contextual-v35':'contextual-v35',searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:Date.now()-started,searchMs:0,glmMs:Date.now()-t},model:GLM_MODEL});
      last='empty response';
    }catch(e){last=String(e?.message||e);}
  }
  return json({ok:false,error:last||'answer generation failed'},502);
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:GLM_MODEL,sttModel:'@cf/openai/whisper-large-v3-turbo',ttsModel:'browser/speechSynthesis',ttsLanguage:'ja-JP',ttsVoice:'strict-ja-auto',serverTtsEnabled:false,legacyWebSocketVoice:false,durableObjectVoice:false});
    if(request.method==='GET'&&(url.pathname==='/talk-v35.js'||url.pathname==='/talk-v34.js'))return new Response(TALK_CLIENT_V35,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV34.fetch(request,env);const html=(await base.text()).replace('/talk-v34.js','/talk-v35.js');
      return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/tts')return json({ok:false,error:'Server TTS is disabled. TalkSys uses a strict ja-JP system voice in the browser.'},410);
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}
      const text=clean(body?.text,1800),history=historyOf(body?.history);
      if(useDirectAdvice(text,history))return directTurn(body,env);
    }
    const response=await workerV34.fetch(request,env);
    const headers=new Headers(response.headers);headers.set('x-talksys-revision',REVISION);headers.set('cache-control','no-store');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};
