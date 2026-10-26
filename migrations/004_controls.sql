-- Internal controls: maker-checker approvals, refunds, multi-role accounts, uncosted livestock.

-- Accounts --------------------------------------------------------------------
-- Additional roles beyond the primary one (the primary role decides the home screen).
ALTER TABLE users ADD COLUMN extra_roles TEXT[] NOT NULL DEFAULT '{}';
-- Temporary passwords (set by an administrator, or from ADMIN_PASSWORD) must be changed at first sign-in.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
-- The bootstrap Owner's password came from an environment variable: make them choose their own.
UPDATE users SET must_change_password = TRUE WHERE role = 'Owner' AND last_login_at IS NULL;

-- Administrator is now a system role (accounts, setup, audit). It no longer holds commercial rights,
-- so nothing changes for existing Administrator accounts other than what they can see.

-- Livestock -------------------------------------------------------------------
-- Ranch staff can register animals without seeing or entering money; the purchase cost is
-- added by someone with cost access. NULL = not yet costed.
ALTER TABLE livestock ALTER COLUMN acquisition_cost DROP NOT NULL;

-- Stock adjustments (write-offs and count corrections) ---------------------------
CREATE SEQUENCE adjustment_code_seq START 1001;
CREATE TABLE stock_adjustments (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  product_sku   TEXT NOT NULL REFERENCES products(sku),
  location_id   INT  NOT NULL REFERENCES storage_locations(id),
  kind          TEXT NOT NULL CHECK (kind IN ('wastage','correction')),
  qty           NUMERIC(12,3) NOT NULL CHECK (qty <> 0),      -- wastage: positive amount lost; correction: signed
  reason        TEXT NOT NULL,
  note          TEXT,
  value_at_cost BIGINT NOT NULL DEFAULT 0,                     -- snapshot when requested, for approvers
  status        TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Cancelled')),
  requested_by  INT NOT NULL REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  CHECK (kind <> 'wastage' OR qty > 0),
  CHECK (status = 'Pending' OR decided_by IS NOT NULL)
);
CREATE INDEX stock_adjustments_status_idx ON stock_adjustments (status, requested_at DESC);

-- Refunds ---------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN refunded BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN net_total BIGINT GENERATED ALWAYS AS (total - refunded) STORED;
ALTER TABLE orders ADD CONSTRAINT orders_refund_le_total CHECK (refunded >= 0 AND refunded <= total);

ALTER TABLE order_items ADD COLUMN refunded_qty NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN refunded_amount BIGINT NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN net_qty NUMERIC(12,3) GENERATED ALWAYS AS (qty - refunded_qty) STORED;
ALTER TABLE order_items ADD COLUMN net_subtotal BIGINT GENERATED ALWAYS AS (subtotal - refunded_amount) STORED;
ALTER TABLE order_items ADD CONSTRAINT order_items_refund_le_qty CHECK (refunded_qty >= 0 AND refunded_qty <= qty);

CREATE SEQUENCE refund_code_seq START 1001;
CREATE TABLE refunds (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  order_id      INT NOT NULL REFERENCES orders(id),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL,
  restock       BOOLEAN NOT NULL DEFAULT FALSE,   -- only when the goods never left the counter
  method        TEXT NOT NULL CHECK (method IN ('Cash','Transfer','POS Card')),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Cancelled')),
  requested_by  INT NOT NULL REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT
);
CREATE INDEX refunds_status_idx ON refunds (status, requested_at DESC);
CREATE INDEX refunds_order_idx ON refunds (order_id);

CREATE TABLE refund_items (
  id            SERIAL PRIMARY KEY,
  refund_id     INT NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_item_id INT NOT NULL REFERENCES order_items(id),
  qty           NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  amount        BIGINT NOT NULL CHECK (amount >= 0)
);
CREATE INDEX refund_items_refund_idx ON refund_items (refund_id);
