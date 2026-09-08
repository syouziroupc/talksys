import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requiresFreshSearch } from '../src/search-policy-v20.js';
import { compactToolEvidence, resolveSearchSeed } from '../src/search-tool-v20.js';

const worker = fs.readFileSync(new URL('../src/worker-v20.js', import.meta.url), 'utf8');
const searchTool = fs.readFileSync(new URL('../src/search-tool-v20.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v20 production entrypoint is a single conversation agent with embedded web search', () => {
  assert.match(wrangler, /"main":\s*"src\/worker-v20\.js"/);
  assert.match(worker, /cloudflare-agent-tools-v20\.0/);
  assert.match(worker, /runWithTools/);
  assert.match(worker, /name: 'web_search'/);
  assert.match(worker, /streamFinalResponse: true/);
  assert.match(worker, /maxRecursiveToolRuns: 1/);
  assert.match(worker, /QUALITY_CONVERSATION_MODEL/);
  assert.match(worker, /conversationOrchestrator: 'single-agent-v20'/);
  assert.match(worker, /modelDecidesToolUse: true/);
  assert.doesNotMatch(worker, /shouldDeepSearch\(/);
  assert.doesNotMatch(worker, /isGeneralRecommendationFollowup/);
  assert.doesNotMatch(worker, /generateSearchFiller/);
});

test('fresh or location-sensitive facts have a narrow mandatory search safety guard', () => {
  assert.equal(requiresFreshSearch('君がおすすめを教えてほしい'), false);
  assert.equal(requiresFreshSearch('YouTubeとネットだけならどんなパソコンがいい？'), false);
  assert.equal(requiresFreshSearch('今はちょっと疲れた'), false);
  assert.equal(requiresFreshSearch('今3万円以下で何が売ってる？'), true);
  assert.equal(requiresFreshSearch('別府でどこで買える？'), true);
  assert.equal(requiresFreshSearch('その店は今日何時まで？'), true);
  assert.equal(requiresFreshSearch('最新ニュースを調べて'), true);
});

test('mandatory search restores arbitrary non-PC subjects from recent user context', () => {
  const history = [
    { role: 'user', content: 'AirPods Pro 4がほしい' },
    { role: 'assistant', content: '用途を確認します。' },
  ];
  const seed = resolveSearchSeed('どこで買える？', history);
  assert.match(seed, /AirPods Pro 4/);
  assert.match(seed, /どこで買える/);
});

test('short location-dependent follow-up carries the previous user location without assistant text', () => {
  const history = [
    { role: 'user', content: '福岡市に旅行する予定' },
    { role: 'assistant', content: '架空の店名を混ぜないでください' },
    { role: 'user', content: 'ホテルを探したい' },
  ];
  const seed = resolveSearchSeed('安いのある？', history);
  assert.match(seed, /福岡市/);
  assert.match(seed, /ホテルを探したい/);
  assert.doesNotMatch(seed, /架空の店名/);
});

test('self-contained search questions are not polluted by unrelated old context', () => {
  const history = [{ role: 'user', content: '昨日はパソコンの話をしていた' }];
  assert.equal(resolveSearchSeed('東京駅の営業時間を調べて', history), '東京駅の営業時間を調べて');
});

test('v20 search tool returns evidence rather than a separately generated answer', () => {
  assert.match(searchTool, /collectWebEvidenceV20/);
  assert.match(searchTool, /resolveSearchSeed/);
  assert.match(searchTool, /webSearch/);
  assert.match(searchTool, /searchBingRss/);
  assert.match(searchTool, /formatSearchContext/);
  assert.doesNotMatch(searchTool, /runNonStreamingCascade/);
  assert.doesNotMatch(searchTool, /GROUNDING_CONVERSATION_MODEL/);
  assert.doesNotMatch(searchTool, /auditAnswer/);

  const compact = compactToolEvidence({
    resolvedQuestion: '別府でパソコンを買える店舗',
    queries: ['別府 パソコン 店舗'],
    sources: [
      {
        title: '実在店舗',
        url: 'https://example.com/shop',
        excerpt: '営業時間などの確認済み情報',
        engine: 'test',
      },
    ],
  });
  assert.equal(compact.resolvedQuestion, '別府でパソコンを買える店舗');
  assert.equal(compact.sources.length, 1);
  assert.equal(compact.sources[0].title, '実在店舗');
  assert.ok(!('answer' in compact));
});

test('v20 keeps the old phone transport and memory runtime as its base', () => {
  assert.match(worker, /extends BaseTalkSysVoiceAgent/);
  assert.match(worker, /legacyV19Available: true/);
  assert.match(worker, /voiceBuiltinHistoryDisabled: true/);
  assert.match(worker, /fixedSearchWaitSpeech: true/);
  assert.match(worker, /少し調べますね/);
});
