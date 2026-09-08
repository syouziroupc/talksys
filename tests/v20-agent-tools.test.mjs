import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requiresFreshSearch } from '../src/search-policy-v20.js';
import { compactToolEvidence, resolveSearchSeed } from '../src/search-tool-v20.js';
import { buildDeterministicSearchQueries } from '../src/search-fallbacks.js';

const worker = fs.readFileSync(new URL('../src/worker-v20.js', import.meta.url), 'utf8');
const searchTool = fs.readFileSync(new URL('../src/search-tool-v20.js', import.meta.url), 'utf8');
const traceClient = fs.readFileSync(new URL('../src/search-trace-client.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v20.1 production entrypoint keeps one voice agent but removes tool inference from ordinary turns', () => {
  assert.match(wrangler, /"main":\s*"src\/worker-v20\.js"/);
  assert.match(worker, /cloudflare-agent-v20\.1-fast-search/);
  assert.match(worker, /streamBoundedLiveConversation/);
  assert.match(worker, /streamBoundedQualityConversation/);
  assert.match(worker, /instant-local-v20\.1/);
  assert.match(worker, /live-fast-v20\.1/);
  assert.match(worker, /deterministic-search-v20\.1/);
  assert.match(worker, /ordinaryConversationUsesToolInference: false/);
  assert.match(worker, /modelDecidesToolUse: false/);
  assert.doesNotMatch(worker, /runWithTools/);
  assert.doesNotMatch(worker, /maxRecursiveToolRuns/);
});

test('fresh and real-world local requests reliably route to search', () => {
  assert.equal(requiresFreshSearch('君がおすすめを教えてほしい'), false);
  assert.equal(requiresFreshSearch('YouTubeとネットだけならどんなパソコンがいい？'), false);
  assert.equal(requiresFreshSearch('今はちょっと疲れた'), false);
  assert.equal(requiresFreshSearch('今3万円以下で何が売ってる？'), true);
  assert.equal(requiresFreshSearch('別府でどこで買える？'), true);
  assert.equal(requiresFreshSearch('その店は今日何時まで？'), true);
  assert.equal(requiresFreshSearch('最新ニュースを調べて'), true);
  assert.equal(
    requiresFreshSearch('大分県別府市に住んでるんだけどなんかどこかで買えないかな いい場所を知ってたら教えてください'),
    true,
  );
});

test('deterministic search planner restores product and location from conversation', () => {
  const history = [
    { role: 'user', content: 'パソコンの買い替えについて相談に乗って欲しい' },
    { role: 'assistant', content: '用途を教えてください。' },
    { role: 'user', content: 'YouTubeとインターネットだけ見れれば何でもいい。安い方がいい。' },
  ];
  const queries = buildDeterministicSearchQueries(
    '大分県別府市に住んでるんだけどなんかどこかで買えないかな いい場所を知ってたら教えてください',
    history,
  );
  assert.ok(queries.length >= 1);
  assert.match(queries[0], /別府市/);
  assert.match(queries[0], /パソコン/);
  assert.match(queries[0], /販売店|家電量販店|店舗/);
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

test('v20.1 search tool is evidence-only, bounded to two deterministic queries, and avoids page enrichment', () => {
  assert.match(searchTool, /evidence-only-web-tool-v20\.1-fast/);
  assert.match(searchTool, /SEARCH_TOOL_V20_MAX_QUERIES = 2/);
  assert.match(searchTool, /buildDeterministicSearchQueries/);
  assert.match(searchTool, /webSearch/);
  assert.match(searchTool, /searchBingRss/);
  assert.match(searchTool, /enrichPages: false/);
  assert.match(searchTool, /merged\.length < 4/);
  assert.doesNotMatch(searchTool, /buildContextualFallbackPlan/);
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

test('search trace keeps a direct-event path plus websocket compatibility fallback', () => {
  assert.match(traceClient, /talksys-search-trace/);
  assert.match(traceClient, /talksys-model-route/);
  assert.match(traceClient, /TraceWebSocket/);
});

test('v20.1 keeps the old phone transport and call-scoped memory runtime as its base', () => {
  assert.match(worker, /extends BaseTalkSysVoiceAgent/);
  assert.match(worker, /legacyV19Available: true/);
  assert.match(worker, /voiceBuiltinHistoryDisabled: true/);
  assert.match(worker, /fixedSearchWaitSpeech: true/);
  assert.match(worker, /少し調べますね/);
  assert.match(worker, /\/api\/search-smoke/);
});
