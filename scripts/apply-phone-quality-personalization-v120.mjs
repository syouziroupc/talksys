import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`missing patch anchor: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous patch anchor: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

const telephonyPath = 'src/telephony/index.js';
let telephony = fs.readFileSync(telephonyPath, 'utf8');
telephony = replaceOnce(
  telephony,
  "export const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v119-r1';\nconst PHONE_ACK_STT_GRACE_MS = 250;",
  "export const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v120-r1';\nexport const PHONE_PERSONALIZATION_ACTIVE_REVISION = 'talksys-phone-personalization-v120-r1';\nexport const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v120-r1';\nexport const PHONE_RELEASE_VERSION = 'v120';\nconst PHONE_ACK_STT_GRACE_MS = 250;",
  'v120 phone revisions',
);
telephony = replaceOnce(
  telephony,
  "const FAST_ACK_TEXT = 'はい、少々お待ちください。';",
  "const FAST_ACK_TEXT = 'はい、確認しますね。';",
  'neutral fast acknowledgement',
);
telephony = replaceOnce(
  telephony,
  "const PHONE_SLOW_STT_ACK_TEXTS = Object.freeze([\n  FAST_ACK_TEXT,\n  PHONE_ACK_VARIANTS.request[0],\n  PHONE_ACK_VARIANTS.question[0],\n  PHONE_ACK_VARIANTS.listening[0],\n]);",
  "const PHONE_SLOW_STT_ACK_TEXTS = Object.freeze([\n  PHONE_ACK_VARIANTS.request[0],\n  PHONE_ACK_VARIANTS.question[0],\n  PHONE_ACK_VARIANTS.listening[0],\n  FAST_ACK_TEXT,\n]);",
  'slow STT acknowledgement order',
);
telephony = replaceOnce(
  telephony,
  "function detailJson(detail = {}) {\n  try { return clean(JSON.stringify(detail || {}), 4000); } catch { return '{}'; }\n}",
  "function detailJson(detail = {}) {\n  try { return clean(JSON.stringify(detail || {}), 4000); } catch { return '{}'; }\n}\nfunction phoneRuntimeVersionDetail(env = {}) {\n  const meta = env?.CF_VERSION_METADATA || {};\n  return {\n    revision: PHONE_RUNTIME_LOG_REVISION,\n    talksysVersion: PHONE_RELEASE_VERSION,\n    workerVersionId: clean(meta?.id || '', 200),\n    workerVersionTag: clean(meta?.tag || '', 200),\n    workerVersionTimestamp: clean(meta?.timestamp || '', 120),\n    telephonyRevision: TELEPHONY_REVISION,\n    observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION,\n    conversationBaselineRevision: PHONE_CONVERSATION_BASELINE_REVISION,\n    ackRevision: PHONE_ACK_LATENCY_REVISION,\n    personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION,\n  };\n}",
  'runtime version detail',
);
telephony = replaceOnce(
  telephony,
  "    ok: true, revision: TELEPHONY_REVISION, observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION, integrated: true,",
  "    ok: true, revision: TELEPHONY_REVISION, observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION, releaseVersion: PHONE_RELEASE_VERSION, runtimeLogRevision: PHONE_RUNTIME_LOG_REVISION, workerVersionId: clean(env?.CF_VERSION_METADATA?.id || '', 200), personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION, integrated: true,",
  'telephony v120 health metadata',
);
telephony = replaceOnce(
  telephony,
  "    let sttSettled=false,slowAckStarted=false,slowAckText='',slowAckAudio=null,slowAckPromise=Promise.resolve(false);\n    const sttPromise=transcribeSamples(env,samples);\n    const slowAckTimer=setTimeout(()=>{\n      if(sttSettled||closed)return;\n      const selected=selectPreparedSlowSttAck(phoneAckAudioCache.keys(),recentAckTexts);\n      const prepared=selected?(selected===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(selected)):null;\n      if(!selected||!prepared?.bytes?.byteLength){queueLatency(turnId,'ack_slow_stt_unprepared',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS});return;}\n      slowAckStarted=true;slowAckText=selected;slowAckAudio=prepared;\n      queueLatency(turnId,'ack_slow_stt_fallback',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS,text:selected,bytes:prepared.bytes.byteLength});\n      slowAckPromise=speak(selected,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:prepared}).then((reacted)=>{if(reacted){recentAckTexts=[...recentAckTexts,selected].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'slow-stt-receipt',text:selected,cached:true,revision:PHONE_ACK_LATENCY_REVISION}));}return reacted;});\n      trackTask(slowAckPromise.catch((error)=>{console.warn(JSON.stringify({type:'phone_slow_stt_ack_error',turnId,error:clean(error?.message||error,240)}));return false;}));\n    },PHONE_ACK_STT_GRACE_MS);",
  "    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;\n    const sttPromise=transcribeSamples(env,samples);\n    const slowAckTimer=setTimeout(()=>{\n      if(sttSettled||closed||latestAcceptedCapture===0)return;\n      const selected=selectPreparedSlowSttAck(phoneAckAudioCache.keys(),recentAckTexts);\n      const prepared=selected?(selected===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(selected)):null;\n      if(!selected||!prepared?.bytes?.byteLength){queueLatency(turnId,'ack_slow_stt_unprepared',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS});return;}\n      slowAckArmed=true;slowAckText=selected;slowAckAudio=prepared;\n      queueLatency(turnId,'ack_slow_stt_armed',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS,text:selected,bytes:prepared.bytes.byteLength});\n    },PHONE_ACK_STT_GRACE_MS);",
  'arm slow STT acknowledgement without pre-verdict playout',
);
telephony = replaceOnce(
  telephony,
  "      latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();if(!slowAckStarted)interruptPlayback();",
  "      latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();interruptPlayback();",
  'accepted capture playback reset',
);
telephony = replaceOnce(
  telephony,
  "        const ackText=slowAckStarted?slowAckText:categoryAckText;\n        const ackAudio=slowAckStarted?slowAckAudio:categoryAckAudio;",
  "        const ackText=slowAckArmed?slowAckText:categoryAckText;\n        const ackAudio=slowAckArmed?slowAckAudio:categoryAckAudio;",
  'use armed slow acknowledgement after STT acceptance',
);
telephony = replaceOnce(
  telephony,
  "        if(slowAckStarted){queueLatency(turnId,'ack_already_started',Date.now()-speechEndAt,{text:ackText,revision:PHONE_ACK_LATENCY_REVISION,reactionKind:reaction.kind||'none'});}\n        else if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}",
  "        if(slowAckArmed&&ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_slow_stt_committed',Date.now()-speechEndAt,{text:ackText,revision:PHONE_ACK_LATENCY_REVISION,reactionKind:reaction.kind||'none'});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'slow-stt-receipt',text:ackText,cached:true,revision:PHONE_ACK_LATENCY_REVISION}));}}\n        else if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}",
  'commit slow STT acknowledgement only after accepted transcription',
);
telephony = replaceOnce(
  telephony,
  "      const start=message.start||{},params=customParameters(start);callId=clean(params.call_id||start.call_sid||start.callSid||start.call_control_id||crypto.randomUUID(),200);from=clean(params.from||start.from||'',80);to=clean(params.to||start.to||'',80);\n      const profilePhoneAtStart=from,profileLoadStartedAt=Date.now(),profileTurnId=`${clean(callId||'call',120)}-profile`;",
  "      const start=message.start||{},params=customParameters(start);callId=clean(params.call_id||start.call_sid||start.callSid||start.call_control_id||crypto.randomUUID(),200);from=clean(params.from||start.from||'',80);to=clean(params.to||start.to||'',80);\n      const runtimeTurnId=`${clean(callId||'call',120)}-runtime`;\n      queueLatency(runtimeTurnId,'runtime_revision',0,phoneRuntimeVersionDetail(env));\n      const profilePhoneAtStart=from,profileLoadStartedAt=Date.now(),profileTurnId=`${clean(callId||'call',120)}-profile`;",
  'runtime version log at call start',
);
fs.writeFileSync(telephonyPath, telephony);

const entryPath = 'src/entry.js';
let entry = fs.readFileSync(entryPath, 'utf8');
entry = replaceOnce(
  entry,
  "  '現在時刻、今日・明日、交通、価格、在庫、天気、営業時間など変動する具体値は、信頼できるサーバー時刻または取得済み外部根拠だけを使い、モデル内部の知識や過去の回答から推測してはいけません。' +\n  '交通では、現在時刻より前の便を「次」と扱わず、具体的な発車時刻・乗換・番線は取得済み根拠で確認できた場合だけ述べてください。' +",
  "  '現在時刻、今日・明日、交通、価格、在庫、天気、営業時間など変動する具体値は、信頼できるサーバー時刻または取得済み外部根拠だけを使い、モデル内部の知識や過去の回答から推測してはいけません。' +\n  '一方、歴史・科学・文化・一般概念など時点に依存しにくい一般知識は、高い確度で分かる範囲なら通常どおり答えてください。外部根拠が無いという理由だけで「分かりません」「推測できません」と回避しないでください。' +\n  '交通では、現在時刻より前の便を「次」と扱わず、具体的な発車時刻・乗換・番線は取得済み根拠で確認できた場合だけ述べてください。' +",
  'stable knowledge instruction boundary',
);
entry = replaceOnce(
  entry,
  "const ENTITY_RECOMMENDATION_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在)/i;",
  "const ENTITY_RECOMMENDATION_RE = /(おすすめ|候補|近く|近所|周辺|最寄り|探して|探す|見つけて|見つける|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|実在|存在|営業中|開いて)/i;",
  'narrow evidence fail-closed intent',
);
fs.writeFileSync(entryPath, entry);

const wranglerPath = 'wrangler.jsonc';
let wrangler = fs.readFileSync(wranglerPath, 'utf8');
wrangler = replaceOnce(
  wrangler,
  '  "ai": { "binding": "AI" },\n  "d1_databases": [{',
  '  "ai": { "binding": "AI" },\n  "version_metadata": { "binding": "CF_VERSION_METADATA" },\n  "d1_databases": [{',
  'Cloudflare Worker version metadata binding',
);
fs.writeFileSync(wranglerPath, wrangler);

for (const testPath of [
  'tests/phone-latency-fast-ack-v90.test.mjs',
  'tests/phone-conversation-baseline-lock-v118.test.mjs',
  'tests/phone-fast-reaction-v2.test.mjs',
]) {
  let test = fs.readFileSync(testPath, 'utf8');
  test = test.replace(/はい、少々お待ちください。/g, 'はい、確認しますね。');
  fs.writeFileSync(testPath, test);
}

const v115Path = 'tests/phone-personalization-profile-v115.test.mjs';
let v115 = fs.readFileSync(v115Path, 'utf8');
v115 = replaceOnce(
  v115,
  "test('phase one does not inject profile data into the live TalkSys turn', async () => {",
  "test('profile storage is not queried synchronously inside the live TalkSys turn', async () => {",
  'remove obsolete phase-one test wording',
);
fs.writeFileSync(v115Path, v115);

const v119Test = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v120 arms slow-STT acknowledgement but commits playout only after accepted STT', () => {
  assert.match(source, /PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v120-r1'/);
  assert.match(source, /const PHONE_ACK_STT_GRACE_MS = 250/);
  assert.match(source, /PHONE_SLOW_STT_ACK_TEXTS/);
  assert.match(source, /const sttPromise=transcribeSamples\(env,samples\)/);
  assert.match(source, /ack_slow_stt_armed/);
  assert.match(source, /ack_slow_stt_committed/);
  assert.match(source, /if\(sttSettled\|\|closed\|\|latestAcceptedCapture===0\)return/);
  const timerStart = source.indexOf('const slowAckTimer=setTimeout');
  const timerEnd = source.indexOf('},PHONE_ACK_STT_GRACE_MS);', timerStart);
  const timerBlock = source.slice(timerStart, timerEnd);
  assert.ok(timerStart >= 0 && timerEnd > timerStart);
  assert.doesNotMatch(timerBlock, /\bspeak\s*\(/, 'slow-STT timer must never play audio before STT acceptance');
  const rejectGate = source.indexOf("if(!stt?.ok||!stt.text||myCapture<latestAcceptedCapture)");
  const commit = source.indexOf("ack_slow_stt_committed");
  assert.ok(rejectGate >= 0 && commit > rejectGate, 'slow acknowledgement commit must be downstream of STT rejection gate');
  assert.match(source, /selectPhoneAckText\(reaction,phoneAckAudioCache\.keys\(\),recentAckTexts\)/);
});

test('v120 does not reopen the frozen v118 audio quality settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.doesNotMatch(source, /const FAST_ACK_TEXT = 'はい。'/);
});

test('batch ZIP avoids per-call D1 N+1 queries and dashboard supports real PUT options', () => {
  assert.match(source, /TALKSYS_LOG_DB\.batch\(\[/);
  assert.match(source, /WHERE call_id IN \(\$\{placeholders\}\)/);
  const zipStart = source.indexOf('async function recentCallsZip');
  const zipEnd = source.indexOf('async function texmlResponse', zipStart);
  const zipBlock = source.slice(zipStart, zipEnd);
  assert.doesNotMatch(zipBlock, /await callJsonlContent\(env, call\)/);
  assert.match(source, /async function api\(path,options=\{\}\)/);
  assert.match(source, /\.\.\.options,headers:\{\.\.\.auth\(\),\.\.\.\(options\.headers\|\|\{\}\)\}/);
  assert.match(source, /ZIP応答が破損しています/);
});
`;
fs.writeFileSync('tests/phone-second-turn-ack-zip-v119.test.mjs', v119Test);

const v120Test = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gateTurnPayload } from '../src/entry.js';
import { PHONE_PERSONALIZATION_ACTIVE_REVISION, PHONE_RELEASE_VERSION, PHONE_RUNTIME_LOG_REVISION } from '../src/telephony/index.js';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v120 distinguishes stable knowledge from current or externally verified facts', () => {
  const answer = '株式会社という形態について、一般的な仕組みを説明します。';
  const stable = gateTurnPayload({ answer, searchUseful: false, sources: [], apiSources: [] }, '株式会社について教えてください');
  assert.equal(stable.answer, answer);
  assert.doesNotMatch(stable.answer, /根拠では|挙げられません/);
  assert.match(entry, /時点に依存しにくい一般知識/);
  assert.match(entry, /外部根拠が無いという理由だけで/);

  const dynamic = gateTurnPayload({ answer: '近くなら架空病院がおすすめです。', searchUseful: false, sources: [], apiSources: [] }, '近くの病院をおすすめして');
  assert.doesNotMatch(dynamic.answer, /架空病院/);
  assert.ok(dynamic.truthGate.applied);
});

test('v120 removes wait-language from receipt ack and never preplays an unvalidated slow-STT capture', () => {
  assert.match(telephony, /const FAST_ACK_TEXT = 'はい、確認しますね。'/);
  assert.doesNotMatch(telephony.slice(0, telephony.indexOf('export const PHONE_SEARCH_PROGRESS_REVISION')), /FAST_ACK_TEXT = 'はい、少々お待ちください。'/);
  assert.match(telephony, /if\(sttSettled\|\|closed\|\|latestAcceptedCapture===0\)return/);
  assert.match(telephony, /const PHONE_ACK_STT_GRACE_MS = 250/);
  const timerStart = telephony.indexOf('const slowAckTimer=setTimeout');
  const timerEnd = telephony.indexOf('},PHONE_ACK_STT_GRACE_MS);', timerStart);
  assert.ok(timerStart >= 0 && timerEnd > timerStart);
  assert.doesNotMatch(telephony.slice(timerStart, timerEnd), /\bspeak\s*\(/);
  assert.match(telephony, /ack_slow_stt_armed/);
  assert.match(telephony, /ack_slow_stt_committed/);
});

test('v120 keeps the frozen phone audio and answer-quality baseline intact', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.match(telephony, /bargeThreshold=Math\.max\(threshold\*1\.25,noiseFloor\*3\.2,0\.010\)/);
  assert.match(telephony, /streamPcmu20ms\(audio\.bytes/);
});

test('phone-number personalization is an active text-only TalkSys feature, not a parallel answer engine', () => {
  assert.equal(PHONE_PERSONALIZATION_ACTIVE_REVISION, 'talksys-phone-personalization-v120-r1');
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /displayName: clean\(callerProfile\?\.displayName \|\| '', 80\)/);
  assert.match(telephony, /personalizationText: clean\(callerProfile\?\.personalizationText \|\| '', 4000\)/);
  assert.match(telephony, /memoryText: clean\(callerProfile\?\.memoryText \|\| '', 8000\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
  assert.match(integrated, /呼び名:/);
  assert.match(integrated, /応答方針:/);
  assert.match(integrated, /継続メモ:/);
  assert.match(integrated, /現在の利用者発言と矛盾する場合は現在の発言を優先/);
  assert.match(telephony, /pathname === '\/phone-profiles'/);
  assert.doesNotMatch(telephony, /await\s+loadCallerProfileForSession\(/);
});

test('v120 records the executable phone version in every new call log', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v120');
  assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v120-r1');
  assert.match(wrangler, /"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"\s*\}/);
  assert.match(telephony, /workerVersionId: clean\(meta\?\.id \|\| '', 200\)/);
  assert.match(telephony, /workerVersionTag: clean\(meta\?\.tag \|\| '', 200\)/);
  assert.match(telephony, /workerVersionTimestamp: clean\(meta\?\.timestamp \|\| '', 120\)/);
  assert.match(telephony, /queueLatency\(runtimeTurnId,'runtime_revision',0,phoneRuntimeVersionDetail\(env\)\)/);
});
`;
fs.writeFileSync('tests/phone-quality-personalization-v120.test.mjs', v120Test);

console.log('Applied guarded TalkSys phone quality + personalization + runtime-log v120 patch.');
