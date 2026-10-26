-- Product photos for the POS tiles, and items that aren't stock-counted (packaging services such as sealing).
ALTER TABLE products ADD COLUMN image TEXT;
ALTER TABLE products ADD COLUMN track_stock BOOLEAN NOT NULL DEFAULT TRUE;
