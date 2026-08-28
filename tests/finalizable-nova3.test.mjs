import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FinalizableNova3STT,
  TURN_START_MARKER,
  TURN_COMMIT_MARKER,
} from '../src/finalizable-nova3.js';

function pcmFrame(amplitude, samples = 800) {
  const data = new Int16Array(samples);
  const value = Math.max(-32767, Math.min(32767, Math.round(amplitude * 32767)));
  data.fill(value);
  return data.buffer;
}

function markerBuffer(marker) {
  return marker.buffer.slice(marker.byteOffset, marker.byteOffset + marker.byteLength);
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('binary start/end markers produce a batch Nova-3 utterance', async () => {
  let seenModel = '';
  let seenInput;
  const ai = {
    async run(model, input) {
      seenModel = model;
      seenInput = input;
      return {
        results: {
          channels: [{ alternatives: [{ transcript: '今日は何をしようか' }] }],
        },
      };
    },
  };
  let utterance = '';
  let speechStarts = 0;
  const stt = new FinalizableNova3STT(ai, { minSpeechMs: 100 });
  const session = stt.createSession({
    onSpeechStart: () => { speechStarts += 1; },
    onUtterance: (text) => { utterance = text; },
  });

  session.feed(markerBuffer(TURN_START_MARKER));
  for (let i = 0; i < 8; i++) session.feed(pcmFrame(0.08));
  session.feed(markerBuffer(TURN_COMMIT_MARKER));
  await wait(20);

  assert.equal(speechStarts, 1);
  assert.equal(seenModel, '@cf/deepgram/nova-3');
  assert.equal(seenInput.language, 'ja');
  assert.equal(seenInput.audio.contentType, 'audio/wav');
  assert.ok(seenInput.audio.body instanceof ReadableStream);
  assert.equal(utterance, '今日は何をしようか');
});

test('commit marker with no captured speech does not invoke Nova-3', async () => {
  let calls = 0;
  const stt = new FinalizableNova3STT({ async run() { calls += 1; return {}; } });
  const session = stt.createSession({});
  session.feed(markerBuffer(TURN_COMMIT_MARKER));
  await wait(10);
  assert.equal(calls, 0);
});

test('server VAD remains as a fallback when explicit markers are unavailable', async () => {
  let utterance = '';
  let calls = 0;
  const ai = {
    async run() {
      calls += 1;
      return {
        results: {
          channels: [{ alternatives: [{ transcript: 'サーバー側でも確定' }] }],
        },
      };
    },
  };
  const stt = new FinalizableNova3STT(ai, {
    minSpeechMs: 100,
    serverSilenceFallbackMs: 300,
  });
  const session = stt.createSession({ onUtterance: (text) => { utterance = text; } });

  session.feed(pcmFrame(0.08));
  session.feed(pcmFrame(0.08));
  for (let i = 0; i < 8; i++) session.feed(pcmFrame(0));
  await wait(20);

  assert.equal(calls, 1);
  assert.equal(utterance, 'サーバー側でも確定');
});

test('batch STT retries once after a transient Workers AI failure', async () => {
  let calls = 0;
  let utterance = '';
  const ai = {
    async run() {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return {
        results: {
          channels: [{ alternatives: [{ transcript: '再試行成功' }] }],
        },
      };
    },
  };
  const stt = new FinalizableNova3STT(ai, { minSpeechMs: 100 });
  const session = stt.createSession({ onUtterance: (text) => { utterance = text; } });
  session.feed(markerBuffer(TURN_START_MARKER));
  for (let i = 0; i < 6; i++) session.feed(pcmFrame(0.06));
  session.feed(markerBuffer(TURN_COMMIT_MARKER));
  await wait(30);

  assert.equal(calls, 2);
  assert.equal(utterance, '再試行成功');
});
