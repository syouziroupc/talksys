import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function envWith(runImpl) {
  return { AI: { run: runImpl } };
}

async function body(response) {
  return response.json();
}

test('GET /health reports ready features', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/health'), envWith(async () => ({})));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, screenCapture: true, overlay: true });
});

test('GET / renders chat and screen controls', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/'), envWith(async () => ({})));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /TalkSys/);
  assert.match(html, /画面共有/);
  assert.match(html, /音声で話す/);
  assert.match(html, /PNG保存/);
});

test('POST /api/chat forwards conversation to Workers AI', async () => {
  let seenModel;
  let seenInput;
  const env = envWith(async (model, input) => {
    seenModel = model;
    seenInput = input;
    return { response: 'テスト応答' };
  });
  const response = await worker.fetch(new Request('https://talksys.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'こんにちは' }] }),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { reply: 'テスト応答' });
  assert.equal(seenModel, '@cf/meta/llama-3.1-8b-instruct-fast');
  assert.equal(seenInput.messages.at(-1).content, 'こんにちは');
});

test('POST /api/chat rejects malformed history', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }] }),
  }), envWith(async () => ({ response: 'unused' })));
  assert.equal(response.status, 400);
});

test('POST /api/locate parses normalized coordinates', async () => {
  let seenModel;
  let seenInput;
  const env = envWith(async (model, input) => {
    seenModel = model;
    seenInput = input;
    return { response: '{"found":true,"x":812,"y":96,"label":"Google Chrome","note":"ここをクリック"}' };
  });
  const response = await worker.fetch(new Request('https://talksys.test/api/locate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'Googleを開きたい',
      image: 'data:image/jpeg;base64,AA==',
    }),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    found: true,
    x: 812,
    y: 96,
    label: 'Google Chrome',
    note: 'ここをクリック',
  });
  assert.equal(seenModel, '@cf/meta/llama-3.2-11b-vision-instruct');
  assert.equal(seenInput.image, 'data:image/jpeg;base64,AA==');
});

test('POST /api/locate rejects invalid images before AI invocation', async () => {
  let called = false;
  const response = await worker.fetch(new Request('https://talksys.test/api/locate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Google', image: 'not-an-image' }),
  }), envWith(async () => {
    called = true;
    return {};
  }));
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test('unknown route returns 404', async () => {
  const response = await worker.fetch(new Request('https://talksys.test/missing'), envWith(async () => ({})));
  assert.equal(response.status, 404);
});
