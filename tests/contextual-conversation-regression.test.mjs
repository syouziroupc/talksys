import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { heuristicContextQuery, shouldDeepSearch, sanitizeFiller } from '../src/search-orchestrator.js';
import {
  beginCallSession,
  appendConversationTurn,
  endCallSession,
  getConversationHistory,
  normalizeCallerIdentity,
  setTrustedCallerIdentity,
  trustedCallerIdentity,
} from '../src/conversation-memory.js';

const worker = await readFile(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const client = await readFile(new URL('../src/cloudflare-live-client.js', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const bounded = await readFile(new URL('../src/bounded-conversation.js', import.meta.url), 'utf8');
const tts = await readFile(new URL('../src/cloudflare-japanese-tts.js', import.meta.url), 'utf8');

const history = [
  { role: 'user', content: '東京から前橋まで行かないとなんだけど、どうやって行こうか悩んでる' },
  { role: 'assistant', content: '新幹線か特急あずさが定番ですね。' },
  { role: 'user', content: 'あずさは前橋行かないよ' },
  { role: 'assistant', content: 'あずさは前橋には行かないんですか。' },
];

function fakeConnection(id = 'c1') {
  return {
    id,
    state: {},
    setState(next) { this.state = typeof next === 'function' ? next(this.state) : next; },
  };
}

test('generic research instruction resolves against recent user context, not the word 調べる', () => {
  const resolved = heuristicContextQuery('調べてごらん', history);
  assert.match(resolved, /東京/);
  assert.match(resolved, /前橋/);
  assert.match(resolved, /あずさ/);
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
  assert.match(orchestrator, /contextualCommand && \(!topic \|\| \/調べ/);
  assert.match(orchestrator, /検索内容(?:が)?不明/);
});

test('call session starts fresh, keeps context during the call, and is erased on call end', () => {
  const connection = fakeConnection();
  beginCallSession(connection);
  appendConversationTurn(connection, '東京から前橋まで行きたい', '経路を確認します。');
  appendConversationTurn(connection, 'あずさは違うよ', '訂正を踏まえます。');
  const during = getConversationHistory(connection);
  assert.equal(during.length, 4);
  assert.match(during[2].content, /あずさ/);
  const ended = endCallSession(connection);
  assert.equal(ended.activeCall, true);
  assert.deepEqual(getConversationHistory(connection), []);
});

test('persistent caller identity only activates after server-side trusted binding', () => {
  const connection = fakeConnection('phone-call');
  assert.equal(trustedCallerIdentity(connection), '');
  assert.equal(normalizeCallerIdentity('+81 90-1234-5678'), 'tel:+819012345678');
  setTrustedCallerIdentity(connection, '+81 90-1234-5678');
  assert.equal(trustedCallerIdentity(connection), 'tel:+819012345678');
  beginCallSession(connection, [{ role: 'user', content: '前回の相談' }]);
  assert.match(getConversationHistory(connection)[0].content, /前回/);
});

test('worker uses call lifecycle memory and disables shared built-in voice history', () => {
  assert.match(worker, /VOICE_REVISION = 'cloudflare-live-v18\.6'/);
  assert.match(worker, /historyLimit: 0/);
  assert.match(worker, /maxMessageCount: 0/);
  assert.match(worker, /onCallStart\(connection\)/);
  assert.match(worker, /beginCallSession\(connection, seed\)/);
  assert.match(worker, /onCallEnd\(connection\)/);
  assert.match(worker, /endCallSession\(connection\)/);
  assert.match(worker, /talksys_caller_memory/);
  assert.match(worker, /trustedCallerIdentityRequired: true/);
  assert.match(worker, /sessionMemoryTimeBasedExpiry: false/);
  assert.doesNotMatch(worker, /CONTEXT_TTL_MS/);
  assert.match(worker, /contextProvider: \(\) => this\.getTalkSysHistory\(connection\)/);
});

test('normal replies have hard startup bounds while complex non-search turns can use a quality route', () => {
  assert.match(worker, /streamBoundedLiveConversation/);
  assert.match(worker, /streamBoundedQualityConversation/);
  assert.match(worker, /openTimeoutMs: 1900/);
  assert.match(worker, /firstTokenTimeoutMs: 2300/);
  assert.match(bounded, /withTimeout\(request, timeoutMs \+ 120/);
  assert.match(bounded, /Workers AI first token/);
  assert.match(bounded, /QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL/);
});

test('reply audio is normalized and playback is tuned for speech intelligibility', () => {
  assert.match(tts, /Windows\\s\*11/);
  assert.match(tts, /Gbps/);
  assert.match(tts, /Mbps/);
  assert.match(client, /utterance\.rate = 0\.95/);
  assert.match(client, /highpass\.frequency\.value = 90/);
  assert.match(client, /presence\.frequency\.value = 2800/);
  assert.match(client, /presence\.gain\.value = 2\.0/);
  assert.match(client, /const delay = ttsFailedThisTurn \? 100 : 450/);
});
