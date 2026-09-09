import workerV38 from './worker-v38.js';
import { TALK_CLIENT_V39 } from './talk-client-v39.js';
import { GrokJapaneseTTSV29, GROK_TTS_MODEL_V29, GROK_TTS_LANGUAGE_V29, GROK_TTS_VOICE_V29 } from './grok-japanese-tts-v29.js';

const REVISION='talksys-v39-japanese-only-grok-tts';
const JAPANESE_RE=/[ぁ-んァ-ヶ一-龠々]/u;
const LATIN_RE=/[A-Za-z]/g;
const PLAN_MODEL='@cf/zai-org/glm-5.3-flash';

function clean(v,max=5000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function json(data,status=200,extraHeaders={}){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION,...extraHeaders}});}
function wrap(response){const h=new Headers(response.headers);h.set('x-talksys-revision',REVISION);h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function isNonJapaneseLanguageInput(text){const v=clean(text,1400);if(!v)return false;if(JAPANESE_RE.test(v))return false;const latin=(v.match(LATIN_RE)||[]).length;return latin>=3;}
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
      {role:'system',content:'あなたはTalkSysの日本語出力補正器です。入力された回答の意味・事実・固有名詞・数値を変えず、自然な日本語だけに直してください。新しい事実を足さないでください。英語の文を残さないでください。URLやMarkdownを追加しないでください。出力は補正後の本文だけです。'},
      {role:'user',content:clean(answer,4500)}
    ],stream:false,modalities:['text'],max_completion_tokens:260,temperature:0.05,reasoning_effort:'low'});
    const fixed=extractText(result);return fixed||answer;
  }catch{return answer;}
}
async function handleTts(request,env){
  let body;try{body=await request.json();}catch{return json({ok:false,error:'invalid json'},400);}
  const text=clean(body?.text,1800);if(!text)return json({ok:false,error:'text required'},400);
  try{
    const tts=new GrokJapaneseTTSV29(env.AI);const started=Date.now();const audio=await tts.synthesize(text);
    if(!audio||audio.byteLength<100)return json({ok:false,error:'Grok Japanese TTS returned empty audio'},502);
    return new Response(audio,{headers:{'content-type':'audio/mpeg','cache-control':'no-store','x-talksys-revision':REVISION,'x-talksys-tts-model':GROK_TTS_MODEL_V29,'x-talksys-tts-language':GROK_TTS_LANGUAGE_V29,'x-talksys-tts-voice':GROK_TTS_VOICE_V29,'x-talksys-tts-ms':String(Date.now()-started)}});
  }catch(error){return json({ok:false,error:clean(error?.message||error,240)},502);}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({
      ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:'@cf/zai-org/glm-5.3-flash',languageMode:'ja-only',englishConversationEnabled:false,japaneseOutputGuard:true,
      searchPlannerModel:PLAN_MODEL,historyAwareSearchPlanner:true,searchPlanReuse:true,sttModel:'@cf/openai/whisper-large-v3-turbo',sttPrompt:false,sttHallucinationGuard:true,sttSignalGate:true,
      ttsPrimary:'browser/speechSynthesis ja-JP',ttsFallback:GROK_TTS_MODEL_V29,ttsFallbackLanguage:GROK_TTS_LANGUAGE_V29,ttsFallbackVoice:GROK_TTS_VOICE_V29,melottsFallback:false,ttsFallbackEnabled:true,
      searchAnnouncements:true,backchannels:true,bargeIn:true,legacyWebSocketVoice:false,durableObjectVoice:false
    });
    if(request.method==='GET'&&['/talk-v39.js','/talk-v38.js','/talk-v37.js'].includes(url.pathname))return new Response(TALK_CLIENT_V39,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV38.fetch(request,env);const html=(await base.text()).replace('/talk-v38.js','/talk-v39.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/tts')return handleTts(request,env);
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}
      if(isNonJapaneseLanguageInput(body?.text))return json({ok:true,search:false,topic:'',resolvedQuestion:clean(body?.text,900),searchInstruction:'',ack:'',planner:'ja-only-v39',plannerMs:0,jst:''});
      return wrap(await workerV38.fetch(request,env));
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}
      if(isNonJapaneseLanguageInput(body?.text))return json({ok:true,answer:'日本語でお話しください。',search:false,route:'ja-only-input-guard-v39',searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local'});
      const response=await workerV38.fetch(request,env);
      const type=response.headers.get('content-type')||'';if(!type.includes('application/json'))return wrap(response);
      try{
        const data=await response.json();if(data?.ok&&typeof data.answer==='string'){data.answer=await repairJapanese(data.answer,env);data.languageMode='ja-only';}
        return json(data,response.status);
      }catch{return wrap(response);}
    }
    return wrap(await workerV38.fetch(request,env));
  }
};

export const __test={isNonJapaneseLanguageInput,needsJapaneseRepair};
