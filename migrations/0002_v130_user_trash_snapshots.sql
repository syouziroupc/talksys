-- Preserve only lifecycle states changed by a full-user trash operation.
-- This keeps earlier individual call/profile trash decisions intact on restore.
CREATE TABLE IF NOT EXISTS phone_user_trash_items (
  phone_number TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_key TEXT NOT NULL,
  prior_lifecycle_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (phone_number, scope, target_key)
);
CREATE INDEX IF NOT EXISTS idx_phone_user_trash_items_phone
  ON phone_user_trash_items(phone_number, scope);
