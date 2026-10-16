import { readV130Flag, v130AdminAuthorized } from './v130-control-plane.js';
import {
  applyPhoneMemoryCandidate,
  extractPhoneMemoryCandidate,
  publicPhoneMemoryCandidate,
} from './phone-memory-maintenance.js';

export const V130_MEMORY_JOBS_REVISION = 'talksys-v130-memory-jobs-r2';

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

function maxAttempts(env = {}) {
  return numberSetting(env, 'PHONE_MEMORY_JOB_MAX_ATTEMPTS', 4, 1, 20);
}

function retrySeconds(attempts = 1) {
  return Math.min(3600, 60 * (2 ** Math.max(0, Math.min(5, Number(attempts || 1) - 1))));
}

function dueDelaySeconds(dueAt = '') {
  const due = Date.parse(String(dueAt || '').replace(' ', 'T') + (String(dueAt || '').includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(due)) return 0;
  return Math.max(0, Math.ceil((due - Date.now()) / 1000));
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

async function finishJob(db, id, values = {}) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE phone_memory_jobs SET
    status=?,mode=?,from_message_id=?,to_message_id=?,profile_version=?,candidate_json=?,duration_ms=?,last_error=?,updated_at=?,completed_at=?
    WHERE id=?`).bind(
      clean(values.status, 40), clean(values.mode, 20), Number(values.fromMessageId || 0), Number(values.toMessageId || 0),
      Number(values.profileVersion || 0), clean(values.candidateJson, 30000), Number(values.durationMs || 0), clean(values.lastError, 1000),
      now, values.completed === false ? null : now, Number(id),
    ).run();
}

async function deferJob(db, id, mode, attempts, error = '') {
  const seconds = retrySeconds(attempts);
  await db.prepare(`UPDATE phone_memory_jobs SET status='pending',mode=?,due_at=datetime('now',?),last_error=?,updated_at=?,completed_at=NULL WHERE id=?`)
    .bind(mode, `+${seconds} seconds`, clean(error, 1000), new Date().toISOString(), Number(id)).run();
  return seconds;
}

async function claimJob(env, id, mode) {
  const db = env.TALKSYS_LOG_DB;
  const row = await db.prepare('SELECT * FROM phone_memory_jobs WHERE id=?').bind(Number(id)).first();
  if (!row) return { ok: false, status: 'job_not_found' };
  if (!['pending', 'queued'].includes(String(row.status || ''))) return { ok: false, status: 'not_claimable', job: row };
  const delay = dueDelaySeconds(row.due_at);
  if (delay > 0) return { ok: false, status: 'not_due', retryAfter: delay, job: row };
  const now = new Date().toISOString();
  const claimed = await db.prepare(`UPDATE phone_memory_jobs SET status='processing',mode=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND status IN ('pending','queued')`).bind(mode, now, Number(id)).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return { ok: false, status: 'claim_conflict' };
  return { ok: true, job: await db.prepare('SELECT * FROM phone_memory_jobs WHERE id=?').bind(Number(id)).first() };
}

export async function processV130MemoryJob(env = {}, id) {
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return { ok: false, status: 'storage_unavailable' };
  const mode = await readV130Flag(env, 'memory_jobs');
  if (!['shadow', 'active'].includes(mode)) return { ok: true, status: 'feature_disabled', mode };
  const claimed = await claimJob(env, id, mode);
  if (!claimed.ok) return claimed;
  const job = claimed.job;
  const started = Date.now();
  const metrics = await jobMetrics(env, job.phone_number);
  const trigger = evaluateV130MemoryTrigger(metrics, env);
  const auditBase = { trigger, metrics: { ...metrics, userTexts: undefined } };

  if (!trigger.eligible) {
    await finishJob(db, job.id, {
      status: 'skipped', mode, durationMs: Date.now() - started,
      candidateJson: JSON.stringify({ ...auditBase, reason: 'mechanical_threshold_not_met' }),
    });
    return { ok: true, status: 'skipped', jobId: job.id, phoneNumber: job.phone_number, trigger };
  }

  const candidate = await extractPhoneMemoryCandidate(env, job.phone_number);
  const publicCandidate = publicPhoneMemoryCandidate(candidate);
  const payload = { ...auditBase, candidate: publicCandidate };

  if (!candidate.ok && candidate.status === 'primary_error') {
    const attempts = Number(job.attempts || 1);
    if (attempts < maxAttempts(env)) {
      const retryAfter = await deferJob(db, job.id, mode, attempts, candidate.error || 'primary_error');
      return { ok: false, status: 'retry', jobId: job.id, retryAfter, error: candidate.error || 'primary_error' };
    }
    await finishJob(db, job.id, {
      status: 'failed', mode, fromMessageId: candidate.fromMessageId, toMessageId: candidate.toMessageId,
      durationMs: Date.now() - started, candidateJson: JSON.stringify(payload), lastError: candidate.error || 'primary_error',
    });
    return { ok: false, status: 'failed', jobId: job.id, error: candidate.error || 'primary_error' };
  }

  if (candidate.status !== 'candidate') {
    await finishJob(db, job.id, {
      status: 'skipped', mode, fromMessageId: candidate.fromMessageId, toMessageId: candidate.toMessageId,
      profileVersion: candidate.profileVersion, durationMs: Date.now() - started,
      candidateJson: JSON.stringify({ ...payload, reason: candidate.status || 'no_candidate' }),
      lastError: candidate.error || '',
    });
    return { ok: true, status: 'skipped', jobId: job.id, phoneNumber: job.phone_number, reason: candidate.status };
  }

  if (mode === 'shadow') {
    await finishJob(db, job.id, {
      status: 'shadow_complete', mode, fromMessageId: candidate.fromMessageId, toMessageId: candidate.toMessageId,
      profileVersion: candidate.profileVersion, durationMs: Date.now() - started, candidateJson: JSON.stringify(payload),
    });
    return { ok: true, status: 'shadow_complete', jobId: job.id, phoneNumber: job.phone_number, candidate: publicCandidate };
  }

  const applied = await applyPhoneMemoryCandidate(env, candidate);
  if (!applied.ok && applied.status === 'version_conflict') {
    const attempts = Number(job.attempts || 1);
    if (attempts < maxAttempts(env)) {
      const retryAfter = await deferJob(db, job.id, mode, attempts, 'version_conflict');
      return { ok: false, status: 'retry', jobId: job.id, retryAfter, error: 'version_conflict' };
    }
    await finishJob(db, job.id, {
      status: 'failed', mode, fromMessageId: candidate.fromMessageId, toMessageId: candidate.toMessageId,
      profileVersion: candidate.profileVersion, durationMs: Date.now() - started,
      candidateJson: JSON.stringify({ ...payload, apply: applied }), lastError: 'version_conflict',
    });
    return { ok: false, status: 'failed', jobId: job.id, error: 'version_conflict' };
  }

  await finishJob(db, job.id, {
    status: applied.ok ? 'completed' : 'failed', mode,
    fromMessageId: candidate.fromMessageId, toMessageId: candidate.toMessageId, profileVersion: candidate.profileVersion,
    durationMs: Date.now() - started, candidateJson: JSON.stringify({ ...payload, apply: applied }),
    lastError: applied.ok ? '' : clean(applied.status || 'apply_failed', 200),
  });
  return { ok: Boolean(applied.ok), status: applied.ok ? 'completed' : 'failed', jobId: job.id, phoneNumber: job.phone_number, apply: applied };
}

async function enqueueMissedJobs(env, mode, limit) {
  const db = env.TALKSYS_LOG_DB;
  const rows = await db.prepare(`SELECT c.from_number AS phone_number,MAX(c.call_id) AS trigger_call_id
    FROM phone_calls c JOIN phone_messages m ON m.call_id=c.call_id
    LEFT JOIN phone_memory_state s ON s.phone_number=c.from_number
    LEFT JOIN phone_user_trash u ON u.phone_number=c.from_number
    WHERE COALESCE(c.from_number,'')<>'' AND c.lifecycle_state='active' AND u.phone_number IS NULL
      AND m.id>COALESCE(s.last_processed_message_id,0)
      AND NOT EXISTS (SELECT 1 FROM phone_memory_jobs j WHERE j.phone_number=c.from_number AND j.status IN ('pending','queued','processing'))
    GROUP BY c.from_number ORDER BY MAX(m.id) ASC LIMIT ?`).bind(limit).all();
  const now = new Date().toISOString();
  for (const row of rows?.results || []) {
    await db.prepare(`INSERT OR IGNORE INTO phone_memory_jobs
      (phone_number,trigger_call_id,status,mode,due_at,created_at,updated_at)
      VALUES(?,?,'pending',?,CURRENT_TIMESTAMP,?,?)`).bind(row.phone_number, row.trigger_call_id || '', mode, now, now).run();
  }
  return (rows?.results || []).length;
}

export async function runV130MemoryJobRescue(env = {}, options = {}) {
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return { ok: false, status: 'storage_unavailable', processed: 0 };
  const mode = await readV130Flag(env, 'memory_jobs');
  if (!['shadow', 'active'].includes(mode)) return { ok: true, status: 'feature_disabled', mode, processed: 0 };
  const limit = Math.max(1, Math.min(50, Number(options?.limit || 12)));
  const rescued = await enqueueMissedJobs(env, mode, limit);
  await db.prepare(`UPDATE phone_memory_jobs SET status='pending',due_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,completed_at=NULL
    WHERE status='failed' AND attempts<? AND updated_at<=datetime('now','-15 minutes')`).bind(maxAttempts(env)).run();
  const rows = await db.prepare(`SELECT id FROM phone_memory_jobs
    WHERE status IN ('pending','queued') AND datetime(due_at)<=datetime('now') ORDER BY due_at ASC,id ASC LIMIT ?`).bind(limit).all();
  const results = [];
  for (const row of rows?.results || []) results.push(await processV130MemoryJob(env, row.id));
  return { ok: true, mode, rescued, processed: results.length, results };
}

export async function handleV130MemoryQueue(batch, env) {
  const mode = await readV130Flag(env, 'memory_jobs');
  if (!['shadow', 'active'].includes(mode)) return { ok: true, mode, processed: 0 };
  let processed = 0;
  for (const message of batch?.messages || []) {
    try {
      const body = message?.body && typeof message.body === 'object' ? message.body : {};
      let job = null;
      if (Number.isInteger(Number(body.jobId)) && Number(body.jobId) > 0) {
        job = await env.TALKSYS_LOG_DB.prepare('SELECT id,due_at FROM phone_memory_jobs WHERE id=?').bind(Number(body.jobId)).first();
      } else if (clean(body.callId, 200)) {
        const call = await env.TALKSYS_LOG_DB.prepare('SELECT from_number FROM phone_calls WHERE call_id=?').bind(clean(body.callId, 200)).first();
        if (call?.from_number) {
          job = await env.TALKSYS_LOG_DB.prepare(`SELECT id,due_at FROM phone_memory_jobs
            WHERE phone_number=? AND status IN ('pending','queued') ORDER BY id DESC LIMIT 1`).bind(call.from_number).first();
        }
      }
      if (!job) { message.ack(); continue; }
      const early = dueDelaySeconds(job.due_at);
      if (early > 0) { message.retry({ delaySeconds: Math.min(86400, Math.max(1, early)) }); continue; }
      const result = await processV130MemoryJob(env, job.id);
      processed += 1;
      if (result?.status === 'retry' || result?.status === 'not_due') {
        message.retry({ delaySeconds: Math.min(86400, Math.max(1, Number(result.retryAfter || 60))) });
      } else {
        message.ack();
      }
    } catch (error) {
      console.error('v130_memory_queue_error', clean(error?.message || error, 300));
      message.retry({ delaySeconds: 120 });
    }
  }
  return { ok: true, mode, processed };
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
