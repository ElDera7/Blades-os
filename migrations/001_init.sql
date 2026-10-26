-- BladeOS initial schema
-- Money is stored in whole Naira (BIGINT). Quantities are NUMERIC(12,3).

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE storage_locations (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INT NOT NULL DEFAULT 0
);

CREATE TABLE ranches (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE SEQUENCE livestock_code_seq START 401;
CREATE TABLE livestock (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  tag              TEXT NOT NULL UNIQUE,
  species          TEXT NOT NULL CHECK (species IN ('Cattle','Goat','Sheep')),
  breed            TEXT NOT NULL,
  sex              TEXT NOT NULL CHECK (sex IN ('Male','Female')),
  age_years        NUMERIC(4,1) NOT NULL,
  weight_kg        NUMERIC(8,2) NOT NULL CHECK (weight_kg > 0),
  acquired_on      DATE NOT NULL,
  acquisition_cost BIGINT NOT NULL CHECK (acquisition_cost >= 0),
  ranch_id         INT NOT NULL REFERENCES ranches(id),
  pen              TEXT NOT NULL DEFAULT 'Pen 01',
  health           TEXT NOT NULL DEFAULT 'Healthy',
  vaccination      TEXT NOT NULL DEFAULT 'Pending',
  status           TEXT NOT NULL DEFAULT 'Active'
                   CHECK (status IN ('Active','Growing','Ready for Processing','Ready for Sale','Processed','Sold')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX livestock_status_idx ON livestock (status);

CREATE TABLE products (
  sku        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  unit       TEXT NOT NULL CHECK (unit IN ('KG','Unit','Pack')),
  price      BIGINT NOT NULL CHECK (price >= 0),
  cost_price BIGINT NOT NULL CHECK (cost_price >= 0),
  min_stock  NUMERIC(12,3) NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort       INT NOT NULL DEFAULT 0
);

CREATE TABLE stock (
  product_sku TEXT NOT NULL REFERENCES products(sku),
  location_id INT  NOT NULL REFERENCES storage_locations(id),
  qty         NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_batch  TEXT,
  PRIMARY KEY (product_sku, location_id)
);

CREATE TABLE stock_movements (
  id          BIGSERIAL PRIMARY KEY,
  product_sku TEXT NOT NULL REFERENCES products(sku),
  location_id INT  NOT NULL REFERENCES storage_locations(id),
  delta       NUMERIC(12,3) NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('production','sale','transfer_in','transfer_out','receipt','wastage','correction','return')),
  reference   TEXT,
  note        TEXT,
  user_id     INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_created_idx ON stock_movements (created_at DESC);
CREATE INDEX stock_movements_sku_idx ON stock_movements (product_sku, created_at);

CREATE SEQUENCE batch_code_seq START 81;
CREATE TABLE processing_batches (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  livestock_id INT  NOT NULL UNIQUE REFERENCES livestock(id),
  live_weight  NUMERIC(8,2)  NOT NULL,
  saleable_kg  NUMERIC(10,3) NOT NULL,
  yield_pct    NUMERIC(5,2)  NOT NULL,
  outputs      JSONB NOT NULL,
  location_id  INT NOT NULL REFERENCES storage_locations(id),
  user_id      INT REFERENCES users(id),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX processing_batches_at_idx ON processing_batches (processed_at DESC);

CREATE SEQUENCE customer_code_seq START 100;
CREATE TABLE customers (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  phone      TEXT,
  area       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE order_code_seq START 2380;
CREATE TABLE orders (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  customer_id    INT REFERENCES customers(id),
  channel        TEXT NOT NULL DEFAULT 'POS' CHECK (channel IN ('POS','Delivery','Online','Phone')),
  status         TEXT NOT NULL CHECK (status IN ('New','Confirmed','Processing','Out for Delivery','Delivered','Cancelled')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('Paid','Pending')),
  payment_method TEXT,
  total          BIGINT NOT NULL CHECK (total >= 0),
  area           TEXT,
  note           TEXT,
  user_id        INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_created_idx ON orders (created_at DESC);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INT  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_sku TEXT NOT NULL REFERENCES products(sku),
  qty         NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_price  BIGINT NOT NULL,
  subtotal    BIGINT NOT NULL,
  allocations JSONB NOT NULL DEFAULT '[]'  -- [{location_id, qty}] for restocking on cancel
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_sku_idx ON order_items (product_sku);

CREATE TABLE suppliers (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  type      TEXT NOT NULL,
  total_ytd BIGINT NOT NULL DEFAULT 0,
  pending   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE campaigns (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  budget   BIGINT NOT NULL DEFAULT 0,
  leads    INT NOT NULL DEFAULT 0,
  orders   INT NOT NULL DEFAULT 0,
  revenue  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE content_calendar (
  id       SERIAL PRIMARY KEY,
  sort     INT NOT NULL,
  day      TEXT NOT NULL,
  type     TEXT NOT NULL,
  platform TEXT NOT NULL,
  status   TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
