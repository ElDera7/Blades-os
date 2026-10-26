-- Which storage locations the POS sells from first (the shop counter). Was hard-coded to "Display Chiller",
-- which broke silently if that location was renamed.
ALTER TABLE storage_locations ADD COLUMN sells_first BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE storage_locations SET sells_first = TRUE WHERE name = 'Display Chiller';
