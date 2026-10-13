import integratedEntry from './integrated-entry.js';
import {
  PHONE_MEMORY_REVISION,
  phoneMemoryEnabled,
  phoneMemoryStatus,
  runPhoneMemoryMaintenance,
} from './phone-memory-maintenance.js';

export const RUNTIME_ENTRY_REVISION = 'talksys-runtime-entry-phone-memory-v1-r1';

function compact(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function adminToken(env = {}) {
  return compact(env?.TELEPHONY_ADMIN_TOKEN || env?.TALKSYS_LOG_ADMIN_TOKEN || '', 500);
}

function authorized(request, env) {
  const expected = adminToken(env);
  if (!expected) return false;
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return supplied.length === expected.length && supplied === expected;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-runtime-entry-revision': RUNTIME_ENTRY_REVISION,
      'x-talksys-phone-memory-revision': PHONE_MEMORY_REVISION,
    },
  });
}

async function runScheduledMemory(env) {
  try {
    const result = await runPhoneMemoryMaintenance(env);
    console.log(JSON.stringify({
      type: 'phone_memory_maintenance',
      revision: PHONE_MEMORY_REVISION,
      ok: Boolean(result?.ok),
      enabled: Boolean(result?.enabled),
      processed: Number(result?.processed || 0),
      statuses: (result?.results || []).reduce((out, item) => {
        const key = compact(item?.status || 'unknown', 40);
        out[key] = Number(out[key] || 0) + 1;
        return out;
      }, {}),
    }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      type: 'phone_memory_maintenance_error',
      revision: PHONE_MEMORY_REVISION,
      error: compact(error?.message || error, 300),
    }));
    return { ok: false, error: compact(error?.message || error, 300) };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/internal/phone-memory-health' && request.method === 'GET') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      return json(await phoneMemoryStatus(env));
    }

    if (url.pathname === '/api/internal/phone-memory-maintenance' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      const result = await runPhoneMemoryMaintenance(env, { limit: 20 });
      return json(result, result?.ok === false ? 500 : 200);
    }

    return integratedEntry.fetch(request, env, ctx);
  },

  scheduled(controller, env, ctx) {
    const tasks = [];
    if (typeof integratedEntry?.scheduled === 'function') {
      tasks.push(Promise.resolve(integratedEntry.scheduled(controller, env, ctx)));
    }
    if (phoneMemoryEnabled(env)) tasks.push(runScheduledMemory(env));
    if (!tasks.length) return undefined;
    const combined = Promise.allSettled(tasks);
    if (ctx?.waitUntil) {
      ctx.waitUntil(combined);
      return undefined;
    }
    return combined;
  },
};
