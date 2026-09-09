import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLOUDFLARE_LIVE_CLIENT_V26 } from '../src/cloudflare-live-client-v26.js';
import { GrokJapaneseTTSV26, GROK_TTS_MODEL_V26 } from '../src/grok-japanese-tts-v26.js';
import { streamGlmConversationV25 } from '../src/glm-conversation-v25.js';
import { appendConversationTurn, recordConversationUser, getConversationHistory } from '../src/conversation-memory.js';
import { resolveGroundedQuestionV22 } from '../src/search-v22.js';
import { __test as searchV26Test } from '../src/search-v26.js';

const worker = fs.readFileSync(new URL('../src/worker-v26.js', import.meta.url), 'utf8');
const production = fs.readFileSync(new URL('../src/worker-v26-production.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

function fakeConnection() {
  return {
    id: 'test-v26',
    state: {},
    setState(next) { this.state = next; },
  };
}

test('in-flight user question is available to a follow-up without duplicate storage', () => {
  const connection = fakeConnection();
  recordConversationUser(connection, '鷺沼から相模大野までの乗換案内が知りたい');
  let history = getConversationHistory(connection);
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'user');

  appendConversationTurn(connection, '鷺沼から相模大野までの乗換案内が知りたい', '確認します。');
  history = getConversationHistory(connection);
  assert.equal(history.filter((m) => m.role === 'user').length, 1);
  assert.equal(history.filter((m) => m.role === 'assistant').length, 1);
});

test('どうですか resolves to the in-flight Saginuma to Sagami-Ono transit question', () => {
  const resolved = resolveGroundedQuestionV22('どうですか', [
    { role: 'user', content: '鷺沼から相模大野までの乗換案内が知りたい' },
  ]);
  assert.match(resolved, /鷺沼/);
  assert.match(resolved, /相模大野/);
  assert.match(resolved, /どうですか/);
});

test('direct transit fallback extracts arbitrary station pairs and useful server-rendered route text', () => {
  assert.deepEqual(searchV26Test.stationPair('博多駅から熊本駅までの乗換案内を教えて'), ['博多', '熊本']);
  assert.deepEqual(searchV26Test.stationPair('鷺沼から相模大野までの乗換案内が知りたい どうですか'), ['鷺沼', '相模大野']);
  const text = searchV26Test.stripHtml('<html><body><h1>鷺沼→相模大野</h1><div>ルート1 09:10発 09:45着 35分 乗換1回 424円</div></body></html>');
  const excerpt = searchV26Test.usefulRouteExcerpt(text, '鷺沼', '相模大野');
  assert.match(excerpt, /鷺沼→相模大野/);
  assert.match(excerpt, /35分/);
  assert.match(excerpt, /424円/);
});

test('GLM reasoning-only SSE cannot keep the visible answer waiting indefinitely', async () => {
  const encoder = new TextEncoder();
  const reasoningOnly = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"考え中"}}]}\n\n'));
      setTimeout(() => controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"まだ考え中"}}]}\n\n')), 20);
      setTimeout(() => controller.close(), 160);
    },
  });
  let calls = 0;
  const ai = {
    async run(_model, input) {
      calls += 1;
      if (input.stream) return reasoningOnly;
      return { choices: [{ message: { content: '田園都市線と小田急線を使う経路が候補です。' } }] };
    },
  };
  let answer = '';
  for await (const delta of streamGlmConversationV25(ai, [{ role: 'user', content: '経路は？' }], {
    firstTokenTimeoutMs: 80,
    streamTotalTimeoutMs: 150,
    fallbackTimeoutMs: 6000,
  })) answer += delta;
  assert.match(answer, /田園都市線/);
  assert.equal(calls, 2);
});

test('Grok TTS sends Japanese normalized speech and mp3 output request', async () => {
  let call = null;
  const ai = {
    async run(model, input) {
      call = { model, input };
      return { audio: 'SUQzBAAAAAA=' };
    },
  };
  const tts = new GrokJapaneseTTSV26(ai);
  const audio = await tts.synthesize('PCのSSDは256GBです。');
  assert.ok(audio instanceof ArrayBuffer);
  assert.equal(call.model, GROK_TTS_MODEL_V26);
  assert.equal(call.input.language, 'ja');
  assert.equal(call.input.voice_id, 'ara');
  assert.equal(call.input.output_format.codec, 'mp3');
  assert.match(call.input.text, /パソコン/);
  assert.match(call.input.text, /エスエスディー/);
});

test('Android runtime prefers AudioWorklet, probes PCM, and recovers lifecycle/network state', () => {
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /AudioWorklet is the standards-based real-time path/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /verifyAndroidCapturePipeline/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /talksys-mic-no-frames/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /android/i);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /visibilitychange/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /pageshow/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /window\.addEventListener\('online'/);
  assert.match(CLOUDFLARE_LIVE_CLIENT_V26, /socket\?\.close\(\)/);
});

test('v26 health contract exposes GLM bounded answer, Grok TTS, Android recovery, and direct transit fallback', () => {
  assert.match(worker, /cloudflare-agent-v26-grok-tts-android-realtime/);
  assert.match(worker, /ttsPrimary: GROK_TTS_MODEL_V26/);
  assert.match(worker, /glmVisibleFirstTokenDeadline: true/);
  assert.match(worker, /inFlightUserContext: true/);
  assert.match(worker, /directTransitEvidenceFallback: true/);
  assert.match(production, /search-smoke-v26-transit-followup/);
  assert.match(production, /collectGroundedEvidenceV26/);
  assert.match(production, /androidAudioWorkletPreferred: true/);
  assert.match(wrangler, /"main":\s*"src\/worker-v26-production\.js"/);
});
