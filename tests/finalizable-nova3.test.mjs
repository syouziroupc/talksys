import test from 'node:test';
import assert from 'node:assert/strict';
import { FinalizableNova3STT } from '../src/finalizable-nova3.js';

class FakeWebSocket {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
  }
  accept() {}
  close() {}
  send(value) { this.sent.push(value); }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  emit(type, data) {
    for (const handler of this.listeners.get(type) || []) handler({ data });
  }
}

function pcmFrame(amplitude, samples = 800) {
  const data = new Int16Array(samples);
  const value = Math.max(-32767, Math.min(32767, Math.round(amplitude * 32767)));
  data.fill(value);
  return data.buffer;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('server VAD sends Deepgram Finalize after speech followed by silence', async () => {
  const ws = new FakeWebSocket();
  const ai = { async run() { return { webSocket: ws }; } };
  const stt = new FinalizableNova3STT(ai, {
    sampleRate: 16000,
    forceFinalizeSilenceMs: 650,
    explicitCommitGraceMs: 50,
  });
  const session = stt.createSession({});
  await session.waitUntilReady();

  session.feed(pcmFrame(0.08));
  session.feed(pcmFrame(0.08));
  for (let i = 0; i < 13; i++) session.feed(pcmFrame(0));

  assert.ok(ws.sent.some((item) => typeof item === 'string' && JSON.parse(item).type === 'Finalize'));
});

test('Finalize result is emitted as a complete utterance even without speech_final', async () => {
  const ws = new FakeWebSocket();
  const ai = { async run() { return { webSocket: ws }; } };
  let utterance = '';
  const stt = new FinalizableNova3STT(ai);
  const session = stt.createSession({ onUtterance: (text) => { utterance = text; } });
  await session.waitUntilReady();

  ws.emit('message', JSON.stringify({
    type: 'Results',
    is_final: true,
    speech_final: false,
    from_finalize: true,
    channel: { alternatives: [{ transcript: '発言の確定テストです' }] },
  }));

  assert.equal(utterance, '発言の確定テストです');
});

test('explicit forceFinalize commits latest interim even when Deepgram never returns from_finalize', async () => {
  const ws = new FakeWebSocket();
  const ai = { async run() { return { webSocket: ws }; } };
  let utterance = '';
  const stt = new FinalizableNova3STT(ai, {
    explicitCommitGraceMs: 20,
    explicitCommitMaxWaitMs: 80,
  });
  const session = stt.createSession({ onUtterance: (text) => { utterance = text; } });
  await session.waitUntilReady();

  ws.emit('message', JSON.stringify({
    type: 'Results',
    is_final: false,
    speech_final: false,
    from_finalize: false,
    channel: { alternatives: [{ transcript: '今日は何をしようか' }] },
  }));

  assert.equal(stt.forceFinalize('client_end'), true);
  assert.ok(ws.sent.some((item) => typeof item === 'string' && JSON.parse(item).type === 'Finalize'));
  await wait(35);
  assert.equal(utterance, '今日は何をしようか');
});

test('explicit forceFinalize commits an is_final result without waiting for speech_final', async () => {
  const ws = new FakeWebSocket();
  const ai = { async run() { return { webSocket: ws }; } };
  let utterance = '';
  const stt = new FinalizableNova3STT(ai, { explicitCommitGraceMs: 100 });
  const session = stt.createSession({ onUtterance: (text) => { utterance = text; } });
  await session.waitUntilReady();

  stt.forceFinalize('client_end');
  ws.emit('message', JSON.stringify({
    type: 'Results',
    is_final: true,
    speech_final: false,
    from_finalize: false,
    channel: { alternatives: [{ transcript: '確定します' }] },
  }));

  assert.equal(utterance, '確定します');
});
