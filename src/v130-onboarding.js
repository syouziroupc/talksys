import { readV130Flag, v130AdminAuthorized } from './v130-control-plane.js';

export const V130_ONBOARDING_REVISION = 'talksys-v130-onboarding-r1';

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

export function v130OnboardingVersion(env = {}) {
  const value = Number(env?.PHONE_ONBOARDING_VERSION || 1);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 1000000) : 1;
}

async function ensureProfile(db, phone, now) {
  await db.prepare(`INSERT OR IGNORE INTO phone_profiles
    (phone_number,display_name,personalization_text,memory_text,enabled,version,created_at,updated_at)
    VALUES(?,?,?,?,1,1,?,?)`).bind(phone, '', '', '', now, now).run();
}

function nextStep(state = {}) {
  if (state.terms_status !== 'accepted') return 'terms';
  if (!['enabled', 'disabled'].includes(state.memory_status)) return 'memory';
  if (state.name_status !== 'saved') return 'name';
  return 'complete';
}

async function readState(db, phone) {
  return db.prepare(`SELECT phone_number,current_step,terms_status,memory_status,name_status,onboarding_version,
    started_at,updated_at,completed_at FROM phone_onboarding_state WHERE phone_number=?`).bind(phone).first();
}

async function profileSummary(db, phone) {
  return db.prepare(`SELECT phone_number,display_name,memory_enabled,onboarding_version,terms_accepted_at,
    onboarding_completed_at,version,lifecycle_state FROM phone_profiles WHERE phone_number=?`).bind(phone).first();
}

export async function shouldRunV130Onboarding(env, phoneNumber) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = normalizedPhone(phoneNumber);
  if (!db || !phone) return false;
  const mode = await readV130Flag(env, 'onboarding');
  if (mode === 'off') return false;
  if (await db.prepare('SELECT phone_number FROM phone_user_trash WHERE phone_number=?').bind(phone).first()) return false;
  if (mode === 'allowlist') {
    const allowed = await db.prepare('SELECT phone_number FROM phone_onboarding_allowlist WHERE phone_number=?').bind(phone).first();
    if (!allowed) return false;
  }
  const target = v130OnboardingVersion(env);
  const profile = await profileSummary(db, phone);
  return !(profile?.onboarding_completed_at && Number(profile?.onboarding_version || 0) >= target);
}

export async function beginV130Onboarding(env, phoneNumber) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = normalizedPhone(phoneNumber);
  if (!db || !phone) return { ok: false, error: !db ? 'storage_unavailable' : 'invalid_phone_number' };
  const now = new Date().toISOString();
  const target = v130OnboardingVersion(env);
  await ensureProfile(db, phone, now);
  const existing = await readState(db, phone);
  const profile = await profileSummary(db, phone);

  if (!existing) {
    await db.prepare(`INSERT INTO phone_onboarding_state
      (phone_number,current_step,terms_status,memory_status,name_status,onboarding_version,started_at,updated_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?,NULL)`).bind(
        phone, 'terms', 'pending', 'pending', profile?.display_name ? 'saved' : 'pending', target, now, now,
      ).run();
  } else if (Number(existing.onboarding_version || 0) < target) {
    await db.prepare(`UPDATE phone_onboarding_state SET
      current_step='terms',terms_status='pending',memory_status='pending',name_status=?,onboarding_version=?,
      started_at=?,updated_at=?,completed_at=NULL WHERE phone_number=?`).bind(
        profile?.display_name ? 'saved' : 'pending', target, now, now, phone,
      ).run();
  }
  return { ok: true, state: await readState(db, phone), profile: await profileSummary(db, phone) };
}

export async function saveV130Terms(env, phoneNumber, accepted) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = normalizedPhone(phoneNumber);
  if (!db || !phone) return { ok: false, error: !db ? 'storage_unavailable' : 'invalid_phone_number' };
  await beginV130Onboarding(env, phone);
  const now = new Date().toISOString();
  const target = v130OnboardingVersion(env);
  const termsStatus = accepted ? 'accepted' : 'rejected';
  const before = await readState(db, phone);
  const state = { ...before, terms_status: termsStatus };
  const step = nextStep(state);
  await db.batch([
    db.prepare(`UPDATE phone_onboarding_state SET terms_status=?,current_step=?,onboarding_version=?,updated_at=? WHERE phone_number=?`)
      .bind(termsStatus, step, target, now, phone),
    db.prepare(`UPDATE phone_profiles SET terms_accepted_at=?,onboarding_version=?,version=version+1,updated_at=? WHERE phone_number=?`)
      .bind(accepted ? now : null, target, now, phone),
  ]);
  return { ok: true, state: await readState(db, phone), profile: await profileSummary(db, phone) };
}

export async function saveV130MemoryPreference(env, phoneNumber, enabled) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = normalizedPhone(phoneNumber);
  if (!db || !phone) return { ok: false, error: !db ? 'storage_unavailable' : 'invalid_phone_number' };
  await beginV130Onboarding(env, phone);
  const now = new Date().toISOString();
  const before = await readState(db, phone);
  const memoryStatus = enabled ? 'enabled' : 'disabled';
  const state = { ...before, memory_status: memoryStatus };
  const step = nextStep(state);
  await db.batch([
    db.prepare('UPDATE phone_onboarding_state SET memory_status=?,current_step=?,updated_at=? WHERE phone_number=?')
      .bind(memoryStatus, step, now, phone),
    db.prepare('UPDATE phone_profiles SET memory_enabled=?,version=version+1,updated_at=? WHERE phone_number=?')
      .bind(enabled ? 1 : 0, now, phone),
  ]);
  return { ok: true, state: await readState(db, phone), profile: await profileSummary(db, phone) };
}

export async function saveV130DisplayName(env, phoneNumber, displayName) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = normalizedPhone(phoneNumber);
  const name = clean(displayName, 80);
  if (!db || !phone || !name) return { ok: false, error: !db ? 'storage_unavailable' : (!phone ? 'invalid_phone_number' : 'display_name_required') };
  await beginV130Onboarding(env, phone);
  const now = new Date().toISOString();
  const before = await readState(db, phone);
  const state = { ...before, name_status: 'saved' };
  const step = nextStep(state);
  await db.batch([
    db.prepare("UPDATE phone_onboarding_state SET name_status='saved',current_step=?,updated_at=? WHERE phone_number=?")
      .bind(step, now, phone),
    db.prepare('UPDATE phone_profiles SET display_name=?,version=version+1,updated_at=? WHERE phone_number=?')
      .bind(name, now, phone),
  ]);
  return { ok: true, state: await readState(db, phone), profile: await profileSummary(db, phone) };
}

export async function completeV130Onboarding(env, phoneNumber) {
  const db = env?.TALKSYS_LOG_DB;
  const phone = normalizedPhone(phoneNumber);
  if (!db || !phone) return { ok: false, error: !db ? 'storage_unavailable' : 'invalid_phone_number' };
  const state = await readState(db, phone);
  if (!state) return { ok: false, error: 'onboarding_not_started' };
  const step = nextStep(state);
  if (step !== 'complete') return { ok: false, error: 'onboarding_incomplete', next_step: step, state };
  const now = new Date().toISOString();
  const target = v130OnboardingVersion(env);
  await db.batch([
    db.prepare("UPDATE phone_onboarding_state SET current_step='complete',completed_at=?,updated_at=? WHERE phone_number=?")
      .bind(now, now, phone),
    db.prepare('UPDATE phone_profiles SET onboarding_completed_at=?,onboarding_version=?,version=version+1,updated_at=? WHERE phone_number=?')
      .bind(now, target, now, phone),
  ]);
  return { ok: true, state: await readState(db, phone), profile: await profileSummary(db, phone) };
}

async function adminState(request, env, phone) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return json({ ok: false, error: 'storage_unavailable' }, 503);
  return json({
    ok: true,
    revision: V130_ONBOARDING_REVISION,
    mode: await readV130Flag(env, 'onboarding'),
    targetVersion: v130OnboardingVersion(env),
    shouldRun: await shouldRunV130Onboarding(env, normalized),
    state: await readState(db, normalized),
    profile: await profileSummary(db, normalized),
    allowlisted: Boolean(await db.prepare('SELECT phone_number FROM phone_onboarding_allowlist WHERE phone_number=?').bind(normalized).first()),
  });
}

async function adminAllowlist(request, env, phone, enabled) {
  if (!v130AdminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const normalized = normalizedPhone(phone);
  if (!normalized) return json({ ok: false, error: 'invalid_phone_number' }, 400);
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return json({ ok: false, error: 'storage_unavailable' }, 503);
  if (enabled) {
    await db.prepare('INSERT OR IGNORE INTO phone_onboarding_allowlist(phone_number,created_at) VALUES(?,?)').bind(normalized, new Date().toISOString()).run();
  } else {
    await db.prepare('DELETE FROM phone_onboarding_allowlist WHERE phone_number=?').bind(normalized).run();
  }
  return adminState(request, env, normalized);
}

export function isV130OnboardingPath(pathname = '') {
  return /^\/phone\/api\/v130\/onboarding\/[^/]+$/.test(pathname)
    || /^\/phone\/api\/v130\/onboarding\/[^/]+\/allowlist$/.test(pathname);
}

export async function handleV130Onboarding(request, env) {
  const path = new URL(request.url).pathname;
  if (!isV130OnboardingPath(path)) return null;
  const allowlistMatch = path.match(/^\/phone\/api\/v130\/onboarding\/([^/]+)\/allowlist$/);
  if (allowlistMatch && request.method === 'PUT') return adminAllowlist(request, env, decodeURIComponent(allowlistMatch[1]), true);
  if (allowlistMatch && request.method === 'DELETE') return adminAllowlist(request, env, decodeURIComponent(allowlistMatch[1]), false);
  const stateMatch = path.match(/^\/phone\/api\/v130\/onboarding\/([^/]+)$/);
  if (stateMatch && request.method === 'GET') return adminState(request, env, decodeURIComponent(stateMatch[1]));
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
