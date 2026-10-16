import { readV130Flag, v130AdminAuthorized } from './v130-control-plane.js';

export const V130_LOG_MANAGEMENT_REVISION = 'talksys-v130-log-management-r1';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function storage(env) {
  return env?.TALKSYS_LOG_DB || null;
}

function terminalStatus(status = '') {
  return ['ended', 'error', 'failed', 'completed', 'canceled', 'cancelled'].includes(clean(status, 40).toLowerCase());
}

async function featureReady(request, env, flag = 'log_management') {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!storage(env)) return json({ ok: false, error: 'storage_unavailable' }, 503);
  if (await readV130Flag(env, flag) !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  return null;
}

function isoFilter(value = '') {
  const text = clean(value, 40);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

async function listCalls(request, env) {
  const blocked = await featureReady(request, env);
  if (blocked) return blocked;
  const url = new URL(request.url);
  const q = clean(url.searchParams.get('q'), 120);
  const status = clean(url.searchParams.get('status'), 40);
  const lifecycle = clean(url.searchParams.get('lifecycle') || 'active', 20).toLowerCase();
  const from = isoFilter(url.searchParams.get('from'));
  const to = isoFilter(url.searchParams.get('to'));
  const requested = Number(url.searchParams.get('limit') || 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requested) ? Math.round(requested) : 100));
  if (!['active', 'trashed', 'all'].includes(lifecycle)) return json({ ok: false, error: 'invalid_lifecycle' }, 400);

  const where = [];
  const binds = [];
  if (lifecycle !== 'all') { where.push('c.lifecycle_state=?'); binds.push(lifecycle); }
  if (status) { where.push('c.status=?'); binds.push(status); }
  if (from) { where.push('c.started_at>=?'); binds.push(from); }
  if (to) { where.push('c.started_at<=?'); binds.push(to); }
  if (q) {
    where.push('(c.call_id LIKE ? OR c.from_number LIKE ? OR c.to_number LIKE ? OR COALESCE(p.display_name,\'\') LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    binds.push(like, like, like, like);
  }
  const sql = `SELECT c.call_id,c.from_number,c.to_number,c.status,c.started_at,c.updated_at,c.ended_at,
      c.last_user_text,c.last_assistant_text,c.message_count,c.lifecycle_state,c.trashed_at,
      COALESCE(p.display_name,'') AS profile_display_name,COALESCE(p.version,0) AS profile_version
    FROM phone_calls c LEFT JOIN phone_profiles p ON p.phone_number=c.from_number
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC LIMIT ?`;
  binds.push(limit);
  const rows = await storage(env).prepare(sql).bind(...binds).all();
  return json({ ok: true, revision: V130_LOG_MANAGEMENT_REVISION, calls: rows?.results || [] });
}

async function trashInventory(request, env) {
  const blocked = await featureReady(request, env);
  if (blocked) return blocked;
  const [calls, profiles, users] = await storage(env).batch([
    storage(env).prepare("SELECT call_id,from_number,status,updated_at,trashed_at FROM phone_calls WHERE lifecycle_state='trashed' ORDER BY trashed_at DESC LIMIT 500"),
    storage(env).prepare("SELECT phone_number,display_name,version,updated_at,trashed_at FROM phone_profiles WHERE lifecycle_state='trashed' ORDER BY trashed_at DESC LIMIT 500"),
    storage(env).prepare('SELECT phone_number,trashed_at,reason FROM phone_user_trash ORDER BY trashed_at DESC LIMIT 500'),
  ]);
  return json({ ok: true, calls: calls?.results || [], profiles: profiles?.results || [], users: users?.results || [] });
}

function uniqueIds(raw) {
  return [...new Set((Array.isArray(raw) ? raw : []).map((value) => clean(value, 200)).filter(Boolean))].slice(0, 500);
}

async function selectedCalls(request, env, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await storage(env).prepare(`SELECT call_id,status,lifecycle_state FROM phone_calls WHERE call_id IN (${placeholders})`).bind(...ids).all();
  return rows?.results || [];
}

async function trashCalls(request, env) {
  const blocked = await featureReady(request, env, 'trash_delete');
  if (blocked) return blocked;
  const body = await request.json().catch(() => ({}));
  const ids = uniqueIds(body?.callIds);
  if (!ids.length) return json({ ok: false, error: 'call_ids_required' }, 400);
  if (Number(body?.confirmCount) !== ids.length) return json({ ok: false, error: 'confirm_count_mismatch', count: ids.length }, 409);
  const rows = await selectedCalls(request, env, ids);
  if (rows.length !== ids.length) return json({ ok: false, error: 'call_not_found', requested: ids.length, found: rows.length }, 404);
  if (rows.some((row) => !terminalStatus(row.status))) return json({ ok: false, error: 'call_in_progress' }, 409);
  const now = new Date().toISOString();
  const statements = ids.map((id) => storage(env).prepare("UPDATE phone_calls SET lifecycle_state='trashed',trashed_at=?,updated_at=? WHERE call_id=? AND lifecycle_state='active'").bind(now, now, id));
  statements.push(storage(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('call_batch',?,'trash',?,?)").bind(ids.join(','), ids.length, now));
  await storage(env).batch(statements);
  return json({ ok: true, trashed: ids.length, call_ids: ids });
}

async function restoreCalls(request, env) {
  const blocked = await featureReady(request, env, 'trash_delete');
  if (blocked) return blocked;
  const body = await request.json().catch(() => ({}));
  const ids = uniqueIds(body?.callIds);
  if (!ids.length) return json({ ok: false, error: 'call_ids_required' }, 400);
  if (Number(body?.confirmCount) !== ids.length) return json({ ok: false, error: 'confirm_count_mismatch', count: ids.length }, 409);
  const now = new Date().toISOString();
  const statements = ids.map((id) => storage(env).prepare("UPDATE phone_calls SET lifecycle_state='active',trashed_at=NULL,updated_at=? WHERE call_id=? AND lifecycle_state='trashed'").bind(now, id));
  statements.push(storage(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('call_batch',?,'restore',?,?)").bind(ids.join(','), ids.length, now));
  await storage(env).batch(statements);
  return json({ ok: true, restored: ids.length, call_ids: ids });
}

async function trashPhoneLogs(request, env, phone) {
  const blocked = await featureReady(request, env, 'trash_delete');
  if (blocked) return blocked;
  const normalized = clean(phone, 80);
  if (!normalized) return json({ ok: false, error: 'phone_required' }, 400);
  const body = await request.json().catch(() => ({}));
  if (clean(body?.confirmPhone, 80) !== normalized) return json({ ok: false, error: 'confirm_phone_required' }, 409);
  const rows = await storage(env).prepare("SELECT call_id,status FROM phone_calls WHERE from_number=? AND lifecycle_state='active'").bind(normalized).all();
  const calls = rows?.results || [];
  if (calls.some((row) => !terminalStatus(row.status))) return json({ ok: false, error: 'call_in_progress' }, 409);
  if (body?.confirmCount != null && Number(body.confirmCount) !== calls.length) return json({ ok: false, error: 'confirm_count_mismatch', count: calls.length }, 409);
  const now = new Date().toISOString();
  await storage(env).batch([
    storage(env).prepare("UPDATE phone_calls SET lifecycle_state='trashed',trashed_at=?,updated_at=? WHERE from_number=? AND lifecycle_state='active'").bind(now, now, normalized),
    storage(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('phone_logs',?,'trash',?,?)").bind(normalized, calls.length, now),
  ]);
  return json({ ok: true, phone_number: normalized, trashed: calls.length });
}

async function trashPeriod(request, env) {
  const blocked = await featureReady(request, env, 'trash_delete');
  if (blocked) return blocked;
  const body = await request.json().catch(() => ({}));
  const from = isoFilter(body?.from);
  const to = isoFilter(body?.to);
  if (!from || !to || from > to) return json({ ok: false, error: 'valid_period_required' }, 400);
  const rows = await storage(env).prepare("SELECT call_id,status FROM phone_calls WHERE lifecycle_state='active' AND started_at>=? AND started_at<=?").bind(from, to).all();
  const calls = rows?.results || [];
  if (calls.some((row) => !terminalStatus(row.status))) return json({ ok: false, error: 'call_in_progress' }, 409);
  if (Number(body?.confirmCount) !== calls.length) return json({ ok: false, error: 'confirm_count_mismatch', count: calls.length }, 409);
  const now = new Date().toISOString();
  await storage(env).batch([
    storage(env).prepare("UPDATE phone_calls SET lifecycle_state='trashed',trashed_at=?,updated_at=? WHERE lifecycle_state='active' AND started_at>=? AND started_at<=?").bind(now, now, from, to),
    storage(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('period',?,'trash',?,?)").bind(`${from}..${to}`, calls.length, now),
  ]);
  return json({ ok: true, from, to, trashed: calls.length });
}

export function isV130LogManagementPath(pathname = '') {
  return pathname === '/phone/api/v130/calls'
    || pathname === '/phone/api/v130/trash'
    || pathname === '/phone/api/v130/calls/trash'
    || pathname === '/phone/api/v130/calls/restore'
    || pathname === '/phone/api/v130/calls/trash-period'
    || /^\/phone\/api\/v130\/users\/[^/]+\/logs\/trash$/.test(pathname);
}

export async function handleV130LogManagement(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isV130LogManagementPath(path)) return null;
  if (request.method === 'GET' && path === '/phone/api/v130/calls') return listCalls(request, env);
  if (request.method === 'GET' && path === '/phone/api/v130/trash') return trashInventory(request, env);
  if (request.method === 'POST' && path === '/phone/api/v130/calls/trash') return trashCalls(request, env);
  if (request.method === 'POST' && path === '/phone/api/v130/calls/restore') return restoreCalls(request, env);
  if (request.method === 'POST' && path === '/phone/api/v130/calls/trash-period') return trashPeriod(request, env);
  const phoneMatch = path.match(/^\/phone\/api\/v130\/users\/([^/]+)\/logs\/trash$/);
  if (request.method === 'POST' && phoneMatch) return trashPhoneLogs(request, env, decodeURIComponent(phoneMatch[1]));
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
