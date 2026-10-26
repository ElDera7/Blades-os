-- Backups & restore tests, payment reconciliation, purchase orders, HACCP checklists, scale capture.

-- 1. Backups -----------------------------------------------------------------------
CREATE TABLE backups (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('scheduled','manual')),
  status      TEXT NOT NULL DEFAULT 'Running' CHECK (status IN ('Running','Succeeded','Failed')),
  storage     TEXT NOT NULL,             -- 's3' (off-site) or 'download'
  location    TEXT,                      -- object key
  bytes       BIGINT,
  sha256      TEXT,
  tables      INT,
  rows        BIGINT,
  encrypted   BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT,
  user_id     INT REFERENCES users(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX backups_started_idx ON backups (started_at DESC);

CREATE TABLE restore_tests (
  id          SERIAL PRIMARY KEY,
  backup_id   INT REFERENCES backups(id),
  status      TEXT NOT NULL DEFAULT 'Running' CHECK (status IN ('Running','Passed','Failed')),
  tables      INT,
  rows        BIGINT,
  detail      JSONB,
  error       TEXT,
  user_id     INT REFERENCES users(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX restore_tests_started_idx ON restore_tests (started_at DESC);

-- 2. Payment reconciliation -------------------------------------------------------------
ALTER TABLE orders ADD COLUMN paid_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN payment_ref TEXT;     -- transfer sender / terminal slip number
UPDATE orders SET paid_at = created_at WHERE payment_status = 'Paid';
CREATE INDEX orders_paid_idx ON orders (paid_at) WHERE payment_status = 'Paid';

CREATE TABLE payment_reconciliations (
  id            SERIAL PRIMARY KEY,
  day           DATE NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('Transfer','POS Card')),
  expected      BIGINT NOT NULL,            -- BladeOS takings minus refunds, snapshot when recorded
  actual        BIGINT NOT NULL CHECK (actual >= 0),   -- per bank / card-terminal statement
  variance      BIGINT NOT NULL,
  statement_ref TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'Recorded' CHECK (status IN ('Recorded','Reviewed')),
  recorded_by   INT NOT NULL REFERENCES users(id),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   INT REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,
  UNIQUE (day, method)
);

-- 3. Purchase orders -------------------------------------------------------------------
CREATE SEQUENCE po_code_seq START 1001;
CREATE TABLE purchase_orders (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  supplier_id   INT NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL CHECK (status IN ('Pending Approval','Approved','Partly Received','Received','Closed','Rejected','Cancelled')),
  expected_on   DATE,
  note          TEXT,
  total         BIGINT NOT NULL CHECK (total >= 0),
  created_by    INT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  closed_at     TIMESTAMPTZ
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (status, created_at DESC);

CREATE TABLE purchase_order_lines (
  id           SERIAL PRIMARY KEY,
  po_id        INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_sku  TEXT REFERENCES products(sku),      -- NULL = non-stock line (e.g. live cattle, packaging service)
  description  TEXT NOT NULL,
  qty          NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit         TEXT NOT NULL,
  unit_cost    BIGINT NOT NULL CHECK (unit_cost >= 0),
  received_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0)
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (po_id);

CREATE TABLE po_receipts (
  id          SERIAL PRIMARY KEY,
  po_line_id  INT NOT NULL REFERENCES purchase_order_lines(id),
  qty         NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  location_id INT REFERENCES storage_locations(id),
  lot_id      INT REFERENCES stock_lots(id),
  note        TEXT,
  received_by INT NOT NULL REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX po_receipts_line_idx ON po_receipts (po_line_id);

ALTER TABLE supplier_entries ADD COLUMN purchase_order_id INT REFERENCES purchase_orders(id);

-- 4. HACCP checklists -------------------------------------------------------------------
CREATE TABLE haccp_checklists (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly')),
  items     TEXT[] NOT NULL CHECK (cardinality(items) BETWEEN 1 AND 40),
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort      INT NOT NULL DEFAULT 0
);
INSERT INTO haccp_checklists (name, frequency, sort, items) VALUES
 ('Opening checks', 'daily', 1, ARRAY[
   'Hand-wash stations stocked with soap and paper towels',
   'Staff in clean uniform, hair covered, no jewellery',
   'Nobody with vomiting, diarrhoea, fever or infected cuts is handling meat',
   'Knives, boards and saws washed and sanitised before use',
   'Display chiller clean and below 4°C',
   'Scale clean and reading zero']),
 ('Closing clean-down', 'daily', 2, ARRAY[
   'All surfaces, boards and knives washed and sanitised',
   'Mincer, bandsaw and slicer dismantled and cleaned',
   'Floors and drains cleaned',
   'Bones, trimmings and waste moved to the waste store',
   'Cold-room and freezer doors closed and sealed']),
 ('Pest control', 'weekly', 3, ARRAY[
   'No signs of rodents, droppings or gnawing',
   'Fly screens and insect killers working',
   'Bait stations checked',
   'Doors, windows and gaps sealed']),
 ('Equipment & calibration', 'weekly', 4, ARRAY[
   'Scale checked against a test weight',
   'Probe thermometer checked in iced water (0°C ± 1°C)',
   'Cold-room and freezer door seals intact',
   'First-aid kit stocked (blue plasters)']);

CREATE TABLE haccp_runs (
  id            SERIAL PRIMARY KEY,
  checklist_id  INT NOT NULL REFERENCES haccp_checklists(id),
  period_start  DATE NOT NULL,           -- the day (daily) or Monday (weekly)
  results       JSONB NOT NULL,          -- [{item, ok, action}]
  all_ok        BOOLEAN NOT NULL,
  note          TEXT,
  completed_by  INT NOT NULL REFERENCES users(id),
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by   INT REFERENCES users(id),
  verified_at   TIMESTAMPTZ,
  verify_note   TEXT,
  UNIQUE (checklist_id, period_start)
);
CREATE INDEX haccp_runs_period_idx ON haccp_runs (period_start DESC);

-- 5. Scale capture ------------------------------------------------------------------------
ALTER TABLE order_items ADD COLUMN scale_weighed BOOLEAN NOT NULL DEFAULT FALSE;

-- Limits for the new approvals (merged with existing values).
UPDATE settings SET value = '{"purchase": 500000, "paymentVariance": 5000}'::jsonb || value WHERE key = 'approval_limits';
