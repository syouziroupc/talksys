import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildContextualFallbackPlan, normalizeContextualPlan } from '../src/search-v19.js';

const history = [
  { role: 'user', content: 'こんにちは' },
  { role: 'assistant', content: 'こんにちは。どうしました？' },
  { role: 'user', content: 'パソコンの買い替えについて相談したい' },
  { role: 'assistant', content: '主に何に使いたいですか？' },
];
const transcript = 'ネットサーフィンができればなんでもいいかなぁ　安いのがいい';

test('v19 fallback resolves the screenshot conversation into a PC shopping task before search', () => {
  const plan = buildContextualFallbackPlan(transcript, history);
  assert.match(plan.resolvedQuestion, /パソコン/);
  assert.match(plan.resolvedQuestion, /ネットサーフィン/);
  assert.match(plan.resolvedQuestion, /安い/);
  assert.ok(plan.queries.length >= 3);
  assert.ok(plan.queries.some((q) => /ネットサーフィン.*パソコン/.test(q)));
  assert.ok(plan.queries.every((q) => !/こんにちは|相談したい|かなぁ|なんでもいい/.test(q)));
});

test('v19 rejects raw conversational planner output and restores missing context constraints', () => {
  const badPlan = {
    resolvedQuestion: transcript,
    queries: [transcript, '安いのがいい パソコン 相談したい', 'ネットサーフィン パソコン 必要スペック'],
    intent: 'shopping',
    planned: true,
  };
  const plan = normalizeContextualPlan(badPlan, transcript, history);
  assert.match(plan.resolvedQuestion, /パソコン/);
  assert.match(plan.resolvedQuestion, /ネットサーフィン/);
  assert.match(plan.resolvedQuestion, /安い/);
  assert.ok(plan.queries.every((q) => !/相談したい|かなぁ|なんでもいい/.test(q)));
});

test('v19 planner-first search remains available as rollback while v20.1 owns production', () => {
  const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const workerV19 = fs.readFileSync(new URL('../src/worker-v19.js', import.meta.url), 'utf8');
  const workerV20 = fs.readFileSync(new URL('../src/worker-v20.js', import.meta.url), 'utf8');
  const search = fs.readFileSync(new URL('../src/search-v19.js', import.meta.url), 'utf8');
  assert.match(wrangler, /"main": "src\/worker-v20\.js"/);
  assert.match(workerV20, /conversationOrchestrator: 'tiered-fast-agent-v20\.1'/);
  assert.match(workerV20, /toolCalling: 'deterministic-search-router-v20\.1'/);
  assert.match(workerV20, /collectWebEvidenceV20/);
  assert.match(workerV20, /requiresFreshSearch\(transcript\)/);
  assert.doesNotMatch(workerV20, /runWithTools/);
  assert.match(workerV19, /answerWithContextualVerifiedSearchV19/);
  assert.match(workerV19, /cloudflare-live-v19\.0/);
  assert.match(search, /await resolvePlan\(ai, question, history, options\)/);
  assert.match(search, /const search = await runSearch\(ai, plan, options\)/);
  assert.doesNotMatch(search, /seedQuestion[\s\S]{0,300}firstSearchPromise/);
});

test('v19 general recommendation workaround remains available only as rollback behavior', () => {
  const worker = fs.readFileSync(new URL('../src/worker-v19.js', import.meta.url), 'utf8');
  const workerV20 = fs.readFileSync(new URL('../src/worker-v20.js', import.meta.url), 'utf8');
  assert.match(worker, /isGeneralRecommendationFollowup/);
  assert.match(worker, /quality-recommendation/);
  assert.match(worker, /streamBoundedQualityConversation/);
  assert.match(worker, /generalRecommendationRoute: 'quality-conversation-no-search'/);
  assert.match(worker, /おすすめ.*教えて/);
  assert.doesNotMatch(workerV20, /isGeneralRecommendationFollowup/);
});

test('v19 never exposes the old empty-answer placeholder as its final search response', () => {
  const search = fs.readFileSync(new URL('../src/search-v19.js', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../src/worker-v19.js', import.meta.url), 'utf8');
  assert.doesNotMatch(search, /確認できた範囲から、まず実用的な選択肢を絞って答えます/);
  assert.doesNotMatch(worker, /確認できた範囲から、まず実用的な選択肢を絞って答えます/);
  assert.match(search, /GROUNDING_CONVERSATION_MODEL[\s\S]*GROUNDING_FALLBACK_MODEL[\s\S]*QUALITY_CONVERSATION_MODEL[\s\S]*LIVE_CONVERSATION_MODEL/);
});

test('UI states that context is inherited and provides a safe processing trace', () => {
  const html = fs.readFileSync(new URL('../src/index-v19.js', import.meta.url), 'utf8');
  const trace = fs.readFileSync(new URL('../src/search-trace-client.js', import.meta.url), 'utf8');
  assert.match(html, /直前の相談内容を引き継いで回答・検索/);
  assert.doesNotMatch(html, /以前の質問内容は次の質問へ引き継ぎません/);
  assert.match(html, /AI処理ビュー/);
  assert.match(html, /内部の推論文ではなく/);
  assert.match(html, /会話から解決した検索課題/);
  assert.match(trace, /search_trace/);
  assert.match(trace, /trace-resolved/);
});
