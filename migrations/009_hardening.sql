-- Go-live hardening: revocable sessions, an append-only audit trail, and customer-data rights (NDPA 2023).

-- Sessions: each sign-in is a row, so signing out (or a password reset, deactivation or role change) ends it for real.
CREATE TABLE user_sessions (
  id          UUID PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- The audit trail can only grow: no edits, no deletions (a full restore uses TRUNCATE, which is separate).
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The audit trail is append-only' USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- Customers: marketing consent, and erasure that keeps the sale but drops the person.
ALTER TABLE customers
  ADD COLUMN marketing_ok BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN erased_at    TIMESTAMPTZ;
