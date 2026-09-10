import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPromise, __test as worker } from '../src/worker-v44.js';

test('boundedPromise rejects a hung model call instead of hanging the turn', async () => {
  const started = Date.now();
  await assert.rejects(boundedPromise(new Promise(() => {}), 20, 'model'), /model_timeout_20ms/);
  assert.ok(Date.now() - started < 1000);
});

test('unified router still keeps deterministic and stable knowledge local', () => {
  assert.equal(worker.classifyTurn('12345÷15', []).mode, 'deterministic');
  assert.equal(worker.classifyTurn('RAMとSSDの違いを短く説明して', []).mode, 'casual');
  assert.equal(worker.classifyTurn('別府市の今日の天気は？', []).mode, 'external');
});
