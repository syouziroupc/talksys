import { readV130Flag, v130AdminAuthorized } from './v130-control-plane.js';

export const V130_MEMORY_JOBS_REVISION = 'talksys-v130-memory-jobs-r1';

const EXPLICIT_MEMORY_PATTERN = /(?:覚えて|記憶して|次から|今後(?:は|も)?|これから(?:は|も)?|(?:と|って)呼んで|呼び名|ゆっくり(?:話して|しゃべって)|短く(?:答えて|話して)|簡潔に|一つずつ|ひとつずつ|順番に説明)/u;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function numberSetting(env, name, fallback, min, max) {
  const n = Number(env?.[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function v130MemoryThresholds(env = {}) {
  return Object.freeze({
    minUserUtterances: numberSetting(env, 'PHONE_MEMORY_JOB_MIN_USER_UTTERANCES', 6, 1, 100),
    minUserChars: numberSetting(env, 'PHONE_MEMORY_JOB_MIN_USER_CHARS', 240, 20, 10000),
    minCalls: numberSetting(env, 'PHONE_MEMORY_JOB_MIN_CALLS', 2, 1, 50),
    maxAgeHours: numberSetting(env, 'PHONE_MEMORY_JOB_MAX_AGE_HOURS', 24, 1, 720),
  });
}

export function evaluateV130MemoryTrigger(input = {}, env = {}) {
  const thresholds = v130MemoryThresholds(env);
  const utterances = Array.isArray(input.userTexts) ? input.userTexts.map((x) => clean(x, 4000)).filter(Boolean) : [];
  const userUtterances = Number.isFinite(Number(input.userUtterances)) ? Number(input.userUtterances) : utterances.length;
  const userChars = Number.isFinite(Number(input.userChars)) ? Number(input.userChars) : utterances.reduce((n, text) => n + text.length, 0);
  const calls = Math.max(0, Number(input.calls || 0));
  const ageHours = Math.max(0, Number(input.ageHours || 0));
  const explicit = utterances.some((text) => EXPLICIT_MEMORY_PATTERN.test(text));
  const reasons = [];
  if (explicit) reasons.push('explicit_expression');
  if (userUtterances >= thresholds.minUserUtterances) reasons.push('user_utterances');
  if (userChars >= thresholds.minUserChars) reasons.push('user_chars');
  if (calls >= thresholds.minCalls) reasons.push('call_count');
  if (userUtterances > 0 && ageHours >= thresholds.maxAgeHours) reasons.push('age');
  return Object.freeze({
    eligible: reasons.length > 0,
    reasons,
    metrics: { userUtterances, userChars, calls, ageHours, explicit },
    thresholds,
  });
}

async function jobMetrics(env, phoneNumber) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = clean(phoneNumber, 80);
  const state = await db.prepare('SELECT last_processed_message_id,last_run_at FROM phone_memory_state WHERE phone_number=?').bind(phone).first();
  const since = Number(state?.last_processed_message_id || 0);
  const messages = await db.prepare(`SELECT m.id,m.content
    FROM phone_calls c JOIN phone_messages m ON m.call_id=c.call_id
    WHERE c.from_number=? AND m.role='user' AND m.id>? AND c.lifecycle_state='active'
    ORDER BY m.id ASC LIMIT 500`).bind(phone, since).all();
  const texts = (messages?.results || []).map((row) => clean(row.content, 4000)).filter(Boolean);
  const calls = await db.prepare(`SELECT COUNT(*) AS n FROM phone_calls
    WHERE from_number=? AND lifecycle_state='active' AND status IN ('ended','completed')
      AND (?='' OR COALESCE(ended_at,updated_at)>?)`).bind(phone, clean(state?.last_run_at, 50), clean(state?.last_run_at, 50)).first();
  let ageHours = 0;
  if (state?.last_run_at) {
    const t = Date.parse(state.last_run_at);
    if (Number.isFinite(t)) ageHours = Math.max(0, (Date.now() - t) / 3600000);
  } else if (texts.length) {
    ageHours = 1e9;
  }
  return {
    lastProcessedMessageId: since,
    newestMessageId: Number(messages?.results?.at(-1)?.id || since),
    userTexts: texts,
    userUtterances: texts.length,
    userChars: texts.reduce((n, text) => n + text.length, 0),
    calls: Number(calls?.n || 0),
    ageHours,
  };
}

async function listJobs(request, env) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const phone = clean(url.searchParams.get('phone'), 80);
  const status = clean(url.searchParams.get('status'), 30).toLowerCase();
  const requested = Number(url.searchParams.get('limit') || 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requested) ? Math.round(requested) : 100));
  const where = [];
  const binds = [];
  if (phone) { where.push('j.phone_number=?'); binds.push(phone); }
  if (status) { where.push('j.status=?'); binds.push(status); }
  const result = await db.prepare(`SELECT j.*,COALESCE(p.display_name,'') AS display_name,
      COALESCE(p.memory_enabled,1) AS memory_enabled,COALESCE(p.lifecycle_state,'active') AS profile_lifecycle
    FROM phone_memory_jobs j LEFT JOIN phone_profiles p ON p.phone_number=j.phone_number
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY j.id DESC LIMIT ?`).bind(...binds, limit).all();
  return json({
    ok: true,
    revision: V130_MEMORY_JOBS_REVISION,
    mode: await readV130Flag(env, 'memory_jobs'),
    jobs: result?.results || [],
  });
}

async function inspectJob(request, env, id) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId < 1) return json({ ok: false, error: 'invalid_job_id' }, 400);
  const job = await db.prepare('SELECT * FROM phone_memory_jobs WHERE id=?').bind(jobId).first();
  if (!job) return json({ ok: false, error: 'job_not_found' }, 404);
  const tombstone = await db.prepare('SELECT phone_number FROM phone_user_trash WHERE phone_number=?').bind(job.phone_number).first();
  const profile = await db.prepare(`SELECT phone_number,display_name,enabled,version,lifecycle_state,memory_enabled,updated_at
    FROM phone_profiles WHERE phone_number=?`).bind(job.phone_number).first();
  const metrics = await jobMetrics(env, job.phone_number);
  const trigger = evaluateV130MemoryTrigger(metrics, env);
  let candidate = null;
  try { candidate = job.candidate_json ? JSON.parse(job.candidate_json) : null; } catch { candidate = { parse_error: true, raw: job.candidate_json }; }
  return json({
    ok: true,
    revision: V130_MEMORY_JOBS_REVISION,
    mode: await readV130Flag(env, 'memory_jobs'),
    job,
    profile: profile || null,
    userTrashed: Boolean(tombstone),
    metrics,
    trigger,
    candidate,
  });
}

export function isV130MemoryJobsPath(pathname = '') {
  return pathname === '/phone/api/v130/memory/jobs' || /^\/phone\/api\/v130\/memory\/jobs\/\d+$/.test(pathname);
}

export async function handleV130MemoryJobs(request, env) {
  const url = new URL(request.url);
  if (!isV130MemoryJobsPath(url.pathname)) return null;
  if (request.method === 'GET' && url.pathname === '/phone/api/v130/memory/jobs') return listJobs(request, env);
  const match = url.pathname.match(/^\/phone\/api\/v130\/memory\/jobs\/(\d+)$/);
  if (request.method === 'GET' && match) return inspectJob(request, env, match[1]);
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
