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

test('server VAD sends Deepgram Finalize after speech followed by silence', async () => {
  const ws = new FakeWebSocket();
  const ai = { async run() { return { webSocket: ws }; } };
  const stt = new FinalizableNova3STT(ai, { sampleRate: 16000, forceFinalizeSilenceMs: 650 });
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
