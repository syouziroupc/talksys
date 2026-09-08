import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  requiresFreshSearchV21,
  resolveSearchSeedV21,
  SEARCH_TOOL_V21_REVISION,
} from '../src/search-v21.js';
import { CLOUDFLARE_LIVE_CLIENT_V21 } from '../src/cloudflare-live-client-v21.js';

const worker = fs.readFileSync(new URL('../src/worker-v21.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v21 is the production entrypoint and preserves v20 as its rollback base', () => {
  assert.match(wrangler, /"main":\s*"src\/worker-v21\.js"/);
  assert.match(worker, /extends TalkSysVoiceAgentV20/);
  assert.match(worker, /workerV20\.fetch/);
  assert.match(worker, /cloudflare-agent-v21-mobile-transit-reliability/);
});

test('station-to-station transit questions are mandatory fresh-search turns', () => {
  assert.equal(requiresFreshSearchV21('鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです'), true);
  assert.equal(requiresFreshSearchV21('東京駅から新宿駅まで電車で何分？'), true);
  assert.equal(requiresFreshSearchV21('こんにちは'), false);
});

test('station-area shopping follow-up restores product context from prior user turns', () => {
  const history = [
    { role: 'user', content: 'パソコンの買い替えについて相談したいです' },
    { role: 'assistant', content: '用途を教えてください。' },
    { role: 'user', content: 'ネットサーフィンと動画視聴ぐらいしかしません' },
    { role: 'user', content: '5万円だったらどんなものがあるかな' },
  ];
  const seed = resolveSearchSeedV21('店頭で安いところ 横浜駅周辺にない', history);
  assert.match(seed, /パソコン/);
  assert.match(seed, /横浜駅/);
  assert.match(seed, /店頭で安いところ/);
  assert.doesNotMatch(seed, /用途を教えてください/);
  assert.equal(requiresFreshSearchV21('店頭で安いところ 横浜駅周辺にない', history), true);
});

test('self-contained transit question is not polluted by old shopping context', () => {
  const seed = resolveSearchSeedV21('鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです', [
    { role: 'user', content: '5万円のパソコンがほしい' },
  ]);
  assert.equal(seed, '鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです');
});

test('v21 search tool declares contextual transit evidence routing', () => {
  assert.equal(SEARCH_TOOL_V21_REVISION, 'evidence-only-web-tool-v21-context-transit');
  assert.match(worker, /collectWebEvidenceV21/);
  assert.match(worker, /deterministic-search-v21/);
  assert.match(worker, /transitQueriesRequireFreshSearch: true/);
  assert.match(worker, /stationAreaFollowupsUseConversationContext: true/);
});

test('model failure is hidden and retried without the old user-facing stop message', () => {
  assert.match(worker, /hiddenModelFailureRetry: true/);
  assert.match(worker, /streamBoundedQualityConversation/);
  assert.doesNotMatch(worker, /応答が途中で止まりました/);
  assert.doesNotMatch(worker, /もう一度だけ話してください/);
});

test('mobile client primes AudioContext synchronously from the call-button gesture', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V21, /function primeAudioContextFromGesture\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V21, /try \{ return new AudioCtor\(\{ sampleRate: 48000 \}\); \}/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V21, /try \{ return new AudioCtor\(\); \} catch \{ return null; \}/);
  assert.match(
    CLOUDFLARE_LIVE_CLIENT_V21,
    /async function startCall\(\)[\s\S]*primeAudioContextFromGesture\(\);[\s\S]*await ensureAudio\(\);/,
  );
});

test('call start proactively greets the caller before the first user turn', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V21, /function deliverProactiveGreeting\(\)/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V21, /お電話ありがとうございます。AIチャットサポートです。今日はどのようなご相談でしょうか？/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V21, /desiredCall && !proactiveGreetingDone/);
});
