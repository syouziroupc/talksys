-- TalkSys V130 expand-only schema.
-- Do not remove/rename existing V129 columns in this migration.

ALTER TABLE phone_calls ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE phone_calls ADD COLUMN trashed_at TEXT;

ALTER TABLE phone_profiles ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE phone_profiles ADD COLUMN trashed_at TEXT;
ALTER TABLE phone_profiles ADD COLUMN speech_rate REAL NOT NULL DEFAULT 1.0;
ALTER TABLE phone_profiles ADD COLUMN response_length TEXT NOT NULL DEFAULT 'default';
ALTER TABLE phone_profiles ADD COLUMN step_by_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE phone_profiles ADD COLUMN confirmation_level TEXT NOT NULL DEFAULT 'default';
ALTER TABLE phone_profiles ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE phone_profiles ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE phone_profiles ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE phone_profiles ADD COLUMN onboarding_completed_at TEXT;

CREATE TABLE IF NOT EXISTS talksys_feature_flags (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT 'off',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO talksys_feature_flags (name, value, version, updated_at) VALUES
  ('log_management', 'off', 1, CURRENT_TIMESTAMP),
  ('structured_profile', 'off', 1, CURRENT_TIMESTAMP),
  ('memory_jobs', 'off', 1, CURRENT_TIMESTAMP),
  ('onboarding', 'off', 1, CURRENT_TIMESTAMP),
  ('trash_delete', 'off', 1, CURRENT_TIMESTAMP),
  ('hard_delete', 'off', 1, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS phone_onboarding_state (
  phone_number TEXT PRIMARY KEY,
  current_step TEXT NOT NULL DEFAULT 'intro',
  terms_status TEXT NOT NULL DEFAULT 'pending',
  memory_status TEXT NOT NULL DEFAULT 'pending',
  name_status TEXT NOT NULL DEFAULT 'pending',
  onboarding_version INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS phone_onboarding_allowlist (
  phone_number TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_memory_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  trigger_call_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  mode TEXT NOT NULL DEFAULT 'shadow',
  due_at TEXT NOT NULL,
  from_message_id INTEGER NOT NULL DEFAULT 0,
  to_message_id INTEGER NOT NULL DEFAULT 0,
  profile_version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  candidate_json TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_memory_jobs_open_phone
  ON phone_memory_jobs(phone_number)
  WHERE status IN ('pending', 'queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_phone_memory_jobs_due
  ON phone_memory_jobs(status, due_at, id);
CREATE INDEX IF NOT EXISTS idx_phone_memory_jobs_phone
  ON phone_memory_jobs(phone_number, id DESC);

CREATE TABLE IF NOT EXISTS phone_memory_backfills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending',
  batch_size INTEGER NOT NULL DEFAULT 20,
  last_phone_number TEXT NOT NULL DEFAULT '',
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS phone_trash_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  target_key TEXT NOT NULL,
  action TEXT NOT NULL,
  affected_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phone_calls_lifecycle_updated
  ON phone_calls(lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_calls_from_lifecycle
  ON phone_calls(from_number, lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_profiles_lifecycle_updated
  ON phone_profiles(lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_onboarding_step
  ON phone_onboarding_state(current_step, updated_at DESC);
