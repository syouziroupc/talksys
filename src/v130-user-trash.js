import { readV130Flag, v130AdminAuthorized } from './v130-control-plane.js';

export const V130_USER_TRASH_REVISION = 'talksys-v130-user-trash-r1';

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function normalizedPhone(value) {
  const phone = clean(value, 80);
  if (!phone || !/^\+?[0-9][0-9()\-\s]{5,79}$/.test(phone)) return '';
  return phone.replace(/[()\-\s]/g, '');
}

function inProgress(status = '') {
  return !['ended', 'error', 'failed', 'completed', 'canceled', 'cancelled'].includes(clean(status, 40).toLowerCase());
}

async function requireAdminFeature(request, env, flag) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env?.TALKSYS_LOG_DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  if (await readV130Flag(env, flag) !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  return null;
}

async function trashUser(request, env, phone) {
  const blocked = await requireAdminFeature(request, env, 'trash_delete');
  if (blocked) return blocked;
  const db = env.TALKSYS_LOG_DB;
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const body = await request.json().catch(() => ({}));
  if (clean(body?.confirmPhone, 80) !== normalized) return json({ ok: false, error: 'confirm_phone_required' }, 409);

  const calls = await db.prepare('SELECT call_id,status,lifecycle_state FROM phone_calls WHERE from_number=?').bind(normalized).all();
  if ((calls?.results || []).some((call) => inProgress(call.status))) return json({ ok: false, error: 'call_in_progress' }, 409);
  const existing = await db.prepare('SELECT phone_number,trashed_at FROM phone_user_trash WHERE phone_number=?').bind(normalized).first();
  if (existing) return json({ ok: true, phone_number: normalized, lifecycle_state: 'trashed', already_trashed: true, trashed_at: existing.trashed_at });

  const profile = await db.prepare('SELECT phone_number,lifecycle_state FROM phone_profiles WHERE phone_number=?').bind(normalized).first();
  const activeCalls = (calls?.results || []).filter((call) => (call.lifecycle_state || 'active') === 'active');
  const now = new Date().toISOString();
  const statements = [
    db.prepare('DELETE FROM phone_user_trash_items WHERE phone_number=?').bind(normalized),
  ];
  for (const call of activeCalls) {
    statements.push(db.prepare(`INSERT INTO phone_user_trash_items
      (phone_number,scope,target_key,prior_lifecycle_state,created_at) VALUES(?,?,?,?,?)`)
      .bind(normalized, 'call', call.call_id, call.lifecycle_state || 'active', now));
  }
  if (profile && (profile.lifecycle_state || 'active') === 'active') {
    statements.push(db.prepare(`INSERT INTO phone_user_trash_items
      (phone_number,scope,target_key,prior_lifecycle_state,created_at) VALUES(?,?,?,?,?)`)
      .bind(normalized, 'profile', normalized, profile.lifecycle_state || 'active', now));
  }
  statements.push(
    db.prepare(`INSERT INTO phone_user_trash(phone_number,trashed_at,reason) VALUES(?,?,?)
      ON CONFLICT(phone_number) DO UPDATE SET trashed_at=excluded.trashed_at,reason=excluded.reason`)
      .bind(normalized, now, clean(body?.reason, 240)),
    db.prepare("UPDATE phone_calls SET lifecycle_state='trashed',trashed_at=?,updated_at=? WHERE from_number=? AND lifecycle_state='active'")
      .bind(now, now, normalized),
    db.prepare("UPDATE phone_profiles SET lifecycle_state='trashed',trashed_at=?,updated_at=? WHERE phone_number=? AND lifecycle_state='active'")
      .bind(now, now, normalized),
    db.prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('user',?,'trash',?,?)")
      .bind(normalized, activeCalls.length, now),
  );
  await db.batch(statements);
  return json({ ok: true, revision: V130_USER_TRASH_REVISION, phone_number: normalized, lifecycle_state: 'trashed', call_count: activeCalls.length, trashed_at: now });
}

async function restoreUser(request, env, phone) {
  const blocked = await requireAdminFeature(request, env, 'trash_delete');
  if (blocked) return blocked;
  const db = env.TALKSYS_LOG_DB;
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const tombstone = await db.prepare('SELECT phone_number FROM phone_user_trash WHERE phone_number=?').bind(normalized).first();
  if (!tombstone) return json({ ok: false, error: 'trashed_user_not_found' }, 404);
  const snapshots = await db.prepare('SELECT scope,target_key,prior_lifecycle_state FROM phone_user_trash_items WHERE phone_number=?').bind(normalized).all();
  const now = new Date().toISOString();
  const statements = [];
  for (const item of snapshots?.results || []) {
    if (item.scope === 'call') {
      statements.push(db.prepare('UPDATE phone_calls SET lifecycle_state=?,trashed_at=NULL,updated_at=? WHERE call_id=?').bind(item.prior_lifecycle_state || 'active', now, item.target_key));
    } else if (item.scope === 'profile') {
      statements.push(db.prepare('UPDATE phone_profiles SET lifecycle_state=?,trashed_at=NULL,updated_at=? WHERE phone_number=?').bind(item.prior_lifecycle_state || 'active', now, normalized));
    }
  }
  statements.push(
    db.prepare('DELETE FROM phone_user_trash_items WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_user_trash WHERE phone_number=?').bind(normalized),
    db.prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('user',?,'restore',?,?)")
      .bind(normalized, (snapshots?.results || []).length, now),
  );
  await db.batch(statements);
  return json({ ok: true, revision: V130_USER_TRASH_REVISION, phone_number: normalized, lifecycle_state: 'active', restored_items: (snapshots?.results || []).length });
}

async function purgeUser(request, env, phone) {
  const blocked = await requireAdminFeature(request, env, 'hard_delete');
  if (blocked) return blocked;
  const db = env.TALKSYS_LOG_DB;
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const body = await request.json().catch(() => ({}));
  if (clean(body?.confirmPhone, 80) !== normalized || clean(body?.confirmPurge, 40) !== 'PURGE') {
    return json({ ok: false, error: 'double_confirmation_required' }, 409);
  }
  const tombstone = await db.prepare('SELECT phone_number FROM phone_user_trash WHERE phone_number=?').bind(normalized).first();
  if (!tombstone) return json({ ok: false, error: 'trashed_user_not_found' }, 404);
  const calls = await db.prepare('SELECT call_id,status FROM phone_calls WHERE from_number=?').bind(normalized).all();
  if ((calls?.results || []).some((call) => inProgress(call.status))) return json({ ok: false, error: 'call_in_progress' }, 409);
  const callIds = (calls?.results || []).map((row) => row.call_id).filter(Boolean);
  const statements = [];
  for (const callId of callIds) {
    statements.push(db.prepare('DELETE FROM phone_latency_events WHERE call_id=?').bind(callId));
    statements.push(db.prepare('DELETE FROM phone_messages WHERE call_id=?').bind(callId));
  }
  const now = new Date().toISOString();
  statements.push(
    db.prepare('DELETE FROM phone_calls WHERE from_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_profiles WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_memory_state WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_memory_audit WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_memory_jobs WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_onboarding_state WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_onboarding_allowlist WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_user_trash_items WHERE phone_number=?').bind(normalized),
    db.prepare('DELETE FROM phone_user_trash WHERE phone_number=?').bind(normalized),
    db.prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('user',?,'purge',?,?)")
      .bind(normalized, callIds.length, now),
  );
  await db.batch(statements);
  return json({ ok: true, revision: V130_USER_TRASH_REVISION, purged: true, phone_number: normalized, call_count: callIds.length });
}

export function isV130UserTrashPath(pathname = '') {
  return /^\/phone\/api\/v130\/trash\/users\/[^/]+\/(?:trash|restore|purge)$/.test(pathname);
}

export async function handleV130UserTrash(request, env) {
  const path = new URL(request.url).pathname;
  if (!isV130UserTrashPath(path)) return null;
  const match = path.match(/^\/phone\/api\/v130\/trash\/users\/([^/]+)\/(trash|restore|purge)$/);
  if (!match || request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const phone = decodeURIComponent(match[1]);
  if (match[2] === 'trash') return trashUser(request, env, phone);
  if (match[2] === 'restore') return restoreUser(request, env, phone);
  return purgeUser(request, env, phone);
}
