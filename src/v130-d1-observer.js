export const V130_D1_OBSERVER_REVISION = 'talksys-v130-d1-observer-r1';

const CALL_STATUS_SQL = 'UPDATE phone_calls SET status=?, updated_at=?, ended_at=COALESCE(?, ended_at) WHERE call_id=?';

function normalizeSql(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function wrapBoundStatement(statement, sql, args, env) {
  if (normalizeSql(sql) !== CALL_STATUS_SQL) return statement;
  return new Proxy(statement, {
    get(target, prop, receiver) {
      if (prop !== 'run') return Reflect.get(target, prop, receiver);
      return async (...runArgs) => {
        const result = await target.run(...runArgs);
        const status = String(args?.[0] ?? '').toLowerCase();
        const callId = String(args?.[3] ?? '').trim();
        if ((status === 'ended' || status === 'completed') && callId && env?.PHONE_MEMORY_QUEUE?.send) {
          try {
            await env.PHONE_MEMORY_QUEUE.send({ type: 'phone_call_ended', callId }, { delaySeconds: 300 });
          } catch (error) {
            console.error('v130_memory_queue_send_error', String(error?.message || error).slice(0, 300));
          }
        }
        return result;
      };
    },
  });
}

function wrapPreparedStatement(statement, sql, env) {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      if (prop !== 'bind') return Reflect.get(target, prop, receiver);
      return (...args) => wrapBoundStatement(target.bind(...args), sql, args, env);
    },
  });
}

function wrapD1(db, env) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql) => wrapPreparedStatement(target.prepare(sql), sql, env);
    },
  });
}

export function withV130MemoryQueueObserver(env = {}) {
  if (!env?.TALKSYS_LOG_DB || !env?.PHONE_MEMORY_QUEUE?.send) return env;
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === 'TALKSYS_LOG_DB') return wrapD1(target.TALKSYS_LOG_DB, target);
      return Reflect.get(target, prop, receiver);
    },
  });
}
