-- Migration 012: Blades & Butchers Official Price List & Store Profile
-- Populates the complete official price list and updates business profile details

-- 1. Update Business Profile with Official Shop Details
INSERT INTO settings (key, value)
VALUES (
  'business_profile',
  jsonb_build_object(
    'name', 'Blades & Butchers',
    'tagline', 'From Ranch to Retail',
    'address', 'Shop A01, Vegas Mall, Atakpame Street, Off Adetokunbo Ademola Crescent, Wuse 2, Abuja',
    'phone', '+234 701 555 1755, +234 810 784 1658',
    'email', 'info@bladesbutchers.com',
    'website', 'www.bladesbutchers.com',
    'tin', '',
    'receiptFooter', 'Thank you for choosing Blades & Butchers!',
    'scaleLabel', 'weight'
  )
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Clear existing PLUs first to prevent unique constraint collisions (products_plu_uq)
UPDATE products SET plu = NULL WHERE plu IS NOT NULL;

-- 3. Insert or Update all Official Blades & Butchers Products with PLUs and Pricing
INSERT INTO products (sku, name, category, unit, price, cost_price, min_stock, sort, plu, shelf_life_days, track_stock)
VALUES
  -- Beef (Per KG)
  ('BEEF-STD', 'Beef', 'Beef', 'KG', 7500, 4650, 30, 1, 1, 5, TRUE),
  ('BEEF-PREM-STK', 'Premium Steak cut', 'Beef', 'KG', 12000, 7440, 20, 2, 2, 5, TRUE),
  ('BEEF-SOFT-BL', 'Soft boneless meat', 'Beef', 'KG', 8500, 5270, 25, 3, 3, 5, TRUE),
  ('BEEF-RIBEYE', 'Rib eye steak', 'Beef', 'KG', 13500, 8370, 15, 4, 4, 5, TRUE),
  ('BEEF-SIRLOIN', 'Sirloin steak', 'Beef', 'KG', 12500, 7750, 15, 5, 5, 5, TRUE),
  ('BEEF-TBONE', 'Tbone steak', 'Beef', 'KG', 13500, 8370, 15, 6, 6, 5, TRUE),
  ('BEEF-FILLET', 'Fillet/Tender loin', 'Beef', 'KG', 14000, 8680, 15, 7, 7, 5, TRUE),
  ('BEEF-SUYA', 'Suya beef cut', 'Beef', 'KG', 10500, 6510, 20, 8, 8, 5, TRUE),
  ('BEEF-MINCE', 'Minced beef', 'Beef', 'KG', 8500, 5270, 20, 9, 9, 5, TRUE),
  ('BEEF-MARINATED', 'Marinated beef', 'Beef', 'KG', 11000, 6820, 15, 10, 10, 5, TRUE),

  -- Ram (Per KG / Pack)
  ('RAM-STD', 'Ram meat', 'Ram', 'KG', 11500, 7130, 20, 11, 11, 5, TRUE),
  ('RAM-PREM', 'Premium ram cuts', 'Ram', 'KG', 13000, 8060, 15, 12, 12, 5, TRUE),
  ('RAM-ASSTD', 'Ram assorted', 'Ram', 'KG', 7000, 4340, 15, 13, 13, 5, TRUE),
  ('RAM-PS-PACK', 'Peppersoup ram pack', 'Ram', 'Pack', 12000, 7440, 10, 14, 14, 10, TRUE),
  ('RAM-SMOKED', 'Smoked ram', 'Ram', 'KG', 14000, 8680, 10, 15, 15, 14, TRUE),

  -- Goat (Per KG / Pack)
  ('GOAT-STD', 'Goat meat', 'Goat', 'KG', 8500, 5270, 25, 16, 16, 5, TRUE),
  ('GOAT-PREM', 'Premium goat cut', 'Goat', 'KG', 10000, 6200, 15, 17, 17, 5, TRUE),
  ('GOAT-ASSTD', 'Goat assorted', 'Goat', 'KG', 6500, 4030, 20, 18, 18, 5, TRUE),
  ('GOAT-MARINATED', 'Marinated goat meat', 'Goat', 'KG', 11000, 6820, 10, 19, 19, 5, TRUE),
  ('GOAT-PS-PACK', 'Peppersoup goat pack', 'Goat', 'Pack', 10500, 6510, 10, 20, 20, 10, TRUE),
  ('GOAT-SMOKED', 'Smoked goat meat', 'Goat', 'KG', 11500, 7130, 10, 21, 21, 14, TRUE),

  -- Turkey (Per KG)
  ('TURKEY-WINGS', 'Turkey Wings', 'Turkey', 'KG', 11500, 7130, 20, 22, 22, 5, TRUE),
  ('TURKEY-GIZZARD', 'Turkey Gizzards', 'Turkey', 'KG', 10000, 6200, 15, 23, 23, 5, TRUE),
  ('TURKEY-DRUM', 'Turkey drumsticks', 'Turkey', 'KG', 11500, 7130, 20, 24, 24, 5, TRUE),
  ('TURKEY-FZ-WINGS', 'Frozen Turkey wings', 'Turkey', 'KG', 10500, 6510, 20, 25, 25, 30, TRUE),
  ('TURKEY-FZ-GIZZARD', 'Frozen Turkey Gizzard', 'Turkey', 'KG', 9000, 5580, 15, 26, 26, 30, TRUE),
  ('TURKEY-PS', 'Peppersoup turkey', 'Turkey', 'KG', 13500, 8370, 10, 27, 27, 5, TRUE),
  ('TURKEY-SMOKED', 'Smoked turkey', 'Turkey', 'KG', 13500, 8370, 10, 28, 28, 14, TRUE),

  -- Chicken & Poultry (Per KG)
  ('CHICK-WINGS', 'Chicken wings', 'Poultry', 'KG', 7500, 4650, 25, 29, 29, 5, TRUE),
  ('CHICK-BREAST', 'Chicken breast', 'Poultry', 'KG', 8500, 5270, 25, 30, 30, 5, TRUE),
  ('CHICK-THIGHS', 'Chicken thighs', 'Poultry', 'KG', 7500, 4650, 25, 31, 31, 5, TRUE),
  ('CHICK-GIZZARD', 'Chicken gizzard', 'Poultry', 'KG', 8000, 4960, 20, 32, 32, 5, TRUE),
  ('CHICK-MARINATED', 'Marinated chicken', 'Poultry', 'KG', 11000, 6820, 15, 33, 33, 5, TRUE),
  ('CHICK-SMOKED', 'Smoked Chicken', 'Poultry', 'KG', 12000, 7440, 15, 34, 34, 14, TRUE),
  ('CHICK-PEPPERED', 'Peppered chicken', 'Poultry', 'KG', 9500, 5890, 15, 35, 35, 5, TRUE),
  ('CHICK-FZ-WINGS', 'Frozen Chicken wings', 'Poultry', 'KG', 6500, 4030, 20, 36, 36, 30, TRUE),
  ('CHICK-FZ-THIGHS', 'Frozen Chicken thighs', 'Poultry', 'KG', 6500, 4030, 20, 37, 37, 30, TRUE),
  ('CHICK-FZ-GIZZARD', 'Frozen chicken gizzards', 'Poultry', 'KG', 7000, 4340, 20, 38, 38, 30, TRUE),
  ('CHICK-FZ-BREAST', 'Frozen Chicken breasts', 'Poultry', 'KG', 7000, 4340, 20, 39, 39, 30, TRUE),

  -- Live Birds (Per Unit)
  ('LIVE-BROILER', 'Broilers (live)', 'Live Poultry', 'Unit', 10000, 6200, 10, 40, 40, 30, TRUE),
  ('LIVE-LOCAL', 'Local chicken (live)', 'Live Poultry', 'Unit', 15000, 9300, 10, 41, 41, 30, TRUE),
  ('LIVE-NOILER', 'Noilers (live)', 'Live Poultry', 'Unit', 12000, 7440, 10, 42, 42, 30, TRUE),

  -- Subscription Packages (Per Pack)
  ('PKG-BRONZE', 'Bronze package (2kg beef + 1kg chicken breast)', 'Packages', 'Pack', 23500, 14570, 5, 43, 43, 30, FALSE),
  ('PKG-SILVER', 'Silver package (2kg chicken breast + 2kg beef + 1kg goat)', 'Packages', 'Pack', 36750, 22785, 5, 44, 44, 30, FALSE),
  ('PKG-GOLD', 'Gold package (4kg beef + 3kg chicken breast + 1kg goat)', 'Packages', 'Pack', 59750, 37045, 5, 45, 45, 30, FALSE),
  ('PKG-FAMILY', 'Family package (4kg beef + 2kg turkey wings + 3kg chicken breast + 1kg goat)', 'Packages', 'Pack', 87000, 53940, 5, 46, 46, 30, FALSE)
ON CONFLICT (sku) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  unit = EXCLUDED.unit,
  price = EXCLUDED.price,
  cost_price = EXCLUDED.cost_price,
  sort = EXCLUDED.sort,
  plu = EXCLUDED.plu,
  shelf_life_days = EXCLUDED.shelf_life_days,
  track_stock = EXCLUDED.track_stock,
  active = TRUE;
