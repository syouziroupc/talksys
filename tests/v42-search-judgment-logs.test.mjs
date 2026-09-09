import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V42 } from '../src/talk-client-v42.js';
import { __test as worker } from '../src/worker-v42.js';
import { __test as search } from '../src/search-v42.js';
import { __test as logs } from '../src/log-v42.js';

const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
const workerSource=fs.readFileSync(new URL('../src/worker-v42.js',import.meta.url),'utf8');
const logSource=fs.readFileSync(new URL('../src/log-v42.js',import.meta.url),'utf8');

test('v42 generated browser client is valid and carries one session id through plan turn and STT',()=>{
  assert.doesNotThrow(()=>new Function(TALK_CLIENT_V42));
  assert.match(TALK_CLIENT_V42,/talkSessionId/);
  assert.match(TALK_CLIENT_V42,/sessionId:talkSessionId/);
  assert.match(TALK_CLIENT_V42,/'x-talksys-session':talkSessionId/);
  assert.match(TALK_CLIENT_V42,/talksys-v42-search-judgment-persistent-logs/);
});

test('v42 keeps repair-versus-replace advice local when current facts are not requested',()=>{
  assert.equal(worker.isGeneralPhoneDecision('スマホが終わってしまいました 買い替えるか修理するか悩んでいます',[]),true);
  const h=[{role:'user',content:'スマホが終わってしまいました。買い替えるか修理するか悩んでいます。'}];
  assert.equal(worker.isGeneralPhoneDecision('背面割れです。機種はエクスペリア5で、半年ぐらい前にゲオで8000円で買いました。大事なデータは特に入っていません。',h),true);
  assert.equal(worker.isGeneralPhoneDecision('Androidが古いから、中古で安い他の携帯に乗り換えようかと思っています。',h),true);
});

test('v42 searches explicit phone lookup and retry turns',()=>{
  const h=[{role:'user',content:'初代Xperia 5はAndroidが古いので中古へ乗り換えたい'}];
  assert.equal(worker.isExplicitPhoneLookup('もうちょっと調べてみてよ。2万円以下のスマホについて。',h),true);
  assert.equal(worker.isExplicitPhoneLookup('2万円以下のスマホで候補を探して',h),true);
  assert.equal(worker.isGeneralPhoneDecision('もうちょっと調べてみてよ。2万円以下のスマホについて。',h),false);
});

test('v42 search constraints come only from user turns, never assistant inventions',()=>{
  const h=[
    {role:'user',content:'Androidが古いから中古で安いスマホへ乗り換えたい'},
    {role:'assistant',content:'Android 13以降、SIMフリー、保証付きが条件ですね。'}
  ];
  const flags=worker.userConstraintFlags('2万円以下で探して',h);
  assert.equal(flags.used,true);assert.equal(flags.androidOld,true);assert.equal(flags.simFree,false);assert.equal(flags.warranty,false);assert.equal(flags.budget,'2万円以下');
  const plan=worker.makePhoneSearchPlan('2万円以下で探して',h);
  assert.equal(plan.planner,'phone-shopping-local-v42');assert.equal(plan.search,true);
  assert.match(plan.searchInstruction,/価格だけで推薦しない/);
  assert.match(plan.searchInstruction,/勝手に必須条件へ追加しない/);
  assert.doesNotMatch(plan.resolvedQuestion,/Android 13|SIMフリー|保証/);
});

test('v42 rejects junk search sources and accepts trusted seller or model-specific official OS sources',()=>{
  assert.equal(search.isTrustedPhoneSource({title:'ローマ数字の2の表記や覚え方',url:'https://toushitsu-off8.com/roman',snippet:'Android 2'}),false);
  assert.equal(search.isTrustedPhoneSource({title:'AQUOS sense5G 中古',url:'https://www.iosys.co.jp/items/smartphone',snippet:'AQUOS sense5G 中古 9,980円'}),true);
  assert.equal(search.isTrustedPhoneSource({title:'AQUOS sense5G OSアップデート',url:'https://k-tai.sharp.co.jp/support/aquos-sense5g/update/',snippet:'AQUOS sense5G Android 12 バージョンアップ'}),true);
});

test('v42 only verifies a phone candidate when price and OS evidence refer to the same model',()=>{
  const price={title:'AQUOS sense5G 中古',url:'https://www.iosys.co.jp/items/smartphone',snippet:'AQUOS sense5G 中古 9,980円'};
  const general={title:'Android OS一覧',url:'https://support.google.com/android/',snippet:'Android 16の情報'};
  assert.equal(search.verifiedCandidates([price,general]).length,0);
  const os={title:'AQUOS sense5G OSアップデート',url:'https://k-tai.sharp.co.jp/support/aquos-sense5g/update/',snippet:'AQUOS sense5G Android 12 バージョンアップ'};
  const verified=search.verifiedCandidates([price,os]);assert.equal(verified.length,1);assert.match(verified[0].model,/AQUOS sense5G/i);
});

test('v42 answer policy explicitly blocks the old search-giveup family',()=>{
  for(const s of ['申し訳ありません、今回確認できる情報が得られませんでした','具体的な機種のご案内はできません','通販サイトで検索してください'])assert.equal(worker.GIVEUP_RE.test(s),true);
  assert.match(workerSource,/確認できた有用な事実を先に答え/);
  assert.match(workerSource,/発売年が新しいだけで/);
});

test('v42 persistent log records conversation and diagnostics but never raw audio bytes',()=>{
  const request=new Request('https://talksys.example/api/turn',{method:'POST',headers:{'x-talksys-session':'session-123'}});
  const rec=logs.buildLogRecord({request,body:{sessionId:'session-123',text:'2万円以下で探して',history:[{role:'user',content:'中古スマホが欲しい'}],searchPlan:{search:true,planner:'phone-shopping-local-v42'}},result:{ok:true,answer:'候補です',route:'resilient-search-v42',search:true,queries:['q'],sources:[{title:'店',url:'https://example.com'}]},event:'turn',status:200,revision:'v42',extra:{audioBytes:12345}});
  assert.match(rec.key,/session-123/);assert.equal(rec.value.userText,'2万円以下で探して');assert.equal(rec.value.audioBytes,12345);assert.equal('rawAudio' in rec.value,false);assert.equal(rec.value.result.route,'resilient-search-v42');
  assert.match(logSource,/TALKSYS_LOG_DB\.prepare/);assert.match(logSource,/INSERT INTO conversation_logs/);assert.doesNotMatch(logSource,/TALKSYS_LOGS\.put/);
});

test('v42 production config binds private D1 logs and full Workers observability without removing migration history',()=>{
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v42\.js"/);
  assert.match(wrangler,/"binding"\s*:\s*"TALKSYS_LOG_DB"/);assert.match(wrangler,/"database_name"\s*:\s*"talksys-conversation-logs"/);
  assert.match(wrangler,/"database_id"\s*:\s*"4d40b1c6-2436-4c5f-bb0a-e8e173a6d91a"/);
  assert.match(wrangler,/"observability"[\s\S]*"enabled"\s*:\s*true/);assert.match(wrangler,/"head_sampling_rate"\s*:\s*1/);
  assert.match(wrangler,/v1-voice/);assert.match(wrangler,/v33-delete-legacy-voice/);
});

test('v42 health source advertises local general advice, escalating search and private persistent logs',()=>{
  assert.match(workerSource,/general-advice-local-current-lookup-search/);assert.match(workerSource,/escalating-up-to-five-pass/);assert.match(workerSource,/persistentConversationLogs:'d1-private'/);assert.match(workerSource,/logBinding:'TALKSYS_LOG_DB'/);assert.match(workerSource,/rawAudioLogged:false/);
});
