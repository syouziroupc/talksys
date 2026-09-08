import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requiresFreshSearch } from '../src/search-policy-v20.js';
import { compactToolEvidence, resolveSearchSeed, rankEvidenceSourcesV20 } from '../src/search-tool-v20.js';
import { buildDeterministicSearchQueries } from '../src/search-fallbacks.js';

const worker = fs.readFileSync(new URL('../src/worker-v20.js', import.meta.url), 'utf8');
const liveClient = fs.readFileSync(new URL('../src/cloudflare-live-client-v20.js', import.meta.url), 'utf8');
const bounded = fs.readFileSync(new URL('../src/bounded-conversation.js', import.meta.url), 'utf8');
const searchTool = fs.readFileSync(new URL('../src/search-tool-v20.js', import.meta.url), 'utf8');
const traceClient = fs.readFileSync(new URL('../src/search-trace-client.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v20.2 production entrypoint keeps one voice agent but removes tool inference from ordinary turns', () => {
  assert.match(wrangler, /"main":\s*"src\/worker-v20\.js"/);
  assert.match(worker, /cloudflare-agent-v20\.2-audio-search/);
  assert.match(worker, /streamBoundedLiveConversation/);
  assert.match(worker, /streamBoundedQualityConversation/);
  assert.match(worker, /instant-local-v20\.2/);
  assert.match(worker, /live-fast-v20\.2/);
  assert.match(worker, /deterministic-search-v20\.2/);
  assert.match(worker, /ordinaryConversationUsesToolInference: false/);
  assert.match(worker, /modelDecidesToolUse: false/);
  assert.doesNotMatch(worker, /runWithTools/);
  assert.doesNotMatch(worker, /maxRecursiveToolRuns/);
});

test('fresh, local, and named-business contact requests reliably route to search', () => {
  assert.equal(requiresFreshSearch('君がおすすめを教えてほしい'), false);
  assert.equal(requiresFreshSearch('YouTubeとネットだけならどんなパソコンがいい？'), false);
  assert.equal(requiresFreshSearch('今はちょっと疲れた'), false);
  assert.equal(requiresFreshSearch('今3万円以下で何が売ってる？'), true);
  assert.equal(requiresFreshSearch('別府でどこで買える？'), true);
  assert.equal(requiresFreshSearch('その店は今日何時まで？'), true);
  assert.equal(requiresFreshSearch('最新ニュースを調べて'), true);
  assert.equal(requiresFreshSearch('ドスパラ横浜駅前店の電話番号教えてよ'), true);
  assert.equal(requiresFreshSearch('エディオン別府店の住所は？'), true);
  assert.equal(requiresFreshSearch('大分県別府市に住んでるんだけどなんかどこかで買えないかな いい場所を知ってたら教えてください'), true);
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

test('granular current location wins over broader old context for nearby shopping', () => {
  const queries = buildDeterministicSearchQueries(
    '今 横浜市の高島町にいるんだけど 近くに買えそうなお店ってないかな',
    [
      { role: 'user', content: 'パソコンを買い換えたい' },
      { role: 'user', content: '5万円ぐらいで中古でもいい' },
    ],
  );
  assert.match(queries[0], /横浜市の高島町/);
  assert.match(queries[0], /パソコン/);
});

test('named-business detail lookup is never polluted by older shopping intent', () => {
  const queries = buildDeterministicSearchQueries(
    'ドスパラ横浜駅前店の電話番号教えてよ',
    [
      { role: 'user', content: '横浜駅周辺でパソコン販売店を探している' },
      { role: 'assistant', content: 'ドスパラ横浜駅前店があります。' },
    ],
  );
  assert.equal(queries.length, 2);
  assert.match(queries[0], /ドスパラ横浜駅前店/);
  assert.match(queries[0], /電話番号/);
  assert.match(queries[1], /公式/);
  assert.ok(queries.every((q) => !/購入先|中古 専門店|通販/.test(q)));
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

test('local store ranking rejects generic tourism and Wikipedia while keeping store-specific evidence', () => {
  const items = [
    { title: '日本一のおんせん県 大分県観光情報公式サイト', url: 'https://www.visit-oita.jp/', snippet: '大分県別府市の観光や温泉情報を紹介します。', engine: 'bing-rss' },
    { title: 'コジマ', url: 'https://ja.wikipedia.org/wiki/コジマ', snippet: '家電量販店についての百科事典記事です。', engine: 'wikipedia-ja' },
    { title: 'エディオン トキハ別府店', url: 'https://search.edion.com/e_store/spot/detail?code=0000001326', snippet: '大分県別府市北浜2丁目9番1号。取扱商品は家電製品、パソコン、スマートフォン。', engine: 'bing-rss' },
    { title: '別府パソコン電器', url: 'https://www.openstreetmap.org/node/123', snippet: '大分県別府市のパソコン・電器店', engine: 'openstreetmap-nominatim' },
  ];

  const ranked = rankEvidenceSourcesV20(items, '大分県別府市でパソコンを買える店を教えて', ['大分県別府市 パソコン 販売店']);
  assert.equal(ranked.length, 2);
  assert.ok(ranked.some((item) => /エディオン トキハ別府店/.test(item.title)));
  assert.ok(ranked.some((item) => /別府パソコン電器/.test(item.title)));
  assert.ok(ranked.every((item) => !/観光|Wikipedia/.test(`${item.title} ${item.url}`)));
});

test('v20.2 search is evidence-only, bounded to two queries, verifies detail pages, and adds OSM for local commerce', () => {
  assert.match(searchTool, /evidence-only-web-tool-v20\.2-verified-local/);
  assert.match(searchTool, /SEARCH_TOOL_V20_MAX_QUERIES = 2/);
  assert.match(searchTool, /buildDeterministicSearchQueries/);
  assert.match(searchTool, /webSearch/);
  assert.match(searchTool, /searchBingRss/);
  assert.match(searchTool, /searchOpenStreetMapLocal/);
  assert.match(searchTool, /enrichPages: profile\.detailLookup/);
  assert.match(searchTool, /sources\.length < 3/);
  assert.match(searchTool, /wikipedia.*google-news/i);
  assert.match(searchTool, /DETAIL_LOOKUP_RE/);
  assert.doesNotMatch(searchTool, /buildContextualFallbackPlan/);
  assert.doesNotMatch(searchTool, /runNonStreamingCascade/);
  assert.doesNotMatch(searchTool, /GROUNDING_CONVERSATION_MODEL/);
  assert.doesNotMatch(searchTool, /auditAnswer/);

  const compact = compactToolEvidence({
    resolvedQuestion: '別府でパソコンを買える店舗',
    queries: ['別府 パソコン 店舗'],
    sources: [{ title: '実在店舗', url: 'https://example.com/shop', excerpt: '営業時間などの確認済み情報', engine: 'test' }],
  });
  assert.equal(compact.resolvedQuestion, '別府でパソコンを買える店舗');
  assert.equal(compact.sources.length, 1);
  assert.equal(compact.sources[0].title, '実在店舗');
  assert.ok(!('answer' in compact));
});

test('v20.2 microphone client has AEC, capture fallback, muted monitor and strict far-end echo guard', () => {
  assert.match(worker, /CLOUDFLARE_LIVE_CLIENT_V20/);
  assert.match(worker, /\/cloudflare-live\.js/);
  assert.match(liveClient, /echoCancellation/);
  assert.match(liveClient, /noiseSuppression/);
  assert.match(liveClient, /autoGainControl/);
  assert.match(liveClient, /createWorkletCapture/);
  assert.match(liveClient, /createScriptProcessorCapture/);
  assert.match(liveClient, /captureSilenceGain\.gain\.value = 0/);
  assert.match(liveClient, /if \(assistantAudioActive\(\)\) return/);
  assert.match(liveClient, /PLAYBACK_TAIL_GUARD_MS = 700/);
  assert.doesNotMatch(liveClient, /workletNode\.connect\(audioContext\.destination\)/);
});

test('bounded model stream recovers instead of accepting a partial reply as complete', () => {
  assert.match(bounded, /recoverContinuation/);
  assert.match(bounded, /continuationMessages/);
  assert.match(bounded, /looksComplete/);
  assert.doesNotMatch(bounded, /if \(yielded\) return;\s*\n\s*}\s*\n\s*if \(yielded\) return;/);
});

test('search trace keeps a direct-event path plus websocket compatibility fallback', () => {
  assert.match(traceClient, /talksys-search-trace/);
  assert.match(traceClient, /talksys-model-route/);
  assert.match(traceClient, /TraceWebSocket/);
  assert.match(liveClient, /talksys-search-trace/);
  assert.match(liveClient, /talksys-model-route/);
});

test('v20.2 keeps the old phone transport and call-scoped memory runtime as its base', () => {
  assert.match(worker, /extends BaseTalkSysVoiceAgent/);
  assert.match(worker, /legacyV19Available: true/);
  assert.match(worker, /voiceBuiltinHistoryDisabled: true/);
  assert.match(worker, /fixedSearchWaitSpeech: true/);
  assert.match(worker, /strictHalfDuplexEchoGuard: true/);
  assert.match(worker, /midStreamContinuationRecovery: true/);
  assert.match(worker, /namedBusinessContactSearch: true/);
  assert.match(worker, /少し調べますね/);
  assert.match(worker, /\/api\/search-smoke-yokohama/);
  assert.match(worker, /\/api\/search-smoke-contact/);
});
