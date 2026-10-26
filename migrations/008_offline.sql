-- Offline selling: sales made at a till with no internet, uploaded later.
ALTER TABLE orders ADD COLUMN offline_no TEXT;               -- number printed on the offline receipt, e.g. T1-000123
ALTER TABLE orders ADD COLUMN synced_at  TIMESTAMPTZ;        -- when it reached the server (created_at = when it was sold)
ALTER TABLE orders ADD COLUMN synced_by  INT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN offline_flags TEXT;            -- what a manager should check (price changed, no open till, …)
CREATE INDEX orders_offline_idx ON orders (synced_at) WHERE offline_no IS NOT NULL;

-- The system showed less stock than was sold offline: sold anyway, flagged for a count.
ALTER TABLE order_items ADD COLUMN offline_short NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (offline_short >= 0);

-- Readings and checklists entered offline keep the time they were taken.
ALTER TABLE temperature_logs ADD COLUMN synced_at TIMESTAMPTZ;
ALTER TABLE haccp_runs ADD COLUMN synced_at TIMESTAMPTZ;
