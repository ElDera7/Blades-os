-- Operational controls: batches & expiry, cold chain, stock counts, till cash-up, approval limits, two-step sign-in.

-- 1. Batches (lots) and expiry ---------------------------------------------------
-- Shelf life in days from processing/receipt to "use by". Editable per product.
ALTER TABLE products ADD COLUMN shelf_life_days INT NOT NULL DEFAULT 5 CHECK (shelf_life_days BETWEEN 1 AND 730);
UPDATE products SET shelf_life_days = CASE category
  WHEN 'Poultry' THEN 90 WHEN 'Processed' THEN 30 WHEN 'By-product' THEN 3 ELSE 5 END;

-- Every unit of stock belongs to a lot: a processing batch, a supplier delivery, or a correction.
-- stock.qty stays as the per-location total; stock_lots holds the breakdown (kept in step by server/stock.js).
CREATE TABLE stock_lots (
  id          SERIAL PRIMARY KEY,
  product_sku TEXT NOT NULL REFERENCES products(sku),
  location_id INT  NOT NULL REFERENCES storage_locations(id),
  lot_code    TEXT NOT NULL,
  expires_on  DATE NOT NULL,
  qty         NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stock_lots_key ON stock_lots (product_sku, location_id, lot_code, expires_on);
CREATE INDEX stock_lots_code_idx ON stock_lots (lot_code);
CREATE INDEX stock_lots_fefo_idx ON stock_lots (product_sku, location_id, expires_on) WHERE qty > 0;

-- Existing stock becomes one lot per location, dated from today.
INSERT INTO stock_lots (product_sku, location_id, lot_code, expires_on, qty)
  SELECT s.product_sku, s.location_id, COALESCE(s.last_batch, 'OPENING'),
         (now() AT TIME ZONE 'Africa/Lagos')::date + p.shelf_life_days, s.qty
  FROM stock s JOIN products p ON p.sku = s.product_sku WHERE s.qty > 0;

-- A write-off can name the exact lot it removes (otherwise oldest expiry first).
ALTER TABLE stock_adjustments ADD COLUMN lot_id INT REFERENCES stock_lots(id);

-- 2. Cold chain ---------------------------------------------------------------------
ALTER TABLE storage_locations ADD COLUMN temp_min NUMERIC(4,1);
ALTER TABLE storage_locations ADD COLUMN temp_max NUMERIC(4,1);
UPDATE storage_locations SET temp_min = -30, temp_max = -18 WHERE name ILIKE 'freezer%';
UPDATE storage_locations SET temp_min = 0,   temp_max = 4   WHERE name ILIKE 'cold room%' OR name ILIKE '%chiller%';
UPDATE storage_locations SET temp_min = 0,   temp_max = 10  WHERE name ILIKE 'processing%';

CREATE TABLE temperature_logs (
  id          BIGSERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES storage_locations(id),
  reading_c   NUMERIC(4,1) NOT NULL CHECK (reading_c BETWEEN -60 AND 60),
  in_range    BOOLEAN NOT NULL,
  note        TEXT,
  action      TEXT,          -- corrective action, required when out of range
  user_id     INT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX temperature_logs_loc_idx ON temperature_logs (location_id, recorded_at DESC);

-- 3. Blind stock counts --------------------------------------------------------------
CREATE SEQUENCE count_code_seq START 1001;
CREATE TABLE stock_counts (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  location_id  INT NOT NULL REFERENCES storage_locations(id),
  due_on       DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Submitted','Cancelled')),
  note         TEXT,
  created_by   INT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by INT REFERENCES users(id),
  submitted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX stock_counts_one_open ON stock_counts (location_id) WHERE status = 'Open';
CREATE TABLE stock_count_lines (
  id              SERIAL PRIMARY KEY,
  count_id        INT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_sku     TEXT NOT NULL REFERENCES products(sku),
  expected_qty    NUMERIC(12,3) NOT NULL,   -- snapshot at submission, never shown to the counter
  counted_qty     NUMERIC(12,3) NOT NULL CHECK (counted_qty >= 0),
  adjustment_code TEXT                      -- the correction request raised for a variance
);
CREATE INDEX stock_count_lines_count_idx ON stock_count_lines (count_id);

-- 4. Till cash-up -------------------------------------------------------------------
CREATE SEQUENCE till_code_seq START 1001;
CREATE TABLE till_sessions (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  user_id       INT NOT NULL REFERENCES users(id),
  opening_float BIGINT NOT NULL CHECK (opening_float >= 0),
  status        TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed','Reviewed')),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  counted_cash  BIGINT CHECK (counted_cash >= 0),
  expected_cash BIGINT,
  variance      BIGINT,
  close_note    TEXT,
  reviewed_by   INT REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT
);
CREATE UNIQUE INDEX till_sessions_one_open ON till_sessions (user_id) WHERE status = 'Open';
CREATE INDEX till_sessions_status_idx ON till_sessions (status, opened_at DESC);

ALTER TABLE orders ADD COLUMN till_session_id INT REFERENCES till_sessions(id);   -- session the sale was made in
ALTER TABLE orders ADD COLUMN cash_session_id INT REFERENCES till_sessions(id);   -- drawer that received the cash
ALTER TABLE refunds ADD COLUMN till_session_id INT REFERENCES till_sessions(id);  -- drawer that pays out a cash refund

-- 5. Approval limits ---------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
  ('approval_limits', '{"adjustment": 50000, "refund": 50000, "tillVariance": 5000}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 6. Two-step sign-in (TOTP, RFC 6238) ------------------------------------------------
ALTER TABLE users ADD COLUMN totp_secret     TEXT;            -- AES-256-GCM encrypted
ALTER TABLE users ADD COLUMN totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN totp_last_step  BIGINT;          -- blocks replay of a used code
ALTER TABLE users ADD COLUMN recovery_codes  TEXT[] NOT NULL DEFAULT '{}';  -- bcrypt hashes, single use
