-- POS to international standard: split tender, change due, discounts with manager override, VAT,
-- barcodes / PLU (incl. scale-printed weight labels), parked sales, idempotent sales, X/Z reports, receipt profile.

-- 1. Products: scanning and tax --------------------------------------------------------
ALTER TABLE products ADD COLUMN barcode  TEXT;                   -- EAN / UPC printed on packs
ALTER TABLE products ADD COLUMN plu      INT CHECK (plu BETWEEN 1 AND 99999);  -- price look-up code, also used on scale labels
ALTER TABLE products ADD COLUMN vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate >= 0 AND vat_rate <= 100);
CREATE UNIQUE INDEX products_barcode_uq ON products (barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX products_plu_uq ON products (plu) WHERE plu IS NOT NULL;
-- Give the starting catalogue PLUs in sort order so scale labels work out of the box.
UPDATE products p SET plu = x.n FROM (SELECT sku, (row_number() OVER (ORDER BY sort, sku))::int AS n FROM products) x
  WHERE x.sku = p.sku AND p.plu IS NULL;

-- 2. Orders: totals, discounts, tax, idempotency ------------------------------------------
ALTER TABLE orders ADD COLUMN gross_total     BIGINT;            -- before discounts
ALTER TABLE orders ADD COLUMN discount_total  BIGINT NOT NULL DEFAULT 0 CHECK (discount_total >= 0);
ALTER TABLE orders ADD COLUMN discount_reason TEXT;
ALTER TABLE orders ADD COLUMN discount_by     INT REFERENCES users(id);   -- who authorised it
ALTER TABLE orders ADD COLUMN tax_total       BIGINT NOT NULL DEFAULT 0;  -- VAT included in total
ALTER TABLE orders ADD COLUMN change_given    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN client_ref      TEXT;                       -- one sale per tap of "Complete", even on retry
CREATE UNIQUE INDEX orders_client_ref_uq ON orders (client_ref) WHERE client_ref IS NOT NULL;
UPDATE orders SET gross_total = total WHERE gross_total IS NULL;

ALTER TABLE order_items ADD COLUMN discount BIGINT NOT NULL DEFAULT 0 CHECK (discount >= 0);  -- subtotal is AFTER discount
ALTER TABLE order_items ADD COLUMN vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN tax      BIGINT NOT NULL DEFAULT 0;

-- 3. Payments: one row per tender (split payments) ------------------------------------------
CREATE TABLE order_payments (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('Cash','Transfer','POS Card')),
  amount          BIGINT NOT NULL CHECK (amount > 0),      -- applied to the order
  tendered        BIGINT,                                  -- cash handed over (amount + change)
  ref             TEXT,                                    -- transfer sender / terminal slip
  till_session_id INT REFERENCES till_sessions(id),        -- drawer / bag that took it
  user_id         INT REFERENCES users(id),
  paid_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_payments_order_idx ON order_payments (order_id);
CREATE INDEX order_payments_till_idx ON order_payments (till_session_id);
CREATE INDEX order_payments_paid_idx ON order_payments (paid_at);
INSERT INTO order_payments (order_id, method, amount, ref, till_session_id, user_id, paid_at)
  SELECT id, payment_method, total, payment_ref, COALESCE(cash_session_id, till_session_id), user_id, COALESCE(paid_at, created_at)
  FROM orders WHERE payment_status = 'Paid' AND total > 0 AND payment_method IN ('Cash','Transfer','POS Card');

-- 4. Parked (held) tickets ------------------------------------------------------------------
CREATE TABLE pos_held (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  customer_id INT REFERENCES customers(id),
  cart        JSONB NOT NULL,
  total       BIGINT NOT NULL DEFAULT 0,
  user_id     INT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Manager PIN for overrides at the till --------------------------------------------------
ALTER TABLE users ADD COLUMN pos_pin_hash       TEXT;
ALTER TABLE users ADD COLUMN pos_pin_fails      INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pos_pin_locked_until TIMESTAMPTZ;

-- 6. Loss prevention: tickets cleared before payment ----------------------------------------
ALTER TABLE till_sessions ADD COLUMN voided_tickets INT NOT NULL DEFAULT 0;
ALTER TABLE till_sessions ADD COLUMN voided_value   BIGINT NOT NULL DEFAULT 0;

-- 7. Settings: receipt header and discount limit --------------------------------------------
INSERT INTO settings (key, value) VALUES
  ('business_profile', '{"name": "Blades & Butchers", "tagline": "From Ranch to Retail", "address": "", "phone": "", "email": "", "tin": "", "receiptFooter": "Thank you for shopping with us!", "scaleLabel": "weight"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value = '{"discountPct": 10}'::jsonb || value WHERE key = 'approval_limits';
