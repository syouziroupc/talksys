import test from 'node:test';
import assert from 'node:assert/strict';
import { prewarmPhoneGreetingAtWebhook, handleTelephonyRequest } from '../src/telephony/index.js';

test('disabled prewarm does not call TTS or schedule background work', async () => {
  const work = [];
  let synthesis = 0;
  const ctx = { waitUntil(p) { work.push(p); } };
  const deps = { synthesize() { synthesis++; return new Uint8Array(160).fill(0xff); } };
  const enabled = prewarmPhoneGreetingAtWebhook({ TELEPHONY_GREETING: 'unit-test-disabled-20261023' }, ctx, deps);
  assert.equal(enabled, false);
  assert.equal(synthesis, 0);
  assert.equal(work.length, 0);
});

test('prewarm is nonblocking and one in-flight TTS task is shared within an isolate', async () => {
  let synthesis = 0;
  let resolveSynthesis;
  const pending = new Promise(resolve => { resolveSynthesis = resolve; });
  const env = { TELEPHONY_GREETING_WEBHOOK_PREWARM: 'true', TELEPHONY_GREETING: 'unit-test-coalesce-20261023' };
  const works = [];
  const ctx = { waitUntil(p) { works.push(p); } };
  const deps = { synthesize() { synthesis++; return pending; } };
  assert.equal(prewarmPhoneGreetingAtWebhook(env, ctx, deps), true);
  assert.equal(prewarmPhoneGreetingAtWebhook(env, ctx, deps), true);
  assert.equal(synthesis, 1, 'same isolate, same greeting, only one TTS request');
  assert.equal(works.length, 2);
  resolveSynthesis(new Uint8Array(160).fill(0xff));
  await Promise.all(works);
});

test('prewarm failure is contained and does not reject the HTTP lifecycle', async () => {
  const works = [];
  const env = { TELEPHONY_GREETING_WEBHOOK_PREWARM: 'true', TELEPHONY_GREETING: 'unit-test-failure-20261023' };
  const ctx = { waitUntil(p) { works.push(p); } };
  assert.equal(prewarmPhoneGreetingAtWebhook(env, ctx, { synthesize: async () => { throw new Error('test unavailable'); } }), true);
  await Promise.all(works);
});

test('Telnyx voice webhook replies without awaiting background greeting synthesis', async () => {
  const never = new Promise(() => {});
  let calls = 0;
  const env = {
    TELEPHONY_ENABLED: 'true',
    TELEPHONY_SHARED_TOKEN: 'unit-secret',
    TELEPHONY_GREETING_WEBHOOK_PREWARM: 'true',
    TELEPHONY_GREETING: 'unit-test-texml-20261023',
    AI: { run() { calls++; return never; } },
  };
  const works = [];
  const ctx = { waitUntil(p) { works.push(p); } };
  const request = new Request('https://example.test/telnyx/voice?token=unit-secret&CallSid=unit-call-1');
  const response = await handleTelephonyRequest(request, env, ctx);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Stream/);
  assert.equal(calls, 1, 'background voice synthesis was started early');
  assert.equal(works.length, 2, 'call persistence and greeting synthesis were both queued');
});

test('unauthorized voice webhook does not prewarm or perform external TTS', async () => {
  let calls = 0;
  const ctx = { waitUntil() { throw Error('unauthorized callback'); } };
  const env = {
    TELEPHONY_ENABLED: 'true',
    TELEPHONY_SHARED_TOKEN: 'unit-secret',
    TELEPHONY_GREETING_WEBHOOK_PREWARM: 'true',
    AI: { run() { calls++; } },
  };
  const response = await handleTelephonyRequest(new Request('https://example.test/telnyx/voice?token=wrong'), env, ctx);
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('prewarm is disabled when lifecycle has no waitUntil', () => {
  let calls = 0;
  assert.equal(prewarmPhoneGreetingAtWebhook({ TELEPHONY_GREETING_WEBHOOK_PREWARM: 'true' }, {}, { synthesize() { calls++; } }), false);
  assert.equal(calls, 0);
});
