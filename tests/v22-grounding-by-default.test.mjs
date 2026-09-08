import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  groundingDecisionV22,
  requiresGroundingSearchV22,
  GROUNDING_POLICY_V22_REVISION,
} from '../src/grounding-policy-v22.js';
import {
  resolveGroundedQuestionV22,
  SEARCH_TOOL_V22_REVISION,
} from '../src/search-v22.js';

const worker = fs.readFileSync(new URL('../src/worker-v22.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v22 is production entrypoint and keeps v21 as rollback base', () => {
  assert.match(wrangler, /"main":\s*"src\/worker-v22\.js"/);
  assert.match(worker, /extends TalkSysVoiceAgentV21/);
  assert.match(worker, /workerV21\.fetch/);
  assert.match(worker, /cloudflare-agent-v22-grounding-by-default/);
});

test('stable and current factual questions search by default, not only transit or stores', () => {
  const factual = [
    '富士山の標高は何メートルですか？',
    'トヨタの社長は誰ですか？',
    'Windows 11の要件を教えて',
    'iPhone 17の画面サイズは？',
    '別府市の人口は何人？',
    '消費税率は何パーセント？',
    'アスピリンとは何ですか？',
    '大谷翔平の所属チームは？',
    '東京スカイツリーは何m？',
    'Nintendo Switch 2の価格はいくら？',
    '鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです',
    '横浜駅周辺でパソコンを安く買える店はありますか？',
  ];
  for (const query of factual) {
    assert.equal(requiresGroundingSearchV22(query), true, query);
  }
});

test('only clearly conversational or subjective turns bypass search', () => {
  const nonSearch = [
    'こんにちは',
    'ありがとうございます',
    'パソコンの買い替えについて相談したいです',
    'ネットサーフィンと動画視聴ぐらいしかしません',
    'どう整理すればいいかな',
  ];
  for (const query of nonSearch) {
    assert.equal(requiresGroundingSearchV22(query), false, query);
  }
});

test('budget and market follow-up becomes grounded and inherits product context', () => {
  const history = [
    { role: 'user', content: 'パソコンの買い替えについて相談したいです' },
    { role: 'assistant', content: '主な用途を教えてください。' },
    { role: 'user', content: 'ネットサーフィンと動画視聴ぐらいしかしません' },
  ];
  const current = '5万円だったらどんなものがあるかな';
  assert.equal(requiresGroundingSearchV22(current, history), true);
  const resolved = resolveGroundedQuestionV22(current, history);
  assert.match(resolved, /パソコン/);
  assert.match(resolved, /5万円/);
});

test('store follow-up inherits both product and current location without assistant claims', () => {
  const history = [
    { role: 'user', content: 'パソコンを買いたいです' },
    { role: 'assistant', content: '予算を教えてください。' },
    { role: 'user', content: '5万円ぐらいです' },
  ];
  const resolved = resolveGroundedQuestionV22('店頭で安いところ 横浜駅周辺にない', history);
  assert.match(resolved, /パソコン/);
  assert.match(resolved, /横浜駅/);
  assert.doesNotMatch(resolved, /予算を教えてください/);
});

test('elliptical named-entity factual follow-ups inherit the prior subject', () => {
  const companyHistory = [{ role: 'user', content: 'トヨタ自動車について知りたい' }];
  assert.match(resolveGroundedQuestionV22('社長は誰？', companyHistory), /トヨタ自動車/);

  const storeHistory = [{ role: 'user', content: 'ヨドバシカメラ横浜店について' }];
  assert.match(resolveGroundedQuestionV22('営業時間は？', storeHistory), /ヨドバシカメラ横浜店/);
});

test('self-contained factual query is not polluted by unrelated older context', () => {
  const resolved = resolveGroundedQuestionV22('鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです', [
    { role: 'user', content: '5万円のパソコンが欲しい' },
  ]);
  assert.equal(resolved, '鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです');
});

test('grounding decision exposes risk classes for traceability', () => {
  const decision = groundingDecisionV22('Nintendo Switch 2の価格はいくら？');
  assert.equal(decision.search, true);
  assert.ok(decision.riskTags.includes('current-or-live-fact'));
  assert.ok(decision.riskTags.includes('numeric-or-date'));
  assert.ok(decision.riskTags.includes('factual-question'));
  assert.equal(GROUNDING_POLICY_V22_REVISION, 'grounding-by-default-v22');
  assert.equal(SEARCH_TOOL_V22_REVISION, 'evidence-only-web-tool-v22-grounding-default');
});

test('non-search model route is forbidden from inventing external facts', () => {
  assert.match(worker, /外部世界についての具体的な事実を新しく断定してはいけません/);
  assert.match(worker, /店舗名、会社名、人物、場所、路線、価格、在庫、営業時間、製品仕様、制度、法律/);
  assert.match(worker, /製品・店・制度などの相談で情報が足りない場合は、事実を作らず次に必要な条件を1つだけ聞いてください/);
});

test('grounded answer route uses evidence only and refuses to fill missing facts', () => {
  assert.match(worker, /回答中の具体的な外部事実は、必ず今回提示された検索根拠に直接支えられている内容だけ/);
  assert.match(worker, /モデルの記憶、一般常識、推測、連想で不足部分を補ってはいけません/);
  assert.match(worker, /確認できる根拠を取得できなかったため、この点は推測で断定しません/);
  assert.match(worker, /insufficientEvidenceStopsAssertion: true/);
  assert.match(worker, /factualQuestionsSearchByDefault: true/);
});
