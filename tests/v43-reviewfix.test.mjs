import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker,{__test as t} from '../src/worker-v43-reviewfix.js';
import {__test as finalT} from '../src/worker-v43-finalcandidate.js';

const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

function req(path,body){return new Request('https://talksys.example'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
function ctx(){return {waitUntil(){}};}

test('weather STT typo is explicitly disambiguated to Oita Beppu City',()=>{
  assert.equal(t.explicitWeatherText('明日の別途の天気は?',[]),'明日の大分県別府市の天気は?');
});

test('elliptical weather follow-up inherits prior city',()=>{
  const h=[{role:'user',content:'大分県別府市の明日の天気を知りたい'},{role:'assistant',content:'明日の予報を確認しました。'}];
  const x=t.explicitWeatherText('明後日は?',h);
  assert.match(x,/明後日/);assert.match(x,/大分県別府市/);assert.match(x,/天気/);
});

test('station pair is recovered from current or prior user context',()=>{
  assert.deepEqual(t.stationPair('大分駅から別府駅まで何に乗ればいい?',[]),['大分','別府']);
  const h=[{role:'user',content:'大分駅から別府駅まで行かないといけないんだけど、何を乗ればいいかわかんないんだよね。'},{role:'assistant',content:'検索できます。'}];
  assert.deepEqual(t.stationPair('今から君がちょっと検索してほしいんだけど。',h),['大分','別府']);
  assert.equal(t.transitContext('今から君がちょっと検索してほしいんだけど。',h),true);
});

test('search responses with no usable evidence cannot leak guessed facts',()=>{
  const x=t.guardDelegated({ok:true,search:true,searchUseful:false,route:'legacy',answer:'JRで15分、320円です。'});
  assert.equal(x.noEvidenceGuard,true);assert.match(x.route,/no-evidence-guard/);assert.doesNotMatch(x.answer,/15分|320円|JR/);
});

test('money grounding requires every spoken price to appear in evidence',()=>{
  const ev='A店 ノートPC 59,800円。B店 79,800円。';
  assert.equal(t.moneyGrounded('A店は59,800円です。',ev),true);
  assert.equal(t.moneyGrounded('A店は59,800円、別候補は69,800円です。',ev),false);
});

test('PC product filter rejects advice articles and accepts direct trusted commerce pages',()=>{
  assert.equal(t.trustedPcProductSource({title:'パソコンを安く買う方法',url:'https://www.nec-lavie.jp/column/cheap',excerpt:'ノートパソコンの選び方'}),false);
  assert.equal(t.trustedPcProductSource({title:'Inspiron 14 ノートパソコン',url:'https://www.dell.com/ja-jp/shop/laptops/inspiron-14',excerpt:'Inspiron ノートパソコン 89,800円 販売'}),true);
});

test('capability correction no longer quotes the false denial verbatim',async()=>{
  const body={text:'検索できるだろ君',history:[],searchPlan:{planner:'search-capability-local-v43',search:false}};
  const r=await worker.fetch(req('/api/turn',body),{},ctx());const j=await r.json();
  assert.equal(j.ok,true);assert.match(j.answer,/^検索できます/);assert.doesNotMatch(j.answer,/「この電話では検索できない」/);
});

test('safe device decision does not assert unsearched repair cost',async()=>{
  const body={text:'背面割れです。機種はXperia 5で、半年前にゲオで8000円で買いました。大事なデータは特に入っていません。修理か買い替えか悩んでいます。',history:[],searchPlan:{planner:'device-decision-local-v42',search:false}};
  const r=await worker.fetch(req('/api/turn',body),{},ctx());const j=await r.json();
  assert.equal(j.ok,true);assert.equal(j.search,false);assert.match(j.answer,/修理費用はこのターンでは調べていない/);assert.doesNotMatch(j.answer,/修理費用.{0,30}(?:高い|上回る).{0,20}(?:可能性が高い|珍しくない)/);
});

test('final candidate removes repeated phone greeting from PC advice',()=>{
  const x=finalT.polishPcAdvice('こんにちは、お電話ありがとうございます。パソコンの購入をご検討中とのことですね。主な用途を教えてください。');
  assert.equal(x,'主な用途を教えてください。');
});

test('production candidate entry is the final v43.1 wrapper and keeps migrations',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v43-finalcandidate\.js"/);
  assert.match(wrangler,/v1-voice/);assert.match(wrangler,/v33-delete-legacy-voice/);assert.match(wrangler,/TALKSYS_LOG_DB/);
});
