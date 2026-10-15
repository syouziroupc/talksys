from pathlib import Path

p=Path('src/telephony/index.js')
s=p.read_text()

s=s.replace("import { phoneMemoryStatusForNumber, PHONE_MEMORY_REVISION } from '../phone-memory-maintenance.js';\n", "")

start=s.index('async function profileMemoryStatus(request, env, phoneNumber) {')
end=s.index('\nasync function profileCalls(request, env, phoneNumber) {', start)
replacement=r'''async function profileMemoryStatus(request, env, phoneNumber) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const db = env?.TALKSYS_LOG_DB;
  if (!db) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const phone = profilePhone(phoneNumber);
  if (!phone) return json({ ok: false, error: 'phone_number_required' }, 400);
  const enabled = /^(?:1|true|yes|on)$/i.test(String(env?.PHONE_MEMORY_ENABLED ?? '').trim());
  const emptyState = { last_processed_message_id: 0, last_run_at: '', last_model: '', last_status: 'never', last_error: '', updated_at: '' };
  try {
    const state = await db.prepare(`SELECT last_processed_message_id, last_run_at, last_model, last_status, last_error, updated_at
      FROM phone_memory_state WHERE phone_number=?`).bind(phone).first();
    const audits = await db.prepare(`SELECT id, from_message_id, to_message_id, primary_model, primary_status,
      personalization_added, memory_added, name_added, shadow_model, shadow_status, created_at
      FROM phone_memory_audit WHERE phone_number=? ORDER BY id DESC LIMIT 10`).bind(phone).all();
    const lastProcessed = Number(state?.last_processed_message_id || 0);
    const pending = await db.prepare(`SELECT COUNT(*) AS pending_count, MAX(m.id) AS newest_message_id
      FROM phone_calls c JOIN phone_messages m ON m.call_id=c.call_id
      WHERE c.from_number=? AND m.id>?`).bind(phone, lastProcessed).first();
    return json({
      ok: true,
      initialized: true,
      revision: 'talksys-phone-memory-status-v129-r1',
      enabled,
      phone_number: phone,
      state: state || emptyState,
      pending_messages: Number(pending?.pending_count || 0),
      newest_message_id: Number(pending?.newest_message_id || 0),
      audits: audits?.results || [],
    });
  } catch (error) {
    const detail = clean(error?.message || error, 300);
    if (/no such table/i.test(detail)) {
      return json({ ok: true, initialized: false, revision: 'talksys-phone-memory-status-v129-r1', enabled, phone_number: phone, state: emptyState, pending_messages: 0, newest_message_id: 0, audits: [] });
    }
    return json({ ok: false, error: 'phone_memory_status_failed', detail, revision: 'talksys-phone-memory-status-v129-r1' }, 500);
  }
}
'''
s=s[:start]+replacement+s[end:]
p.write_text(s)
print('live telephony memory status isolated to read-only D1 queries')
