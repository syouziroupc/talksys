import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { heuristicContextQuery, shouldDeepSearch, sanitizeFiller } from '../src/search-orchestrator.js';

const worker = await readFile(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const client = await readFile(new URL('../src/cloudflare-live-client.js', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');

const history = [
  { role: 'user', content: '東京から前橋まで行かないとなんだけど、どうやって行こうか悩んでる' },
  { role: 'assistant', content: '新幹線か特急あずさが定番ですね。' },
  { role: 'user', content: 'あずさは前橋行かないよ' },
  { role: 'assistant', content: 'あずさは前橋には行かないんですか。' },
];

test('generic research instruction resolves against recent user context, not the word 調べる', () => {
  const resolved = heuristicContextQuery('調べてごらん', history);
  assert.match(resolved, /東京/);
  assert.match(resolved, /前橋/);
  assert.match(resolved, /あずさ/);
  assert.match(resolved, /調べてごらん/);
  assert.equal(shouldDeepSearch('調べてごらん', history), true);
});

test('search planner explicitly forbids dictionary-meta search and prioritizes corrections', () => {
  assert.match(orchestrator, /「調べる」という語の辞書的意味を検索してはいけない/);
  assert.match(orchestrator, /ユーザーの訂正を最優先/);
  assert.match(orchestrator, /GENERIC_RESEARCH_COMMAND_RE/);
});

test('search filler rejects unknown-topic nonsense and has contextual bridge fallback', () => {
  assert.equal(sanitizeFiller('前の話を踏まえて確認しています。少し待ってください。'), '前の話を踏まえて確認しています。少し待ってください。');
  assert.match(orchestrator, /BAD_PROGRESS_TOPIC_RE/);
  assert.match(orchestrator, /検索内容(?:が)?不明/);
  assert.match(orchestrator, /Promise\.race\(\[/);
});

test('normal conversation keeps recent history and audio has a silent-failure fallback', () => {
  assert.match(worker, /\.\.\.history/);
  assert.match(worker, /rememberConversationTurn/);
  assert.match(client, /ttsFallbackTimer/);
  assert.match(client, /const delay = ttsFailedThisTurn \? 120 : 650/);
  assert.match(client, /speakJapaneseFallback\(value\)/);
});
