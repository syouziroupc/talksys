import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V37 } from '../src/talk-client-v37.js';
import { __test as routing } from '../src/worker-v37.js';
import { __test as search } from '../src/search-v26.js';

const worker=fs.readFileSync(new URL('../src/worker-v37.js',import.meta.url),'utf8');
const searchSource=fs.readFileSync(new URL('../src/search-v26.js',import.meta.url),'utf8');
const wrangler=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('v37 rewrites next-train follow-up with route context and Japan time',()=>{
  const history=[{role:'user',content:'大分から別府まで行きたいんだけど、何で行こう。'},{role:'assistant',content:'JR日豊本線がおすすめです。'}];
  const r=routing.rewriteSearch('次の電車、大分発何時?',history,new Date('2026-09-09T06:30:00Z'));
  assert.match(r,/2026年9月9日/);
  assert.match(r,/大分駅から別府駅/);
  assert.match(r,/現在時刻以降/);
  assert.match(r,/発車時刻/);
});

test('v37 understands search retry requests as the previous unresolved question',()=>{
  const history=[{role:'user',content:'次の電車、大分発何時?'},{role:'assistant',content:'正確な時刻は分かりませんでした。'}];
  const r=routing.rewriteSearch('もうちょっと何とかしてくれよ。',history,new Date('2026-09-09T06:30:00Z'));
  assert.match(r,/次の電車、大分発何時/);
  assert.match(r,/別の検索元/);
});

test('v37 can answer what was actually searched without launching another search',()=>{
  const answer=routing.traceAnswer({resolvedQuestion:'大分駅から別府駅の次の電車',queries:['大分駅 別府駅 時刻表','大分駅 別府駅 乗換'],sources:[{title:'Yahoo!路線情報'}]});
  assert.match(answer,/大分駅から別府駅/);
  assert.match(answer,/大分駅 別府駅 時刻表/);
  assert.match(answer,/Yahoo!路線情報/);
});

test('v37 purchase lookup is explicit about trustworthy purchase sources',()=>{
  const history=[{role:'user',content:'動画視聴用の安いノートパソコンでいい。'}];
  const r=routing.rewriteSearch('どこで買えばいいの?',history);
  assert.match(r,/メーカー直販/);
  assert.match(r,/パソコン専門店/);
  assert.match(r,/保証/);
});

test('v37 client greets first and announces searches',()=>{
  assert.match(TALK_CLIENT_V37,/AIアシスタントのフォーンズです/);
  assert.match(TALK_CLIENT_V37,/について検索しています。/);
  assert.match(TALK_CLIENT_V37,/\/api\/plan/);
});

test('v37 resumes prior speech after a false barge-in with no transcript',()=>{
  assert.match(TALK_CLIENT_V37,/resumeInterruptedSpeech/);
  assert.match(TALK_CLIENT_V37,/新しい発話なし。元の読み上げを再開/);
  assert.match(TALK_CLIENT_V37,/falseBargeResumes/);
  assert.match(TALK_CLIENT_V37,/if\(!gotText&&resumePlan\)/);
});

test('v37 search stores actual query and source trace',()=>{
  assert.match(TALK_CLIENT_V37,/searchTrace=/);
  assert.match(TALK_CLIENT_V37,/resolvedQuestion/);
  assert.match(TALK_CLIENT_V37,/lastSearchQueries/);
});

test('search v26 has generic redundant Bing fallback for all sparse factual searches',()=>{
  assert.match(searchSource,/augmentGenericEvidence/);
  assert.match(searchSource,/genericFallbackSucceeded/);
  assert.match(searchSource,/searchBingRss/);
  assert.match(searchSource,/複数の検索元で根拠を再確認/);
});

test('transit search pins current JST into Yahoo route parameters',()=>{
  assert.match(searchSource,/URLSearchParams/);
  assert.match(searchSource,/m1:/);
  assert.match(searchSource,/m2:/);
  assert.match(searchSource,/type: '1'/);
  assert.match(searchSource,/y: t\.year/);
  assert.match(searchSource,/requestedAtJst/);
  assert.deepEqual(search.stationPair('大分駅から別府駅までの次の電車'),['大分','別府']);
});

test('v37 is wired as production entry',()=>{
  assert.match(worker,/talksys-v37-grounded-continuity/);
  assert.match(worker,/falseBargeResume:true/);
  assert.match(worker,/genericSearchFallback:true/);
  assert.match(wrangler,/"main"\s*:\s*"src\/worker-v37\.js"/);
});
