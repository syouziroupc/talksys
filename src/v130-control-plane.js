export const V130_CONTROL_PLANE_REVISION = 'talksys-v130-control-plane-r1';

export const V130_FLAG_VALUES = Object.freeze({
  log_management: new Set(['off', 'on']),
  structured_profile: new Set(['off', 'on']),
  memory_jobs: new Set(['off', 'shadow', 'active']),
  onboarding: new Set(['off', 'allowlist', 'all']),
  trash_delete: new Set(['off', 'on']),
  hard_delete: new Set(['off', 'on']),
});

const PROFILE_RESPONSE_LENGTHS = new Set(['default', 'short', 'medium', 'long']);
const PROFILE_CONFIRMATION_LEVELS = new Set(['default', 'low', 'normal', 'high']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function adminToken(env) {
  return clean(env?.TELEPHONY_ADMIN_TOKEN || env?.TALKSYS_LOG_ADMIN_TOKEN || env?.TELEPHONY_SHARED_TOKEN || '', 500);
}

export function v130AdminAuthorized(request, env) {
  const expected = adminToken(env);
  if (!expected) return false;
  const supplied = clean((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), 500);
  return supplied.length === expected.length && supplied === expected;
}

function db(env) {
  return env?.TALKSYS_LOG_DB || null;
}

export async function readV130Flag(env, name) {
  const allowed = V130_FLAG_VALUES[name];
  if (!allowed || !db(env)) return 'off';
  try {
    const row = await db(env).prepare('SELECT value FROM talksys_feature_flags WHERE name=?').bind(name).first();
    const value = clean(row?.value, 40).toLowerCase();
    return allowed.has(value) ? value : 'off';
  } catch {
    return 'off';
  }
}

export async function readV130Flags(env) {
  const output = {};
  await Promise.all(Object.keys(V130_FLAG_VALUES).map(async (name) => {
    output[name] = await readV130Flag(env, name);
  }));
  return output;
}

async function updateFlag(request, env, name) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const allowed = V130_FLAG_VALUES[name];
  if (!allowed) return json({ ok: false, error: 'unknown_flag' }, 404);
  if (!db(env)) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const body = await request.json().catch(() => ({}));
  const value = clean(body?.value, 40).toLowerCase();
  if (!allowed.has(value)) return json({ ok: false, error: 'invalid_flag_value', allowed: [...allowed] }, 400);
  const expectedVersion = Number(body?.expectedVersion || 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return json({ ok: false, error: 'expected_version_required' }, 409);
  const now = new Date().toISOString();
  const result = await db(env).prepare(`UPDATE talksys_feature_flags
    SET value=?, version=version+1, updated_at=?
    WHERE name=? AND version=?`).bind(value, now, name, expectedVersion).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const current = await db(env).prepare('SELECT name, value, version, updated_at FROM talksys_feature_flags WHERE name=?').bind(name).first();
    return json({ ok: false, error: 'version_conflict', current }, 409);
  }
  const current = await db(env).prepare('SELECT name, value, version, updated_at FROM talksys_feature_flags WHERE name=?').bind(name).first();
  return json({ ok: true, flag: current });
}

async function flagInventory(request, env) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!db(env)) return json({ ok: false, error: 'storage_unavailable' }, 503);
  try {
    const rows = await db(env).prepare('SELECT name, value, version, updated_at FROM talksys_feature_flags ORDER BY name').all();
    const flags = {};
    for (const name of Object.keys(V130_FLAG_VALUES)) flags[name] = { value: 'off', version: 0, updated_at: '' };
    for (const row of rows?.results || []) {
      if (!V130_FLAG_VALUES[row.name]) continue;
      const value = V130_FLAG_VALUES[row.name].has(clean(row.value, 40)) ? clean(row.value, 40) : 'off';
      flags[row.name] = { value, version: Number(row.version || 0), updated_at: row.updated_at || '' };
    }
    return json({ ok: true, revision: V130_CONTROL_PLANE_REVISION, flags });
  } catch (error) {
    return json({ ok: false, error: 'flags_unavailable', flags: Object.fromEntries(Object.keys(V130_FLAG_VALUES).map((name) => [name, { value: 'off', version: 0 }])), detail: clean(error?.message || error, 240) }, 503);
  }
}

function normalizedPhone(value) {
  const phone = clean(value, 80);
  if (!phone || !/^\+?[0-9][0-9()\-\s]{5,79}$/.test(phone)) return '';
  return phone.replace(/[()\-\s]/g, '');
}

function profilePayload(row = {}) {
  return {
    phone_number: row.phone_number || '',
    display_name: row.display_name || '',
    personalization_text: row.personalization_text || '',
    memory_text: row.memory_text || '',
    enabled: Number(row.enabled ?? 1) === 1,
    version: Number(row.version || 0),
    lifecycle_state: row.lifecycle_state || 'active',
    speech_rate: Number(row.speech_rate ?? 1),
    response_length: row.response_length || 'default',
    step_by_step: Number(row.step_by_step || 0) === 1,
    confirmation_level: row.confirmation_level || 'default',
    memory_enabled: Number(row.memory_enabled ?? 1) === 1,
    onboarding_version: Number(row.onboarding_version || 0),
    terms_accepted_at: row.terms_accepted_at || null,
    onboarding_completed_at: row.onboarding_completed_at || null,
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

async function structuredProfile(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'structured_profile') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  if (!db(env)) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);

  if (request.method === 'GET') {
    const row = await db(env).prepare(`SELECT phone_number, display_name, personalization_text, memory_text, enabled, version,
      lifecycle_state, speech_rate, response_length, step_by_step, confirmation_level, memory_enabled,
      onboarding_version, terms_accepted_at, onboarding_completed_at, created_at, updated_at
      FROM phone_profiles WHERE phone_number=?`).bind(normalized).first();
    if (!row) return json({ ok: false, error: 'profile_not_found' }, 404);
    return json({ ok: true, profile: profilePayload(row) });
  }

  if (request.method !== 'PUT') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const body = await request.json().catch(() => ({}));
  const expectedVersion = Number(body?.expectedVersion || 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return json({ ok: false, error: 'expected_version_required' }, 409);

  const speechRate = Number(body?.speech_rate ?? 1);
  if (!Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2) return json({ ok: false, error: 'invalid_speech_rate' }, 400);
  const responseLength = clean(body?.response_length || 'default', 20).toLowerCase();
  if (!PROFILE_RESPONSE_LENGTHS.has(responseLength)) return json({ ok: false, error: 'invalid_response_length' }, 400);
  const confirmationLevel = clean(body?.confirmation_level || 'default', 20).toLowerCase();
  if (!PROFILE_CONFIRMATION_LEVELS.has(confirmationLevel)) return json({ ok: false, error: 'invalid_confirmation_level' }, 400);

  const now = new Date().toISOString();
  const result = await db(env).prepare(`UPDATE phone_profiles SET
      display_name=?, personalization_text=?, memory_text=?, enabled=?,
      speech_rate=?, response_length=?, step_by_step=?, confirmation_level=?, memory_enabled=?,
      version=version+1, updated_at=?
    WHERE phone_number=? AND version=? AND lifecycle_state='active'`).bind(
      clean(body?.display_name, 80), clean(body?.personalization_text, 4000), clean(body?.memory_text, 8000), body?.enabled === false ? 0 : 1,
      speechRate, responseLength, body?.step_by_step ? 1 : 0, confirmationLevel, body?.memory_enabled === false ? 0 : 1,
      now, normalized, expectedVersion,
    ).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const current = await db(env).prepare('SELECT phone_number, version, lifecycle_state, updated_at FROM phone_profiles WHERE phone_number=?').bind(normalized).first();
    return json({ ok: false, error: 'version_conflict', current }, 409);
  }
  const row = await db(env).prepare(`SELECT phone_number, display_name, personalization_text, memory_text, enabled, version,
      lifecycle_state, speech_rate, response_length, step_by_step, confirmation_level, memory_enabled,
      onboarding_version, terms_accepted_at, onboarding_completed_at, created_at, updated_at
      FROM phone_profiles WHERE phone_number=?`).bind(normalized).first();
  return json({ ok: true, profile: profilePayload(row) });
}

function callIsInProgress(status = '') {
  const value = clean(status, 40).toLowerCase();
  return !['ended', 'error', 'failed', 'completed', 'canceled', 'cancelled'].includes(value);
}

async function trashCall(request, env, callId) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'trash_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const id = clean(callId, 200);
  const row = await db(env)?.prepare('SELECT call_id, status, lifecycle_state FROM phone_calls WHERE call_id=?').bind(id).first();
  if (!row) return json({ ok: false, error: 'call_not_found' }, 404);
  if (callIsInProgress(row.status)) return json({ ok: false, error: 'call_in_progress' }, 409);
  const now = new Date().toISOString();
  await db(env).batch([
    db(env).prepare("UPDATE phone_calls SET lifecycle_state='trashed', trashed_at=?, updated_at=? WHERE call_id=? AND lifecycle_state='active'").bind(now, now, id),
    db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('call',?,'trash',1,?)").bind(id, now),
  ]);
  return json({ ok: true, call_id: id, lifecycle_state: 'trashed', trashed_at: now });
}

async function restoreCall(request, env, callId) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'trash_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const id = clean(callId, 200);
  const now = new Date().toISOString();
  const result = await db(env)?.prepare("UPDATE phone_calls SET lifecycle_state='active', trashed_at=NULL, updated_at=? WHERE call_id=? AND lifecycle_state='trashed'").bind(now, id).run();
  if (Number(result?.meta?.changes || 0) !== 1) return json({ ok: false, error: 'trashed_call_not_found' }, 404);
  await db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('call',?,'restore',1,?)").bind(id, now).run();
  return json({ ok: true, call_id: id, lifecycle_state: 'active' });
}

async function trashProfile(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'trash_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const now = new Date().toISOString();
  const result = await db(env)?.prepare("UPDATE phone_profiles SET lifecycle_state='trashed', trashed_at=?, updated_at=? WHERE phone_number=? AND lifecycle_state='active'").bind(now, now, normalized).run();
  if (Number(result?.meta?.changes || 0) !== 1) return json({ ok: false, error: 'profile_not_found' }, 404);
  await db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('profile',?,'trash',1,?)").bind(normalized, now).run();
  return json({ ok: true, phone_number: normalized, lifecycle_state: 'trashed' });
}

async function restoreProfile(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'trash_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const now = new Date().toISOString();
  const result = await db(env)?.prepare("UPDATE phone_profiles SET lifecycle_state='active', trashed_at=NULL, updated_at=? WHERE phone_number=? AND lifecycle_state='trashed'").bind(now, normalized).run();
  if (Number(result?.meta?.changes || 0) !== 1) return json({ ok: false, error: 'trashed_profile_not_found' }, 404);
  await db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('profile',?,'restore',1,?)").bind(normalized, now).run();
  return json({ ok: true, phone_number: normalized, lifecycle_state: 'active' });
}

async function trashUser(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'trash_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const body = await request.json().catch(() => ({}));
  if (clean(body?.confirmPhone, 80) !== normalized) return json({ ok: false, error: 'confirm_phone_required' }, 409);
  const active = await db(env)?.prepare(`SELECT call_id, status FROM phone_calls
    WHERE from_number=? AND lifecycle_state='active'`).bind(normalized).all();
  if ((active?.results || []).some((call) => callIsInProgress(call.status))) return json({ ok: false, error: 'call_in_progress' }, 409);
  const now = new Date().toISOString();
  const count = (active?.results || []).length;
  await db(env).batch([
    db(env).prepare("INSERT INTO phone_user_trash(phone_number,trashed_at,reason) VALUES(?,?,?) ON CONFLICT(phone_number) DO UPDATE SET trashed_at=excluded.trashed_at, reason=excluded.reason").bind(normalized, now, clean(body?.reason, 240)),
    db(env).prepare("UPDATE phone_calls SET lifecycle_state='trashed', trashed_at=?, updated_at=? WHERE from_number=? AND lifecycle_state='active'").bind(now, now, normalized),
    db(env).prepare("UPDATE phone_profiles SET lifecycle_state='trashed', trashed_at=?, updated_at=? WHERE phone_number=? AND lifecycle_state='active'").bind(now, now, normalized),
    db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('user',?,'trash',?,?)").bind(normalized, count, now),
  ]);
  return json({ ok: true, phone_number: normalized, lifecycle_state: 'trashed', call_count: count, trashed_at: now });
}

async function restoreUser(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'trash_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const tombstone = await db(env)?.prepare('SELECT phone_number FROM phone_user_trash WHERE phone_number=?').bind(normalized).first();
  if (!tombstone) return json({ ok: false, error: 'trashed_user_not_found' }, 404);
  const now = new Date().toISOString();
  await db(env).batch([
    db(env).prepare('DELETE FROM phone_user_trash WHERE phone_number=?').bind(normalized),
    db(env).prepare("UPDATE phone_calls SET lifecycle_state='active', trashed_at=NULL, updated_at=? WHERE from_number=? AND lifecycle_state='trashed'").bind(now, normalized),
    db(env).prepare("UPDATE phone_profiles SET lifecycle_state='active', trashed_at=NULL, updated_at=? WHERE phone_number=? AND lifecycle_state='trashed'").bind(now, normalized),
    db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('user',?,'restore',0,?)").bind(normalized, now),
  ]);
  return json({ ok: true, phone_number: normalized, lifecycle_state: 'active' });
}

async function purgeCall(request, env, callId) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'hard_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const id = clean(callId, 200);
  const row = await db(env)?.prepare("SELECT call_id FROM phone_calls WHERE call_id=? AND lifecycle_state='trashed'").bind(id).first();
  if (!row) return json({ ok: false, error: 'trashed_call_not_found' }, 404);
  const now = new Date().toISOString();
  await db(env).batch([
    db(env).prepare('DELETE FROM phone_latency_events WHERE call_id=?').bind(id),
    db(env).prepare('DELETE FROM phone_messages WHERE call_id=?').bind(id),
    db(env).prepare("DELETE FROM phone_calls WHERE call_id=? AND lifecycle_state='trashed'").bind(id),
    db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('call',?,'purge',1,?)").bind(id, now),
  ]);
  return json({ ok: true, purged: true, call_id: id });
}

async function purgeUser(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (await readV130Flag(env, 'hard_delete') !== 'on') return json({ ok: false, error: 'feature_disabled' }, 404);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const body = await request.json().catch(() => ({}));
  if (clean(body?.confirmPhone, 80) !== normalized || clean(body?.confirmPurge, 40) !== 'PURGE') {
    return json({ ok: false, error: 'double_confirmation_required' }, 409);
  }
  const tombstone = await db(env)?.prepare('SELECT phone_number FROM phone_user_trash WHERE phone_number=?').bind(normalized).first();
  if (!tombstone) return json({ ok: false, error: 'trashed_user_not_found' }, 404);
  const callRows = await db(env).prepare("SELECT call_id FROM phone_calls WHERE from_number=? AND lifecycle_state='trashed'").bind(normalized).all();
  const callIds = (callRows?.results || []).map((row) => row.call_id).filter(Boolean);
  const statements = [];
  for (const callId of callIds) {
    statements.push(db(env).prepare('DELETE FROM phone_latency_events WHERE call_id=?').bind(callId));
    statements.push(db(env).prepare('DELETE FROM phone_messages WHERE call_id=?').bind(callId));
  }
  statements.push(
    db(env).prepare("DELETE FROM phone_calls WHERE from_number=? AND lifecycle_state='trashed'").bind(normalized),
    db(env).prepare('DELETE FROM phone_profiles WHERE phone_number=?').bind(normalized),
    db(env).prepare('DELETE FROM phone_memory_state WHERE phone_number=?').bind(normalized),
    db(env).prepare('DELETE FROM phone_memory_audit WHERE phone_number=?').bind(normalized),
    db(env).prepare('DELETE FROM phone_memory_jobs WHERE phone_number=?').bind(normalized),
    db(env).prepare('DELETE FROM phone_onboarding_state WHERE phone_number=?').bind(normalized),
    db(env).prepare('DELETE FROM phone_onboarding_allowlist WHERE phone_number=?').bind(normalized),
    db(env).prepare('DELETE FROM phone_user_trash WHERE phone_number=?').bind(normalized),
    db(env).prepare("INSERT INTO phone_trash_audit(scope,target_key,action,affected_count,created_at) VALUES('user',?,'purge',?,?)").bind(normalized, callIds.length, new Date().toISOString()),
  );
  await db(env).batch(statements);
  return json({ ok: true, purged: true, phone_number: normalized, call_count: callIds.length });
}

export function isV130ControlPlanePath(pathname = '') {
  return pathname === '/phone/api/v130/flags'
    || /^\/phone\/api\/v130\/flags\/[^/]+$/.test(pathname)
    || /^\/phone\/api\/v130\/profiles\/[^/]+$/.test(pathname)
    || /^\/phone\/api\/v130\/trash\/calls\/[^/]+\/(?:trash|restore|purge)$/.test(pathname)
    || /^\/phone\/api\/v130\/trash\/profiles\/[^/]+\/(?:trash|restore)$/.test(pathname)
    || /^\/phone\/api\/v130\/trash\/users\/[^/]+\/(?:trash|restore|purge)$/.test(pathname);
}

export async function handleV130ControlPlane(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isV130ControlPlanePath(path)) return null;

  if (path === '/phone/api/v130/flags' && request.method === 'GET') return flagInventory(request, env);
  const flagMatch = path.match(/^\/phone\/api\/v130\/flags\/([^/]+)$/);
  if (flagMatch && request.method === 'PUT') return updateFlag(request, env, decodeURIComponent(flagMatch[1]));

  const profileMatch = path.match(/^\/phone\/api\/v130\/profiles\/([^/]+)$/);
  if (profileMatch) return structuredProfile(request, env, decodeURIComponent(profileMatch[1]));

  const callMatch = path.match(/^\/phone\/api\/v130\/trash\/calls\/([^/]+)\/(trash|restore|purge)$/);
  if (callMatch && request.method === 'POST') {
    const callId = decodeURIComponent(callMatch[1]);
    if (callMatch[2] === 'trash') return trashCall(request, env, callId);
    if (callMatch[2] === 'restore') return restoreCall(request, env, callId);
    return purgeCall(request, env, callId);
  }

  const profileTrashMatch = path.match(/^\/phone\/api\/v130\/trash\/profiles\/([^/]+)\/(trash|restore)$/);
  if (profileTrashMatch && request.method === 'POST') {
    const phone = decodeURIComponent(profileTrashMatch[1]);
    return profileTrashMatch[2] === 'trash' ? trashProfile(request, env, phone) : restoreProfile(request, env, phone);
  }

  const userMatch = path.match(/^\/phone\/api\/v130\/trash\/users\/([^/]+)\/(trash|restore|purge)$/);
  if (userMatch && request.method === 'POST') {
    const phone = decodeURIComponent(userMatch[1]);
    if (userMatch[2] === 'trash') return trashUser(request, env, phone);
    if (userMatch[2] === 'restore') return restoreUser(request, env, phone);
    return purgeUser(request, env, phone);
  }
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
