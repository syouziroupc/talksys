import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

async function body(response) {
  return response.json();
}

test('GET /health reports phone consultation only with screen features disabled', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    ok: true,
    mode: 'phone-consultation-only',
    screenCapture: false,
    overlay: false,
  });
});

test('GET / renders phone-only realtime consultation UI', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/'));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /TalkSys/);
  assert.match(html, /電話相談モード/);
  assert.match(html, /リアルタイム通話/);
  assert.match(html, /検索は精度優先/);
  assert.doesNotMatch(html, /画面共有/);
  assert.doesNotMatch(html, /PNG保存/);
  assert.doesNotMatch(html, /overlay/);
  assert.doesNotMatch(html, /api\/locate/);
});

test('legacy chat and locate HTTP APIs are removed from phone-only app', async () => {
  const chat = await worker.fetch(new Request('https://talksys.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'こんにちは' }] }),
  }));
  assert.equal(chat.status, 404);

  const locate = await worker.fetch(new Request('https://talksys.test/api/locate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Google', image: 'data:image/jpeg;base64,AA==' }),
  }));
  assert.equal(locate.status, 404);
});

test('unknown route returns 404', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/missing'));
  assert.equal(response.status, 404);
});
