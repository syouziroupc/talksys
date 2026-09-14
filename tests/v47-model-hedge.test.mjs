import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as worker } from '../src/worker-v44.js';

test('slow primary model is hedged to the known fast fallback before the hard timeout', async () => {
  const calls = [];
  const env = {
    AI: {
      run(model) {
        calls.push(model);
        if (model === '@cf/zai-org/glm-5.3-flash') return new Promise(() => {});
        if (model === '@cf/zai-org/glm-4.7-flash') return Promise.resolve({ response: 'フォールバック成功' });
        throw new Error(`unexpected model ${model}`);
      },
    },
  };
  const started = Date.now();
  const result = await worker.runModel(env, [{ role: 'user', content: 'こんにちは' }], 32, 0.1, 220);
  assert.equal(result.text, 'フォールバック成功');
  assert.equal(result.model, '@cf/zai-org/glm-4.7-flash');
  assert.equal(result.fallbackUsed, true);
  assert.ok(calls.includes('@cf/zai-org/glm-5.3-flash'));
  assert.ok(calls.includes('@cf/zai-org/glm-4.7-flash'));
  assert.ok(Date.now() - started < 1000);
});

test('fast primary model wins without starting the fallback', async () => {
  const calls = [];
  const env = {
    AI: {
      run(model) {
        calls.push(model);
        return Promise.resolve({ response: 'primary success' });
      },
    },
  };
  const result = await worker.runModel(env, [{ role: 'user', content: 'test' }], 32, 0.1, 220);
  assert.equal(result.text, 'primary success');
  assert.equal(result.model, '@cf/zai-org/glm-5.3-flash');
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(calls, ['@cf/zai-org/glm-5.3-flash']);
});
