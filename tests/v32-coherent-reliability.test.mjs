import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { completeGlmConversationV32, streamGlmConversationV32, GLM_CONVERSATION_MODEL_V32 } from '../src/glm-conversation-v32.js';

const worker = await readFile(new URL('../src/worker-v32.js', import.meta.url), 'utf8');
const glmConversation = await readFile(new URL('../src/glm-conversation-v32.js', import.meta.url), 'utf8');
const liveClient = await readFile(new URL('../src/cloudflare-live-client-v32.js', import.meta.url), 'utf8');
const traceClient = await readFile(new URL('../src/search-trace-client-v32.js', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v32 delivers one coherent completed GLM answer instead of raw token fragments', async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return { response: '用途を聞いたうえで、必要な性能を一緒に絞れば大丈夫です。まず今のパソコンで困っている点を教えてください。' };
    },
  };
  const chunks = [];
  for await (const chunk of streamGlmConversationV32(ai, [{ role: 'user', content: '買い替えを相談したい' }], { hedgeDelayMs: 5000 })) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /必要な性能/);
  assert.equal(calls[0].model, GLM_CONVERSATION_MODEL_V32);
  assert.equal(calls[0].input.stream, false);
});

test('v32 bounded hedge stays on the same GLM model when the primary path fails', async () => {
  let count = 0;
  const models = [];
  const ai = {
    async run(model) {
      models.push(model);
      count += 1;
      if (count === 1) throw new Error('transient primary failure');
      return { response: '予備経路で正常に返答しました。' };
    },
  };
  const answer = await completeGlmConversationV32(ai, [{ role: 'user', content: 'テスト' }], { hedgeDelayMs: 250, attemptTimeoutMs: 2600 });
  assert.equal(answer, '予備経路で正常に返答しました。');
  assert.deepEqual(models, [GLM_CONVERSATION_MODEL_V32, GLM_CONVERSATION_MODEL_V32]);
});

test('v32 removes the continuation-splice architecture that produced repeated fragments', () => {
  assert.doesNotMatch(worker, /retryMessages\(/);
  assert.doesNotMatch(worker, /同じ内容を繰り返さず、続きだけ/);
  assert.match(worker, /rawTokenStreamingToClient:\s*false/);
  assert.match(worker, /coherentReplyDelivery:\s*true/);
  assert.match(worker, /sameModelHedgedRecovery:\s*true/);
});

test('v32 uses natural conversational length rather than a hard one-to-three-sentence policy', () => {
  assert.doesNotMatch(worker, /通常は1〜3文/);
  assert.doesNotMatch(worker, /原則1〜3文/);
  assert.match(worker, /長さを機械的に1〜3文へ制限しません/);
  assert.match(worker, /電文調、単語だけの返答、ぶつ切りの短文/);
});

test('v32 processing view receives safe operational traces on every turn', () => {
  assert.match(worker, /type:\s*'turn_trace'/);
  assert.match(worker, /processingTraceAllTurns:\s*true/);
  assert.match(worker, /processingTraceShowsChainOfThought:\s*false/);
  assert.match(liveClient, /talksys-turn-trace/);
  assert.match(traceClient, /talksys-turn-trace/);
  assert.match(traceClient, /Web検索なし（会話応答）/);
  assert.match(traceClient, /MeloTTS音声を受信/);
});

test('v32 preserves GLM plus Melo and retains v31 as rollback', () => {
  assert.match(glmConversation, /@cf\/zai-org\/glm-5\.3-flash/);
  assert.equal(GLM_CONVERSATION_MODEL_V32, '@cf/zai-org/glm-5.3-flash');
  assert.match(worker, /@cf\/myshell-ai\/melotts/);
  assert.doesNotMatch(worker, /xai\/|grok/i);
  assert.match(wrangler, /worker-v31-production\.js/);
  assert.match(wrangler, /"main":\s*"src\/worker-v32-production\.js"/);
});

test('v32 does not force generic contextual PC advice through web search', () => {
  assert.match(worker, /GENERAL_ADVICE_RE/);
  assert.match(worker, /contextual-advice/);
  assert.match(worker, /contextualAdviceAvoidsUnnecessarySearch:\s*true/);
  assert.match(worker, /どこで買/);
});
