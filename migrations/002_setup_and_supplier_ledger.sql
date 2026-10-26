-- Setup screens: retire locations/ranches/suppliers instead of deleting them (history keeps its links),
-- and a proper supplier ledger instead of two running totals.

ALTER TABLE storage_locations ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ranches           ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE suppliers ADD COLUMN contact_name TEXT;
ALTER TABLE suppliers ADD COLUMN phone        TEXT;
ALTER TABLE suppliers ADD COLUMN active       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE suppliers ADD COLUMN created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE supplier_entries (
  id          BIGSERIAL PRIMARY KEY,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  kind        TEXT NOT NULL CHECK (kind IN ('invoice','payment')),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  reference   TEXT,
  note        TEXT,
  entry_date  DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Lagos')::date,
  user_id     INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supplier_entries_supplier_idx ON supplier_entries (supplier_id, entry_date DESC);

-- Carry over any existing balances as an opening invoice + payment.
INSERT INTO supplier_entries (supplier_id, kind, amount, reference)
  SELECT id, 'invoice', total_ytd, 'Opening balance' FROM suppliers WHERE total_ytd > 0;
INSERT INTO supplier_entries (supplier_id, kind, amount, reference)
  SELECT id, 'payment', total_ytd - pending, 'Opening balance' FROM suppliers WHERE total_ytd - pending > 0;

ALTER TABLE suppliers DROP COLUMN total_ytd;
ALTER TABLE suppliers DROP COLUMN pending;

ALTER TABLE campaigns ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Content calendar: dated posts instead of a fixed Monday–Sunday grid.
DROP TABLE content_calendar;
CREATE TABLE content_posts (
  id         SERIAL PRIMARY KEY,
  post_date  DATE NOT NULL,
  title      TEXT NOT NULL,
  type       TEXT NOT NULL,
  platform   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Pending Approval','Approved','Scheduled','Published')),
  user_id    INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX content_posts_date_idx ON content_posts (post_date);

DELETE FROM settings WHERE key = 'social_stats';
-- Existing installs were already seeded; mark it so renamed/retired reference rows never come back.
INSERT INTO settings (key, value)
  SELECT 'reference_seeded', 'true'::jsonb WHERE EXISTS (SELECT 1 FROM storage_locations);
