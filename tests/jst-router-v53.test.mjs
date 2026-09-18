import test from 'node:test';
import assert from 'node:assert/strict';
import app, { RESPONSE_QUALITY_REVISION, __test } from '../src/entry.js';

const { buildGeminiRequest, jstTemporalInstruction, localJstTemporalAnswer, namedForeignTimeRequest } = __test;
const FIXED = new Date('2026-09-17T10:15:20Z');

test('v53 injects an authoritative Asia/Tokyo clock into every Gemini generation request', () => {
  assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v54-evidence-first-r1');
  const instruction = jstTemporalInstruction(FIXED);
  assert.match(instruction, /2026-09-17T19:15:20\+09:00/);
  assert.match(instruction, /JST/);
  assert.match(instruction, /Asia\/Tokyo/);
  assert.match(instruction, /UTCやモデル内部時計を現在時刻として使わない/);
  const request = buildGeminiRequest({ messages: [{ role: 'user', content: '今は何時？' }] }, FIXED);
  const system = request.systemInstruction.parts[0].text;
  assert.match(system, /日本標準時JST/);
  assert.match(system, /2026-09-17T19:15:20\+09:00/);
  assert.match(system, /現在時刻より前の便を「次」と扱わず/);
});

test('trusted JST clock answers current time, date and relative time without model lookup', () => {
  const current = localJstTemporalAnswer('今何時？', FIXED);
  assert.equal(current.route, 'jst-clock-v53');
  assert.equal(current.timeZone, 'Asia/Tokyo');
  assert.equal(current.utcOffsetMinutes, 540);
  assert.match(current.answer, /19時15分/);
  const after = localJstTemporalAnswer('今から30分後は何時？', FIXED);
  assert.equal(after.relativeMinutes, 30);
  assert.match(after.answer, /19時45分/);
  const date = localJstTemporalAnswer('今日は何日？', FIXED);
  assert.equal(date.route, 'jst-calendar-v53');
  assert.equal(date.jstDate, '2026-09-17');
});

test('named foreign current-time requests are not forced to JST', () => {
  assert.equal(namedForeignTimeRequest('ニューヨークは今何時？'), true);
  assert.equal(localJstTemporalAnswer('ニューヨークは今何時？', FIXED), null);
  assert.equal(namedForeignTimeRequest('日本は今何時？'), false);
});

test('router-first entry keeps deterministic arithmetic out of native Gemini', async () => {
  const request = new Request('https://talksys.test/api/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '12345÷15', history: [] }),
  });
  const response = await app.fetch(request, { GEMINI_API_KEY: 'test', AI: { run: async () => { throw new Error('AI must not run'); } } }, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.route, 'deterministic-v45');
  assert.equal(body.search, false);
  assert.match(body.answer, /823/);
  assert.notEqual(body.route, 'gemini-native-interactions');
});

test('current-time route overrides stale assistant history with server JST', async () => {
  const request = new Request('https://talksys.test/api/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '今何時？', history: [{ role: 'assistant', content: '現在は10時37分です。' }] }),
  });
  const before = Date.now();
  const response = await app.fetch(request, { GEMINI_API_KEY: 'test', AI: { run: async () => { throw new Error('AI must not run'); } } }, {});
  const body = await response.json();
  const after = Date.now();
  assert.equal(body.route, 'jst-clock-v53');
  assert.equal(body.generationProvider, 'deterministic');
  assert.equal(body.timeZone, 'Asia/Tokyo');
  assert.ok(body.serverEpochMs >= before && body.serverEpochMs <= after);
  const shifted = new Date(body.serverEpochMs + 9 * 60 * 60 * 1000);
  const expected = `${shifted.getUTCHours()}時${String(shifted.getUTCMinutes()).padStart(2, '0')}分`;
  assert.match(body.answer, new RegExp(expected));
});

test('health contract advertises router-first JST and evidence-only dynamic facts', async () => {
  const response = await app.fetch(new Request('https://talksys.test/voice-health'), {
    GEMINI_API_KEY: 'test', AI: { run: async () => ({ response: 'unused' }) },
  }, {});
  const body = await response.json();
  assert.equal(body.routerFirst, true);
  assert.equal(body.defaultTimezone, 'Asia/Tokyo');
  assert.equal(body.authoritativeJstClock, true);
  assert.equal(body.dynamicFactsRequireEvidence, true);
  assert.equal(body.nativeGeminiAnswerPath, false);
  assert.equal(body.nativeGoogleSearch, false);
});
