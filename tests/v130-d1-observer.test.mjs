import test from 'node:test';
import assert from 'node:assert/strict';
import { withV130MemoryQueueObserver } from '../src/v130-d1-observer.js';

function fakeEnv({ queueFails = false } = {}) {
  const events = [];
  const ordinaryStatement = { marker: 'ordinary' };
  const db = {
    prepare(sql) {
      events.push(['prepare', sql]);
      if (!String(sql).includes('UPDATE phone_calls SET status=')) return ordinaryStatement;
      return {
        bind(...args) {
          events.push(['bind', ...args]);
          return {
            async run() {
              events.push(['run']);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const queue = {
    async send(body, options) {
      events.push(['send', body, options]);
      if (queueFails) throw new Error('fixture queue failure');
    },
  };
  return { env: { TALKSYS_LOG_DB: db, PHONE_MEMORY_QUEUE: queue }, events, ordinaryStatement };
}

test('observer returns original env when queue binding is absent', () => {
  const env = { TALKSYS_LOG_DB: { prepare() {} } };
  assert.equal(withV130MemoryQueueObserver(env), env);
});

test('ordinary D1 statements are returned completely untouched', () => {
  const { env, ordinaryStatement } = fakeEnv();
  const observed = withV130MemoryQueueObserver(env);
  assert.equal(observed.TALKSYS_LOG_DB.prepare('SELECT 1'), ordinaryStatement);
});

test('ended status write completes before delayed queue notification', async () => {
  const { env, events } = fakeEnv();
  const observed = withV130MemoryQueueObserver(env);
  const sql = 'UPDATE phone_calls SET status=?, updated_at=?, ended_at=COALESCE(?, ended_at) WHERE call_id=?';
  const result = await observed.TALKSYS_LOG_DB.prepare(sql).bind('ended', 'now', 'now', 'call-123').run();
  assert.equal(result.meta.changes, 1);
  assert.deepEqual(events.map((e) => e[0]), ['prepare', 'bind', 'run', 'send']);
  assert.deepEqual(events.at(-1), ['send', { type: 'phone_call_ended', callId: 'call-123' }, { delaySeconds: 300 }]);
});

test('non-terminal status never emits a queue message', async () => {
  const { env, events } = fakeEnv();
  const observed = withV130MemoryQueueObserver(env);
  const sql = 'UPDATE phone_calls SET status=?, updated_at=?, ended_at=COALESCE(?, ended_at) WHERE call_id=?';
  await observed.TALKSYS_LOG_DB.prepare(sql).bind('connected', 'now', null, 'call-123').run();
  assert.equal(events.some((e) => e[0] === 'send'), false);
});

test('queue failure never changes the successful D1 status-write result', async () => {
  const { env } = fakeEnv({ queueFails: true });
  const observed = withV130MemoryQueueObserver(env);
  const sql = 'UPDATE phone_calls SET status=?, updated_at=?, ended_at=COALESCE(?, ended_at) WHERE call_id=?';
  const result = await observed.TALKSYS_LOG_DB.prepare(sql).bind('ended', 'now', 'now', 'call-123').run();
  assert.equal(result.meta.changes, 1);
});
