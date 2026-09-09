import workerV40 from './worker-v40.js';
import { TALK_CLIENT_V41 } from './talk-client-v41.js';
import { collectResilientEvidenceV41 } from './search-v41.js';

const REVISION='talksys-v41-safety-search-backchannel';
const MODEL='@cf/zai-org/glm-5.3-flash';
const FRESH_RE=/(最新|現在|今日|明日|昨日|今年|価格|値段|相場|在庫|営業時間|ニュース|発売|販売中|現行|法改正|予定|日程|時刻表|運行|遅延|予約|電話番号|住所|所在地|アクセス|公式サイト|URL|どこで買|店舗|販売店|検索して|調べて|確認して)/i;
const SUBJECTIVE_RE=/(どう思う|どうかな|と思う(?:かな|？|\?)|話を聞いて|雑談|そうなんだね|そうだね|なるほどね|って感じ|おやつに入る)/i;
const RETRY_RE=/(もうちょっと|もう少し|もっと|再度|もう一度|引き続き|詳しく|ちゃんと).*?(?:調べ|探|検索|確認)|(?:調べ|探|検索).*?(?:直して|続けて|もっと)/i;
const PHONE_RE=/(スマホ|スマートフォン|携帯|Android|iPhone|Xperia|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi)/i;
const SHOPPING_RE=/(中古|新品|買|購入|乗り換え|乗換|機種|候補|価格|値段|予算|円|万円|在庫|販売|安い)/i;

function clean(v,max=6000){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max);}
function historyOf(v){return Array.isArray(v)?v.slice(-14).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,1500)})).filter(x=>x.content):[];}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});}
function wrap(response){const h=new Headers(response.headers);h.set('x-talksys-revision',REVISION);h.set('cache-control','no-store');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function extractText(result){if(typeof result==='string')return clean(result);if(!result)return '';for(const v of [result.response,result.result,result.text,result.output_text])if(typeof v==='string'&&v.trim())return clean(v);const c=result.choices?.[0]?.message?.content;if(typeof c==='string')return clean(c);if(Array.isArray(c))return clean(c.map(x=>typeof x==='string'?x:x?.text||x?.content||'').join(''));return clean(result.choices?.[0]?.text||'');}
function evidenceBlock(search){return (Array.isArray(search?.sources)?search.sources:[]).slice(0,10).map((x,i)=>`[${i+1}] ${clean(x?.title,220)}\n${clean(x?.url,700)}\n${clean(x?.excerpt||x?.snippet||'',1800)}`).join('\n\n');}
function isSubjectiveChat(text){return SUBJECTIVE_RE.test(clean(text,500))&&!FRESH_RE.test(text);}

function classifySafety(text){
  const v=clean(text,1600);
  if(/(死にたい|自殺したい|自殺する|自分を傷つけたい|自分を殺したい|消えてしまいたい|生きていたくない)/u.test(v))return 'self-harm';

  const minor=/(幼児|幼女|子ども|子供|小学生|中学生|未成年|児童|少女|少年)/u.test(v);
  const sexualBroad=/(セックス|性交|性行為|挿入|中出し|フェラ|クンニ|オナニー|自慰|ちんこ|ちんぽ|まんこ|膣|アナル|射精|勃起|裸|エロ|性的|犯す|ハメる)/u.test(v);
  const graphicSex=/(挿入|中出し|フェラ|クンニ|オナニー|自慰|ちんこ|ちんぽ|まんこ|膣|アナル|射精|勃起|犯す|ハメる)/u.test(v);
  const bananaSlang=/(?:女の子|女性|彼女|相手).{0,28}(?:俺|僕|自分)のバナナ.{0,20}(?:入れ|挿れ|突っ込)|(?:俺|僕|自分)のバナナ.{0,20}(?:女の子|女性|彼女|相手).{0,20}(?:入れ|挿れ|突っ込)|(?:俺|僕|自分)のバナナ.{0,20}(?:入れ|挿れ|突っ込)/u.test(v);
  const coerciveSex=/(レイプ|強姦|無理やり|無理矢理|嫌がって.{0,18}(?:セックス|挿入|触|犯)|同意なし.{0,18}(?:セックス|挿入|触))/u.test(v);
  const eroticRequest=/(エロい話|エロく話|官能的に|ポルノ|淫語|喘ぎ声|性的に興奮させ|興奮するように|裸を詳しく描写)/u.test(v);
  if(minor&&sexualBroad)return 'sexual-minor';
  if(coerciveSex)return 'sexual-coercion';
  if(bananaSlang||eroticRequest||(graphicSex&&/(したい|して|教えて|描写|話して|言って|入れ|挿れ|突っ込|舐め|触り|犯す|ハメ)/u.test(v)))return 'sexual-explicit';

  if(/(?:民族|人種|宗教|国民|外国人|女性|男性|障害者|同性愛者|移民|在日|中国人|韓国人|日本人|黒人|白人).{0,24}(?:皆殺し|殺せ|絶滅|排除しろ|消せ)/u.test(v))return 'violent-hate';
  if(/(殺し方|傷つけ方|刺し方|首を絞める方法|バレずに殺|証拠を消す方法|爆弾.{0,12}(作り方|作る方法)|毒.{0,12}(作り方|作る方法)|放火.{0,12}(方法|やり方)|テロ.{0,12}(方法|やり方)|人を殺したい|誰かを殺したい)/u.test(v))return 'violent-action';

  const extremist=/(ISIS|ISIL|イスラム国|アルカイダ|ネオナチ|ナチズム|白人至上主義|KKK|テロ組織|暴力的過激派|武装過激派)/i.test(v);
  const extremistSupport=/(参加したい|入りたい|加わりたい|支持したい|支持すべき|勧誘したい|仲間を増や|宣伝したい|広めたい|プロパガンダ.{0,12}(書|作)|称賛する文章|資金提供したい|寄付したい|攻撃を正当化|万歳)/u.test(v);
  if(extremist&&extremistSupport)return 'extremist-support';
  return '';
}
function safetyReply(kind){
  if(kind==='self-harm')return 'その話は軽く扱えません。今すぐ自分を傷つけそうなら、一人にならず近くの人に知らせて、119など緊急の助けを呼んでください。今ここで、何が起きていてどれくらい切迫しているかは聞けます。';
  if(kind==='sexual-minor')return '未成年を性的な対象にする内容には付き合えません。年齢に関係しない恋愛や、同意・性教育の相談なら普通に話せます。';
  if(kind==='sexual-coercion')return '相手の同意がない性的な行為を後押しすることはできません。気持ちの伝え方や、同意をどう確かめるかなら一緒に考えられます。';
  if(kind==='sexual-explicit')return 'その下ネタには乗れません。恋愛や相手との距離の縮め方、同意や避妊の相談なら普通に話せます。';
  if(kind==='violent-hate')return '特定の集団への暴力や排除をあおる話には加担できません。何が不満なのかを整理したり、非暴力で解決する方法を考えることならできます。';
  if(kind==='violent-action')return '人を傷つける具体的な方法には協力できません。トラブルを収める方法や、自分や周囲の人を安全にする方法なら一緒に考えられます。';
  if(kind==='extremist-support')return '暴力的な過激思想の支持、勧誘、宣伝には協力できません。思想の背景や主張の検証、過激化を避ける方法なら中立に話せます。';
  return '';
}
function conversationAck(text){
  const v=clean(text,500);
  if(/(ちょっと|少し)?.{0,8}(話を聞いて|聞いてほしい|相談に乗って)/u.test(v))return 'はい、聞いています。';
  if(/^(相談したい|相談がある|話したいことがある)[。！？!?\s]*$/u.test(v))return 'はい、どうぞ。';
  return '';
}
function searchAck(text,plan={}){
  const v=clean(`${text} ${plan?.resolvedQuestion||''}`,900);
  if(RETRY_RE.test(text))return 'もう少し広く探します。';
  if(PHONE_RE.test(v)&&SHOPPING_RE.test(v))return '中古スマホを条件で探します。';
  if(/(中古|新品|買|購入|機種|候補|価格|値段|予算|在庫|販売)/i.test(v))return '候補を絞って探します。';
  if(/(場所|住所|所在地|アクセス|どこ)/i.test(v))return '場所を確認します。';
  if(/(最新|現在|今日|ニュース|予定|時刻表|運行|遅延)/i.test(v))return '最新情報を確認します。';
  return '少し確認します。';
}
async function runGlm(env,messages,max=360){const started=Date.now();const result=await env.AI.run(MODEL,{messages,stream:false,modalities:['text'],max_completion_tokens:max,temperature:0.08,reasoning_effort:'low'});const text=extractText(result);if(!text)throw new Error('empty model answer');return {text,elapsedMs:Date.now()-started};}
const SAFE_GROUNDED_PROMPT=`あなたはTalkSysという日本語の電話相談AIです。電話で自然に話す日本語だけで答えてください。\n今回のターンでは複数段階のWeb検索を実行済みです。検索結果の羅列ではなく、利用者の質問に直接答えてください。\n商品相談では、根拠に具体的な機種名・価格・販売元があるなら2〜4候補を具体的に挙げ、利用者の条件に合う理由を短く説明してください。「自分で検索してください」「確認できませんでした」で簡単に終えないでください。\n根拠が一部しかない場合も、確認できた範囲を先に答え、足りない部分だけを明示してください。根拠にない価格・在庫・仕様は作らないでください。\n成人同士の恋愛、同意、避妊、性教育や健康相談は普通に扱ってください。露骨な性的描写や性的な煽りには乗らないでください。自傷の相談は拒否せず安全確保を優先してください。他害、武器、暴力扇動、差別扇動、暴力的過激思想の支持・勧誘・宣伝の具体的支援は提供せず、安全な代替案へ戻してください。\n通常2〜5文。URL、Markdown、内部処理、検索回数、モデル名は読み上げないでください。`;

async function resilientSearchTurn(body,plan,env){
  const started=Date.now(),text=clean(body?.text,1800),history=historyOf(body?.history),resolved=clean(plan?.resolvedQuestion,1000)||text,instruction=clean(plan?.searchInstruction,1400);
  const searchStarted=Date.now();const search=await collectResilientEvidenceV41(resolved,history,instruction);const searchMs=Date.now()-searchStarted;
  const evidence=evidenceBlock(search);const messages=[{role:'system',content:SAFE_GROUNDED_PROMPT},...history,{role:'user',content:`相談: ${resolved}\n検索上の条件: ${instruction||'(追加条件なし)'}\n\n[今回取得した根拠]\n${evidence||'(根拠を取得できませんでした)'}\n\nこの根拠で可能な限り具体的に答えてください。`}];
  const generated=await runGlm(env,messages,360);
  return json({ok:true,answer:generated.text,search:true,route:'resilient-search-v41',searchUseful:Boolean(search?.sources?.length),resolvedQuestion:search?.resolvedQuestion||resolved,queries:Array.isArray(search?.queries)?search.queries.slice(0,12):[],sources:Array.isArray(search?.sources)?search.sources.slice(0,10).map(x=>({title:clean(x?.title,220),url:clean(x?.url,700)})):[],searchPasses:Number(search?.searchPasses)||1,concreteShoppingEvidence:Boolean(search?.concreteShoppingEvidence),trustedDirectEvidence:Number(search?.trustedDirectEvidence)||0,timings:{totalMs:Date.now()-started,searchMs,glmMs:generated.elapsedMs,plannerMs:Number(plan?.plannerMs)||0},model:MODEL,planner:plan?.planner||'v41-client-plan',searchPlan:instruction,languageMode:'ja-only'});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/voice-health')return json({ok:true,revision:REVISION,voiceRevision:REVISION,architecture:'http-turns-client-vad',conversationModel:MODEL,languageMode:'ja-only',englishConversationEnabled:false,japaneseOutputGuard:true,safetyGuard:'v41-contextual',sexualExplicitGuard:true,minorSexualGuard:true,sexualCoercionGuard:true,selfHarmSupport:true,violentActionGuard:true,hateViolenceGuard:true,extremistSupportGuard:true,searchMode:'multi-pass-resilient',maxSearchPasses:3,trustedShoppingDirectFetch:true,searchRetryOnWeakEvidence:true,nonSearchBackchannel:'selective',searchBackchannel:'contextual-single',sttModel:'@cf/openai/whisper-large-v3-turbo',ttsPrimary:'browser explicit ja voice',ttsFallback:'browser default voice selected by lang=ja-JP',serverTtsEnabled:false,grokTtsActive:false,melottsFallback:false,bargeIn:true,legacyWebSocketVoice:false,durableObjectVoice:false});
    if(request.method==='GET'&&['/talk-v41.js','/talk-v40.js','/talk-v39.js'].includes(url.pathname))return new Response(TALK_CLIENT_V41,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    if(request.method==='GET'&&url.pathname==='/'){
      const base=await workerV40.fetch(request,env);const html=(await base.text()).replace('/talk-v40.js','/talk-v41.js');return new Response(html,{status:base.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-talksys-revision':REVISION}});
    }
    if(request.method==='POST'&&url.pathname==='/api/plan'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1200);const safety=classifySafety(text);
      if(safety)return json({ok:true,search:false,topic:'',resolvedQuestion:text,searchInstruction:'',ack:'',planner:'safety-local-v41',plannerMs:0,jst:''});
      if(isSubjectiveChat(text))return json({ok:true,search:false,topic:'',resolvedQuestion:text,searchInstruction:'',ack:conversationAck(text),planner:'subjective-local-v41',plannerMs:0,jst:''});
      const r=await workerV40.fetch(request,env);const type=r.headers.get('content-type')||'';if(!type.includes('application/json'))return wrap(r);try{const data=await r.json();if(data?.ok)data.ack=data.search?searchAck(text,data):conversationAck(text);data.planner=data.planner||'v40-base-v41';return json(data,r.status);}catch{return wrap(r);}
    }
    if(request.method==='POST'&&url.pathname==='/api/turn'){
      let body;try{body=await request.clone().json();}catch{return json({ok:false,error:'invalid json'},400);}const text=clean(body?.text,1800);if(!text)return json({ok:false,error:'text required'},400);
      const safety=classifySafety(text);if(safety)return json({ok:true,answer:safetyReply(safety),search:false,route:`safety-${safety}-v41`,safetyClass:safety,searchUseful:false,resolvedQuestion:'',queries:[],sources:[],timings:{totalMs:0,searchMs:0,glmMs:0},model:'local',languageMode:'ja-only'});
      const plan=body?.searchPlan&&typeof body.searchPlan==='object'?body.searchPlan:null;
      if(plan?.search){try{return await resilientSearchTurn(body,plan,env);}catch(error){const fallback=await workerV40.fetch(request,env);return wrap(fallback);}}
      return wrap(await workerV40.fetch(request,env));
    }
    return wrap(await workerV40.fetch(request,env));
  }
};

export const __test={classifySafety,safetyReply,conversationAck,searchAck,isSubjectiveChat};
