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
  "export const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v119-r1';\nexport const PHONE_PERSONALIZATION_ACTIVE_REVISION = 'talksys-phone-personalization-v120-r1';\nconst PHONE_ACK_STT_GRACE_MS = 250;",
  'personalization revision',
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
  "if(sttSettled||closed)return;",
  "if(sttSettled||closed||latestAcceptedCapture===0)return;",
  'do not pre-ack first caller turn',
);
telephony = replaceOnce(
  telephony,
  "ok: true, revision: TELEPHONY_REVISION, observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION, integrated: true,",
  "ok: true, revision: TELEPHONY_REVISION, observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION, personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION, integrated: true,",
  'telephony personalization health',
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

for (const testPath of [
  'tests/phone-latency-fast-ack-v90.test.mjs',
  'tests/phone-conversation-baseline-lock-v118.test.mjs',
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

const v120Test = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gateTurnPayload } from '../src/entry.js';
import { PHONE_PERSONALIZATION_ACTIVE_REVISION } from '../src/telephony/index.js';

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

test('v120 removes wait-language from receipt ack and limits slow-STT pre-ack to later turns', () => {
  assert.match(telephony, /const FAST_ACK_TEXT = 'はい、確認しますね。'/);
  assert.doesNotMatch(telephony.slice(0, telephony.indexOf('export const PHONE_SEARCH_PROGRESS_REVISION')), /FAST_ACK_TEXT = 'はい、少々お待ちください。'/);
  assert.match(telephony, /if\(sttSettled\|\|closed\|\|latestAcceptedCapture===0\)return/);
  assert.match(telephony, /const PHONE_ACK_STT_GRACE_MS = 250/);
  assert.match(telephony, /selectPhoneAckText\(reaction,phoneAckAudioCache\.keys\(\),recentAckTexts\)/);
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
`;
fs.writeFileSync('tests/phone-quality-personalization-v120.test.mjs', v120Test);

console.log('Applied guarded TalkSys phone quality + personalization v120 patch.');
