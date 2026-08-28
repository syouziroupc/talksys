import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FinalizableNova3STT,
  FINAL_STT_MODEL,
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

test('binary start/end markers produce a Whisper large v3 turbo utterance', async () => {
  let seenModel = '';
  let seenInput;
  const ai = {
    async run(model, input) {
      seenModel = model;
      seenInput = input;
      return { text: '今日は何をしようか' };
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
  assert.equal(FINAL_STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(seenModel, FINAL_STT_MODEL);
  assert.equal(seenInput.language, 'ja');
  assert.equal(seenInput.task, 'transcribe');
  assert.equal(seenInput.vad_filter, true);
  assert.equal(seenInput.condition_on_previous_text, false);
  assert.equal(seenInput.beam_size, 5);
  assert.match(seenInput.initial_prompt, /TalkSys/);
  assert.equal(typeof seenInput.audio, 'string');
  assert.ok(seenInput.audio.length > 50);
  assert.equal(utterance, '今日は何をしようか');
});

test('commit marker with no captured speech does not invoke STT', async () => {
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
      return { text: 'サーバー側でも確定' };
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
      return { text: '再試行成功' };
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
