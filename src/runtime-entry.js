import integratedEntry from './integrated-entry.js';
import {
  PHONE_MEMORY_REVISION,
  phoneMemoryEnabled,
  phoneMemoryStatus,
  runPhoneMemoryMaintenance,
} from './phone-memory-maintenance.js';
import { handleV130ControlPlane, isV130ControlPlanePath, readV130Flag } from './v130-control-plane.js';
import { handleV130LogManagement, isV130LogManagementPath } from './v130-log-management.js';
import {
  handleV130MemoryJobs,
  handleV130MemoryQueue,
  isV130MemoryJobsPath,
  runV130MemoryJobRescue,
} from './v130-memory-jobs.js';
import { handleV130Onboarding, isV130OnboardingPath } from './v130-onboarding.js';
import { handleV130UserTrash, isV130UserTrashPath } from './v130-user-trash.js';
import { withV130MemoryQueueObserver } from './v130-d1-observer.js';
import { v130AdminPage } from './v130-admin-page.js';

export const RUNTIME_ENTRY_REVISION = 'talksys-runtime-entry-v130-memory-jobs-r2';
export const PHONE_AI_BOUNDARY_AUDIT_REVISION = 'talksys-phone-ai-boundary-audit-v1-r1';

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

async function sha256Hex(value = '') {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function phoneAuditAuthorized(request, env) {
  const key = typeof env?.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  if (!key) return false;
  const expected = await sha256Hex(`${key}:talksys-phone-ai-boundary-audit-v1`);
  const supplied = compact(request.headers.get('x-talksys-diagnostic') || '', 200);
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

async function loadPhoneAuditProfile(env, phoneNumber = '') {
  const phone = compact(phoneNumber, 80);
  if (!phone || !env?.TALKSYS_LOG_DB) return null;
  const row = await env.TALKSYS_LOG_DB.prepare(
    'SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=?',
  ).bind(phone).first();
  if (!row) return null;
  const enabledValue = row?.enabled;
  const versionRaw = Number(row?.version || 0);
  return Object.freeze({
    displayName: compact(row?.display_name || '', 80),
    personalizationText: compact(row?.personalization_text || '', 4000),
    memoryText: compact(row?.memory_text || '', 8000),
    enabled: !(enabledValue === false || enabledValue === 0 || enabledValue === '0'),
    version: Number.isFinite(versionRaw) ? Math.max(0, Math.round(versionRaw)) : 0,
  });
}

function phoneAuditHistory(history = [], currentText = '') {
  const rows = Array.isArray(history) ? history : [];
  const current = compact(currentText, 1800);
  const last = rows.at(-1);
  const lastIsCurrent = last?.role === 'user' && compact(last?.content, 1800) === current;
  return (lastIsCurrent ? rows.slice(0, -1) : rows).slice(-16);
}

async function phoneAiBoundaryAudit(request, env, ctx) {
  if (!(await phoneAuditAuthorized(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);
  let body = {};
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const text = compact(body?.text, 1800);
  if (!text) return json({ ok: false, error: 'empty_text' }, 400);

  const phoneNumber = compact(body?.phoneNumber || body?.fromNumber || '', 80);
  const callerProfile = await loadPhoneAuditProfile(env, phoneNumber);
  const phoneProfile = callerProfile?.enabled ? callerProfile : null;
  const sessionId = compact(body?.sessionId || `qa-phone-${crypto.randomUUID()}`, 200);
  const utteranceId = compact(body?.utteranceId || `${sessionId}-turn`, 200);
  const spokenBackchannel = compact(body?.spokenBackchannel || '', 240);
  const history = phoneAuditHistory(body?.history, text);

  const target = new URL(request.url);
  target.pathname = '/api/turn';
  target.search = '';
  const turnRequest = new Request(target.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      history,
      channel: 'phone',
      sessionId,
      utteranceId,
      spokenBackchannel,
      ...(phoneProfile ? { phoneProfile } : {}),
    }),
    signal: request.signal,
  });

  const response = await integratedEntry.fetch(turnRequest, env, ctx);
  const type = response.headers.get('content-type') || '';
  if (!/application\/json/i.test(type)) {
    return json({ ok: false, error: 'phone_ai_boundary_non_json', status: response.status }, 502);
  }
  const payload = await response.json().catch(() => ({}));
  return json({
    ...payload,
    phoneAiBoundaryAudit: {
      revision: PHONE_AI_BOUNDARY_AUDIT_REVISION,
      inputBoundary: 'post-stt-pre-ai',
      outputBoundary: 'post-ai-pre-tts',
      channel: 'phone',
      phoneNumberProvided: Boolean(phoneNumber),
      profileLoaded: Boolean(callerProfile),
      profileEnabled: Boolean(phoneProfile),
      profileVersion: Number(callerProfile?.version || 0),
      historyItems: history.length,
      liveTelephonyPathChanged: false,
    },
  }, response.status);
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

async function runScheduledV130MemoryRescue(env) {
  try {
    const result = await runV130MemoryJobRescue(env, { limit: 12 });
    console.log(JSON.stringify({
      type: 'v130_memory_job_rescue',
      ok: Boolean(result?.ok),
      mode: result?.mode || '',
      rescued: Number(result?.rescued || 0),
      processed: Number(result?.processed || 0),
    }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ type: 'v130_memory_job_rescue_error', error: compact(error?.message || error, 300) }));
    return { ok: false, error: compact(error?.message || error, 300) };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The new page is invisible while the flag is OFF; V129 /phone remains the fallback.
    if (request.method === 'GET' && url.pathname === '/phone' && await readV130Flag(env, 'log_management') === 'on') {
      return new Response(v130AdminPage(request), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // The exact-state full-user trash handler must run before the older generic
    // control-plane route because both intentionally recognize the same URL shape.
    if (isV130UserTrashPath(url.pathname)) {
      return handleV130UserTrash(request, env);
    }

    // V130 management/control-plane routes are deliberately handled before the
    // integrated telephony path so V130 does not modify STT/VAD/TTS/PCMU/barge-in code.
    if (isV130ControlPlanePath(url.pathname)) {
      return handleV130ControlPlane(request, env);
    }
    if (isV130LogManagementPath(url.pathname)) {
      return handleV130LogManagement(request, env);
    }
    if (isV130MemoryJobsPath(url.pathname)) {
      return handleV130MemoryJobs(request, env);
    }
    if (isV130OnboardingPath(url.pathname)) {
      return handleV130Onboarding(request, env);
    }

    if (url.pathname === '/api/internal/phone-ai-boundary-audit' && request.method === 'POST') {
      return phoneAiBoundaryAudit(request, env, ctx);
    }

    if (url.pathname === '/api/internal/phone-memory-health' && request.method === 'GET') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      return json(await phoneMemoryStatus(env));
    }

    if (url.pathname === '/api/internal/phone-memory-maintenance' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      const result = await runPhoneMemoryMaintenance(env, { limit: 20 });
      return json(result, result?.ok === false ? 500 : 200);
    }

    // Only the media WebSocket path is observed, and only after V130 memory jobs
    // have been explicitly enabled. OFF means the original env reaches V129 unchanged.
    let delegatedEnv = env;
    if (url.pathname === '/telnyx/media') {
      const memoryMode = await readV130Flag(env, 'memory_jobs');
      if (memoryMode === 'shadow' || memoryMode === 'active') delegatedEnv = withV130MemoryQueueObserver(env);
    }
    return integratedEntry.fetch(request, delegatedEnv, ctx);
  },

  async scheduled(controller, env, ctx) {
    const tasks = [];
    if (typeof integratedEntry?.scheduled === 'function') {
      tasks.push(Promise.resolve(integratedEntry.scheduled(controller, env, ctx)));
    }
    const memoryMode = await readV130Flag(env, 'memory_jobs');
    if (memoryMode === 'off') {
      if (phoneMemoryEnabled(env)) tasks.push(runScheduledMemory(env));
    } else {
      tasks.push(runScheduledV130MemoryRescue(env));
    }
    if (!tasks.length) return undefined;
    const combined = Promise.allSettled(tasks);
    if (ctx?.waitUntil) {
      ctx.waitUntil(combined);
      return undefined;
    }
    return combined;
  },

  async queue(batch, env) {
    return handleV130MemoryQueue(batch, env);
  },
};
