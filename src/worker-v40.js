import workerV38 from './worker-v38.js';
import { TALK_CLIENT_V40 } from './talk-client-v40.js';

const REVISION='talksys-v40-japanese-native-fallback';
const PLAN_MODEL='@cf/zai-org/glm-5.3-flash';

function clean(v,max=5000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function wrap(response){const h=new Headers(response.headers);h.set('x-talksys-revision',REVISION);h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function isEnglishSentence(text){
  const v=clean(text,1400);if(!v||/[ぁ-んァ-ヶ一-龠々]/u.test(v))return false;
  if(/^(?:windows(?:\s*\d+)?|wi[- ]?fi|pc|ssd|hdd|cpu|gpu|ram|usb|hdmi|core\s*i\d|ryzen(?:\s*\d+)?|cf[-a-z0-9]+|\d+\s*(?:gb|tb|mb|mhz|ghz))(?:[\s\d./+_-]+(?:windows|wi[- ]?fi|pc|ssd|hdd|cpu|gpu|ram|usb|hdmi|gb|tb|mb|mhz|ghz|\d+))*$/i.test(v))return false;
  if(/^(?:hello|hi|hey|thanks|thank you|good morning|good evening)[.!?\s]*$/i.test(v))return true;
  if(/\b(?:i|you|we|they|he|she|it|what|where|when|why|how|is|are|am|do|does|did|can|could|would|should|want|need|ask|tell|please|the|a|an|in|on|at|to|from|for|with)\b/i.test(v))return true;
  return (v.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)||[]).length>=4;
}
function needsJapaneseRepair(text){const v=clean(text,5000);if(!v)return false;const ja=(v.match(/[ぁ-んァ-ヶ一-龠々]/gu)||[]).length;const latin=(v.match(/[A-Za-z]/g)||[]).length;return latin>=20&&ja<Math.max(8,Math.floor(latin*0.25));}
function extractText(result){
  if(typeof result==='string')return clean(result,5000);if(!result)return '';
  for(const value of [result.response,result.result,result.text,result.output_text])if(typeof value==='string'&&value.trim())return clean(value,5000);
  const content=result.choices?.[0]?.message?.content;if(typeof content==='string')return clean(content,5000);
  if(Array.isArray(content))return clean(content.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''),5000);
  return clean(result.choices?.[0]?.text||'',5000);
}
async function repairJapanese(answer,env){
  if(!needsJapaneseRepair(answer))return answer;
  try{
    const result=await env.AI.run(PLAN_MODEL,{messages:[
      {role:'system',content:'あなたはTalkSysの日本語出力補正器です。入力回答の意味、事実、固有名詞、数値を変えず、自然な日本語だけに直してください。新しい事実を足さず、英語の文を残さず、URLやMarkdownを追加しないでください。出力は補正後の本文だけです。'},
      {role:'user',content:clean(answer,4500)}
    ],stream:false,modalities:['text'],max_completion_tokens:260,temperature:0.05,reasoning_effort:'low'});
    return extractText(result)||answer;
  }catch{return answer;}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({
      ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:'@cf/zai-org/glm-5.3-flash',languageMode:'ja-only',englishConversationEnabled:false,japaneseOutputGuard:true,
      searchPlannerModel:PLAN_MODEL,historyAwareSearchPlanner:true,searchPlanReuse:true,sttModel:'@cf/openai/whisper-large-v3-turbo',sttPrompt:false,sttHallucinationGuard:true,sttSignalGate:true,
      ttsPrimary:'browser explicit ja voice',ttsFallback:'browser default voice selected by lang=ja-JP',ttsFallbackEnabled:true,serverTtsEnabled:false,grokTtsActive:false,melottsFallback:false,
      searchAnnouncements:true,backchannels:true,bargeIn:true,legacyWebSocketVoice:false,durableObjectVoice:false
    });
    if(request.method==='GET'&&['/talk-v40.js','/talk-v39.js','/talk-v38.js'].includes(url.pathname))return new Response(TALK_CLIENT_V40,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV38.fetch(request,env);const html=(await base.text()).replace('/talk-v38.js','/talk-v40.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/tts')return json({ok:false,error:'server TTS disabled; device ja-JP speech is required'},503);
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}
      if(isEnglishSentence(body?.text))return json({ok:true,search:false,topic:'',resolvedQuestion:clean(body?.text,900),searchInstruction:'',ack:'',planner:'ja-only-v40',plannerMs:0,jst:''});
      return wrap(await workerV38.fetch(request,env));
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}
      if(isEnglishSentence(body?.text))return json({ok:true,answer:'日本語でお話しください。',search:false,route:'ja-only-input-guard-v40',searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local'});
      const response=await workerV38.fetch(request,env);const type=response.headers.get('content-type')||'';if(!type.includes('application/json'))return wrap(response);
      try{const data=await response.json();if(data?.ok&&typeof data.answer==='string'){data.answer=await repairJapanese(data.answer,env);data.languageMode='ja-only';}return json(data,response.status);}catch{return wrap(response);}
    }
    return wrap(await workerV38.fetch(request,env));
  }
};

export const __test={isEnglishSentence,needsJapaneseRepair};
