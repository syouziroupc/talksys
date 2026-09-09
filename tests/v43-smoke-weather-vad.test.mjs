import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import workerV43,{__test as routing} from '../src/worker-v43.js';
import { TALK_CLIENT_V43, __test as clientFlags } from '../src/talk-client-v43.js';

const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

function req(path,body){return new Request('https://talksys.example'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
function ctx(){return {waitUntil(){}};}

test('v43 client is valid and contains adaptive noisy-room controls',()=>{
  assert.doesNotThrow(()=>new Function(TALK_CLIENT_V43));
  assert.equal(clientFlags.hasAdaptiveNoise,true);
  assert.equal(clientFlags.hasCalibration,true);
  assert.equal(clientFlags.hasFalseNoiseReject,true);
  assert.equal(clientFlags.hasThreeFrameGate,true);
  assert.equal(clientFlags.hasSttNoiseLearning,true);
  assert.match(TALK_CLIENT_V43,/noiseBoost/);
  assert.match(TALK_CLIENT_V43,/1\.4秒環境音キャリブレーション/);
  assert.match(TALK_CLIENT_V43,/falseNoiseRejects/);
});

test('v43 repairs common Beppu STT typo only in weather location parsing',()=>{
  assert.equal(routing.normalizeWeatherLocationText('明日の別途の天気は?'),'別府');
  assert.equal(routing.weatherLocation('明日の大分県別府市の天気は?',[]),'大分県別府市');
  const p=routing.weatherPlan('明日の別途の天気は?',[]);
  assert.equal(p.search,true);assert.equal(p.planner,'weather-direct-v43');assert.match(p.resolvedQuestion,/別府.*明日/);
});

test('v43 identifies PC advice separately from explicit PC lookup',()=>{
  const h=[];
  assert.equal(routing.pcAdvice('最近パソコンを買おうか悩んでるんだよね',h),true);
  assert.equal(routing.pcLookup('最近パソコンを買おうか悩んでるんだよね',h),false);
  const h2=[{role:'user',content:'最近パソコンを買おうか悩んでるんだよね'}];
  assert.equal(routing.pcLookup('大分県内で安いお店を検索して',h2),true);
});

test('v43 catches search capability challenge and old false capability wording',()=>{
  assert.equal(routing.capabilityQuestion('検索できるだろ君'),true);
  assert.equal(routing.NO_SEARCH_CAPABILITY_RE.test('すみません、この電話では検索ができない仕組みなんです。'),true);
});

test('v43 HTTP plan routes vague PC shopping to advice, not a fake-price route',async()=>{
  const response=await workerV43.fetch(req('/api/plan',{text:'最近パソコンを買おうか悩んでるんだよね',history:[]}),{},ctx());
  const j=await response.json();assert.equal(response.status,200);assert.equal(j.search,false);assert.equal(j.planner,'pc-advice-local-v43');
});

test('v43 HTTP turn for PC advice does not deny search or invent a price',async()=>{
  const env={AI:{run:async()=>({response:'まず用途と予算を整理するのが先です。ネットや書類中心か、ゲームや動画編集もするかで必要な性能が変わります。予算と主な用途を教えてください。必要なら、その条件で具体的な機種や現在の価格をこちらで検索して絞れます。'})}};
  const body={text:'最近パソコンを買おうか悩んでるんだよね',history:[],searchPlan:{planner:'pc-advice-local-v43',search:false}};
  const response=await workerV43.fetch(req('/api/turn',body),env,ctx());const j=await response.json();
  assert.equal(j.ok,true);assert.equal(j.search,false);assert.equal(j.route,'pc-advice-v43');
  assert.doesNotMatch(j.answer,/検索.{0,15}(?:できない|できません|使えない)/);
  assert.doesNotMatch(j.answer,/\d+\s*万円|\d{4,}\s*円/);
});

test('v43 capability turn explicitly states search is available',async()=>{
  const body={text:'検索できるだろ君',history:[],searchPlan:{planner:'search-capability-local-v43',search:false}};
  const response=await workerV43.fetch(req('/api/turn',body),{},ctx());const j=await response.json();
  assert.equal(j.ok,true);assert.equal(j.route,'search-capability-v43');assert.match(j.answer,/検索できます/);assert.doesNotMatch(j.answer,/検索できない仕組み/);
});

test('v43 weather turn uses direct weather data and answers Beppu without give-up text',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>{
    const s=String(url);
    if(s.includes('geocoding-api.open-meteo.com'))return new Response(JSON.stringify({results:[{name:'別府市',admin1:'大分県',latitude:33.2847,longitude:131.4912}]}),{status:200,headers:{'content-type':'application/json'}});
    if(s.includes('api.open-meteo.com/v1/forecast')){
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const tomorrow=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000));
      return new Response(JSON.stringify({daily:{time:[today,tomorrow],weather_code:[1,2],temperature_2m_max:[29,28],temperature_2m_min:[22,21],precipitation_probability_max:[20,30]}}),{status:200,headers:{'content-type':'application/json'}});
    }
    throw new Error('unexpected fetch '+s);
  };
  try{
    const body={text:'明日の大分県別府市の天気は?',history:[],searchPlan:{planner:'weather-direct-v43',search:true}};
    const response=await workerV43.fetch(req('/api/turn',body),{},ctx());const j=await response.json();
    assert.equal(j.ok,true);assert.equal(j.search,true);assert.equal(j.route,'weather-direct-v43');assert.equal(j.searchUseful,true);
    assert.match(j.answer,/大分県別府市.*明日/);assert.match(j.answer,/最高気温/);assert.match(j.answer,/降水確率/);assert.doesNotMatch(j.answer,/申し訳ありません|自分で|天気アプリ/);
    assert.ok(j.sources.some(x=>/open-meteo/i.test(x.url)));
  }finally{globalThis.fetch=original;}
});

test('v43 production config selects v43 while preserving D1 and migration history',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v43\.js"/);
  assert.match(wrangler,/"binding"\s*:\s*"TALKSYS_LOG_DB"/);
  assert.match(wrangler,/v1-voice/);assert.match(wrangler,/v33-delete-legacy-voice/);
});
