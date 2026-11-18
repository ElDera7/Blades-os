-- Migration 013: Clean Wipe Old Fake Inventory & Populate 57 Official Products
-- Completely purges placeholder/test products so only the official 57 items exist.

-- 1. Delete all references to old fake / non-official products
DELETE FROM stock_lots WHERE product_sku NOT IN ('BEEF-STD', 'BEEF-FILLET', 'BEEF-PREM-STK', 'BEEF-RIBEYE', 'BEEF-SIRLOIN', 'BEEF-TBONE', 'BEEF-TENDERLOIN', 'BEEF-SUYA', 'BEEF-MINCE', 'BEEF-MARINATED', 'BEEF-BURGER', 'BEEF-SHAWARMA', 'BEEF-TOPSIDE', 'BEEF-BACKSTEAK', 'BEEF-OXTAIL', 'BEEF-KIDNEY', 'BEEF-LIVER', 'BEEF-COWLEGS', 'BEEF-COWTAIL', 'BEEF-COWHEAD', 'BEEF-SHINE', 'RAM-STD', 'RAM-PREM', 'RAM-ASSTD', 'RAM-BURGER', 'RAM-MINCE', 'LAMB-CHOPS', 'LAMB-STD', 'LAMB-ROASTED', 'LAMB-BONE', 'LAMB-NOBONE', 'GOAT-STD', 'GOAT-PREM', 'GOAT-ASSTD', 'GOAT-BONE', 'GOAT-NOBONE', 'GOAT-SMOKED', 'CHICK-LAP', 'CHICK-WINGS', 'CHICK-BREAST', 'CHICK-THIGHS', 'CHICK-GIZZARD', 'CHICK-DRUM', 'CHICK-BURGER', 'CHICK-MARINATED', 'CHICK-WHOLE', 'CHICK-LOCAL', 'TURKEY-WINGS', 'TURKEY-GIZZARD', 'TURKEY-DRUM', 'TURKEY-HAM', 'CHEESE-MOZZ', 'CHEESE-PARM', 'CHEESE-REDCHD', 'CHEESE-WHTCHD', 'CHEESE-CHD', 'CHEESE-KASH');
DELETE FROM stock WHERE product_sku NOT IN ('BEEF-STD', 'BEEF-FILLET', 'BEEF-PREM-STK', 'BEEF-RIBEYE', 'BEEF-SIRLOIN', 'BEEF-TBONE', 'BEEF-TENDERLOIN', 'BEEF-SUYA', 'BEEF-MINCE', 'BEEF-MARINATED', 'BEEF-BURGER', 'BEEF-SHAWARMA', 'BEEF-TOPSIDE', 'BEEF-BACKSTEAK', 'BEEF-OXTAIL', 'BEEF-KIDNEY', 'BEEF-LIVER', 'BEEF-COWLEGS', 'BEEF-COWTAIL', 'BEEF-COWHEAD', 'BEEF-SHINE', 'RAM-STD', 'RAM-PREM', 'RAM-ASSTD', 'RAM-BURGER', 'RAM-MINCE', 'LAMB-CHOPS', 'LAMB-STD', 'LAMB-ROASTED', 'LAMB-BONE', 'LAMB-NOBONE', 'GOAT-STD', 'GOAT-PREM', 'GOAT-ASSTD', 'GOAT-BONE', 'GOAT-NOBONE', 'GOAT-SMOKED', 'CHICK-LAP', 'CHICK-WINGS', 'CHICK-BREAST', 'CHICK-THIGHS', 'CHICK-GIZZARD', 'CHICK-DRUM', 'CHICK-BURGER', 'CHICK-MARINATED', 'CHICK-WHOLE', 'CHICK-LOCAL', 'TURKEY-WINGS', 'TURKEY-GIZZARD', 'TURKEY-DRUM', 'TURKEY-HAM', 'CHEESE-MOZZ', 'CHEESE-PARM', 'CHEESE-REDCHD', 'CHEESE-WHTCHD', 'CHEESE-CHD', 'CHEESE-KASH');
DELETE FROM stock_movements WHERE product_sku NOT IN ('BEEF-STD', 'BEEF-FILLET', 'BEEF-PREM-STK', 'BEEF-RIBEYE', 'BEEF-SIRLOIN', 'BEEF-TBONE', 'BEEF-TENDERLOIN', 'BEEF-SUYA', 'BEEF-MINCE', 'BEEF-MARINATED', 'BEEF-BURGER', 'BEEF-SHAWARMA', 'BEEF-TOPSIDE', 'BEEF-BACKSTEAK', 'BEEF-OXTAIL', 'BEEF-KIDNEY', 'BEEF-LIVER', 'BEEF-COWLEGS', 'BEEF-COWTAIL', 'BEEF-COWHEAD', 'BEEF-SHINE', 'RAM-STD', 'RAM-PREM', 'RAM-ASSTD', 'RAM-BURGER', 'RAM-MINCE', 'LAMB-CHOPS', 'LAMB-STD', 'LAMB-ROASTED', 'LAMB-BONE', 'LAMB-NOBONE', 'GOAT-STD', 'GOAT-PREM', 'GOAT-ASSTD', 'GOAT-BONE', 'GOAT-NOBONE', 'GOAT-SMOKED', 'CHICK-LAP', 'CHICK-WINGS', 'CHICK-BREAST', 'CHICK-THIGHS', 'CHICK-GIZZARD', 'CHICK-DRUM', 'CHICK-BURGER', 'CHICK-MARINATED', 'CHICK-WHOLE', 'CHICK-LOCAL', 'TURKEY-WINGS', 'TURKEY-GIZZARD', 'TURKEY-DRUM', 'TURKEY-HAM', 'CHEESE-MOZZ', 'CHEESE-PARM', 'CHEESE-REDCHD', 'CHEESE-WHTCHD', 'CHEESE-CHD', 'CHEESE-KASH');
DELETE FROM order_items WHERE product_sku NOT IN ('BEEF-STD', 'BEEF-FILLET', 'BEEF-PREM-STK', 'BEEF-RIBEYE', 'BEEF-SIRLOIN', 'BEEF-TBONE', 'BEEF-TENDERLOIN', 'BEEF-SUYA', 'BEEF-MINCE', 'BEEF-MARINATED', 'BEEF-BURGER', 'BEEF-SHAWARMA', 'BEEF-TOPSIDE', 'BEEF-BACKSTEAK', 'BEEF-OXTAIL', 'BEEF-KIDNEY', 'BEEF-LIVER', 'BEEF-COWLEGS', 'BEEF-COWTAIL', 'BEEF-COWHEAD', 'BEEF-SHINE', 'RAM-STD', 'RAM-PREM', 'RAM-ASSTD', 'RAM-BURGER', 'RAM-MINCE', 'LAMB-CHOPS', 'LAMB-STD', 'LAMB-ROASTED', 'LAMB-BONE', 'LAMB-NOBONE', 'GOAT-STD', 'GOAT-PREM', 'GOAT-ASSTD', 'GOAT-BONE', 'GOAT-NOBONE', 'GOAT-SMOKED', 'CHICK-LAP', 'CHICK-WINGS', 'CHICK-BREAST', 'CHICK-THIGHS', 'CHICK-GIZZARD', 'CHICK-DRUM', 'CHICK-BURGER', 'CHICK-MARINATED', 'CHICK-WHOLE', 'CHICK-LOCAL', 'TURKEY-WINGS', 'TURKEY-GIZZARD', 'TURKEY-DRUM', 'TURKEY-HAM', 'CHEESE-MOZZ', 'CHEESE-PARM', 'CHEESE-REDCHD', 'CHEESE-WHTCHD', 'CHEESE-CHD', 'CHEESE-KASH');

-- 2. Delete all fake products not in the official 57 catalogue
DELETE FROM products WHERE sku NOT IN ('BEEF-STD', 'BEEF-FILLET', 'BEEF-PREM-STK', 'BEEF-RIBEYE', 'BEEF-SIRLOIN', 'BEEF-TBONE', 'BEEF-TENDERLOIN', 'BEEF-SUYA', 'BEEF-MINCE', 'BEEF-MARINATED', 'BEEF-BURGER', 'BEEF-SHAWARMA', 'BEEF-TOPSIDE', 'BEEF-BACKSTEAK', 'BEEF-OXTAIL', 'BEEF-KIDNEY', 'BEEF-LIVER', 'BEEF-COWLEGS', 'BEEF-COWTAIL', 'BEEF-COWHEAD', 'BEEF-SHINE', 'RAM-STD', 'RAM-PREM', 'RAM-ASSTD', 'RAM-BURGER', 'RAM-MINCE', 'LAMB-CHOPS', 'LAMB-STD', 'LAMB-ROASTED', 'LAMB-BONE', 'LAMB-NOBONE', 'GOAT-STD', 'GOAT-PREM', 'GOAT-ASSTD', 'GOAT-BONE', 'GOAT-NOBONE', 'GOAT-SMOKED', 'CHICK-LAP', 'CHICK-WINGS', 'CHICK-BREAST', 'CHICK-THIGHS', 'CHICK-GIZZARD', 'CHICK-DRUM', 'CHICK-BURGER', 'CHICK-MARINATED', 'CHICK-WHOLE', 'CHICK-LOCAL', 'TURKEY-WINGS', 'TURKEY-GIZZARD', 'TURKEY-DRUM', 'TURKEY-HAM', 'CHEESE-MOZZ', 'CHEESE-PARM', 'CHEESE-REDCHD', 'CHEESE-WHTCHD', 'CHEESE-CHD', 'CHEESE-KASH');

-- 3. Clear PLU assignments to prevent any collision during upsert
UPDATE products SET plu = NULL WHERE plu IS NOT NULL;

-- 4. Insert or update all 57 official products
INSERT INTO products (sku, name, category, unit, price, cost_price, min_stock, sort, plu, shelf_life_days, track_stock, active)
VALUES
  ('BEEF-STD', 'Beef', 'Beef', 'KG', 12500, 7750, 30, 1, 1, 5, TRUE, TRUE),
  ('BEEF-FILLET', 'Beef Fillet', 'Beef', 'KG', 13500, 8370, 20, 2, 2, 5, TRUE, TRUE),
  ('BEEF-PREM-STK', 'Premium Steak Cut', 'Beef', 'KG', 12000, 7440, 15, 3, 3, 5, TRUE, TRUE),
  ('BEEF-RIBEYE', 'Rib Eye Steak', 'Beef', 'KG', 17500, 10850, 15, 4, 4, 5, TRUE, TRUE),
  ('BEEF-SIRLOIN', 'Sirloin Steak', 'Beef', 'KG', 10900, 6750, 15, 5, 5, 5, TRUE, TRUE),
  ('BEEF-TBONE', 'T-Bone Steak', 'Beef', 'KG', 17500, 10850, 15, 6, 6, 5, TRUE, TRUE),
  ('BEEF-TENDERLOIN', 'Fillet/Tender Loin', 'Beef', 'KG', 10900, 6750, 15, 7, 7, 5, TRUE, TRUE),
  ('BEEF-SUYA', 'Suya Beef Cut', 'Beef', 'KG', 10900, 6750, 20, 8, 8, 5, TRUE, TRUE),
  ('BEEF-MINCE', 'Minced Beef', 'Beef', 'KG', 10870, 6740, 20, 9, 9, 5, TRUE, TRUE),
  ('BEEF-MARINATED', 'Marinated Beef', 'Beef', 'KG', 11000, 6820, 15, 10, 10, 5, TRUE, TRUE),
  ('BEEF-BURGER', 'Beef Burger', 'Beef', 'KG', 12000, 7440, 15, 11, 11, 5, TRUE, TRUE),
  ('BEEF-SHAWARMA', 'Beef Shawarma', 'Beef', 'KG', 15000, 9300, 15, 12, 12, 5, TRUE, TRUE),
  ('BEEF-TOPSIDE', 'Top Side', 'Beef', 'KG', 10870, 6740, 15, 13, 13, 5, TRUE, TRUE),
  ('BEEF-BACKSTEAK', 'Back Steak', 'Beef', 'KG', 10900, 6750, 15, 14, 14, 5, TRUE, TRUE),
  ('BEEF-OXTAIL', 'Oxtail', 'Beef', 'KG', 10300, 6380, 15, 15, 15, 5, TRUE, TRUE),
  ('BEEF-KIDNEY', 'Ox Kidney', 'Beef', 'KG', 9250, 5730, 10, 16, 16, 5, TRUE, TRUE),
  ('BEEF-LIVER', 'Liver', 'Beef', 'KG', 8650, 5360, 15, 17, 17, 5, TRUE, TRUE),
  ('BEEF-COWLEGS', 'Cow Legs', 'Beef', 'KG', 8000, 4960, 15, 18, 18, 5, TRUE, TRUE),
  ('BEEF-COWTAIL', 'Cow Tail', 'Beef', 'KG', 8300, 5140, 15, 19, 19, 5, TRUE, TRUE),
  ('BEEF-COWHEAD', 'Cow Head', 'Beef', 'Unit', 10000, 6200, 5, 20, 20, 5, TRUE, TRUE),
  ('BEEF-SHINE', 'Shine', 'Beef', 'KG', 8000, 4960, 15, 21, 21, 5, TRUE, TRUE),
  ('RAM-STD', 'Ram', 'Ram', 'KG', 10870, 6740, 20, 22, 22, 5, TRUE, TRUE),
  ('RAM-PREM', 'Premium Ram Cuts', 'Ram', 'KG', 12000, 7440, 15, 23, 23, 5, TRUE, TRUE),
  ('RAM-ASSTD', 'Ram Assorted', 'Ram', 'KG', 6500, 4030, 15, 24, 24, 5, TRUE, TRUE),
  ('RAM-BURGER', 'Ram Burger', 'Ram', 'KG', 10000, 6200, 10, 25, 25, 5, TRUE, TRUE),
  ('RAM-MINCE', 'Ram Minced', 'Ram', 'KG', 12000, 7440, 15, 26, 26, 5, TRUE, TRUE),
  ('LAMB-CHOPS', 'Lambchops', 'Lamb', 'KG', 12000, 7440, 15, 27, 27, 5, TRUE, TRUE),
  ('LAMB-STD', 'Lamb', 'Lamb', 'KG', 10870, 6740, 15, 28, 28, 5, TRUE, TRUE),
  ('LAMB-ROASTED', 'Roasted Lamb', 'Lamb', 'KG', 10870, 6740, 10, 29, 29, 5, TRUE, TRUE),
  ('LAMB-BONE', 'Lamb Meat with Bone', 'Lamb', 'KG', 11500, 7130, 15, 30, 30, 5, TRUE, TRUE),
  ('LAMB-NOBONE', 'Lamb without Bone', 'Lamb', 'KG', 13000, 8060, 15, 31, 31, 5, TRUE, TRUE),
  ('GOAT-STD', 'Goat Meat', 'Goat', 'KG', 16500, 10230, 25, 32, 32, 5, TRUE, TRUE),
  ('GOAT-PREM', 'Premium Goat Cut', 'Goat', 'KG', 12000, 7440, 15, 33, 33, 5, TRUE, TRUE),
  ('GOAT-ASSTD', 'Goat Assorted', 'Goat', 'KG', 6500, 4030, 20, 34, 34, 5, TRUE, TRUE),
  ('GOAT-BONE', 'Goat Meat with Bone', 'Goat', 'KG', 15000, 9300, 15, 35, 35, 5, TRUE, TRUE),
  ('GOAT-NOBONE', 'Goat Meat without Bone', 'Goat', 'KG', 15900, 9850, 15, 36, 36, 5, TRUE, TRUE),
  ('GOAT-SMOKED', 'Smoked Goat', 'Goat', 'KG', 10870, 6740, 10, 37, 37, 14, TRUE, TRUE),
  ('CHICK-LAP', 'Chicken Lap', 'Poultry', 'KG', 7200, 4460, 25, 38, 38, 5, TRUE, TRUE),
  ('CHICK-WINGS', 'Chicken Wings', 'Poultry', 'KG', 9500, 5890, 25, 39, 39, 5, TRUE, TRUE),
  ('CHICK-BREAST', 'Chicken Breast', 'Poultry', 'KG', 9500, 5890, 25, 40, 40, 5, TRUE, TRUE),
  ('CHICK-THIGHS', 'Chicken Thighs', 'Poultry', 'KG', 12500, 7750, 25, 41, 41, 5, TRUE, TRUE),
  ('CHICK-GIZZARD', 'Chicken Gizzard', 'Poultry', 'KG', 8020, 4970, 20, 42, 42, 5, TRUE, TRUE),
  ('CHICK-DRUM', 'Chicken Drumstick', 'Poultry', 'KG', 9500, 5890, 20, 43, 43, 5, TRUE, TRUE),
  ('CHICK-BURGER', 'Chicken Burger', 'Poultry', 'KG', 9500, 5890, 15, 44, 44, 5, TRUE, TRUE),
  ('CHICK-MARINATED', 'Marinated Chicken', 'Poultry', 'KG', 13700, 8490, 15, 45, 45, 5, TRUE, TRUE),
  ('CHICK-WHOLE', 'Whole Chicken', 'Poultry', 'KG', 7000, 4340, 20, 46, 46, 5, TRUE, TRUE),
  ('CHICK-LOCAL', 'Local Chicken', 'Poultry', 'KG', 13860, 8590, 10, 47, 47, 5, TRUE, TRUE),
  ('TURKEY-WINGS', 'Turkey Wings', 'Poultry', 'KG', 13500, 8370, 20, 48, 48, 5, TRUE, TRUE),
  ('TURKEY-GIZZARD', 'Turkey Gizzard', 'Poultry', 'KG', 13700, 8490, 15, 49, 49, 5, TRUE, TRUE),
  ('TURKEY-DRUM', 'Turkey Drumstick', 'Poultry', 'KG', 15000, 9300, 20, 50, 50, 5, TRUE, TRUE),
  ('TURKEY-HAM', 'Turkey Ham', 'Poultry', 'KG', 32000, 19840, 10, 51, 51, 14, TRUE, TRUE),
  ('CHEESE-MOZZ', 'Mozzarella Cheese', 'Dairy & Cheese', 'KG', 22000, 13640, 10, 52, 52, 30, TRUE, TRUE),
  ('CHEESE-PARM', 'Parmesan Cheese', 'Dairy & Cheese', 'KG', 50000, 31000, 10, 53, 53, 60, TRUE, TRUE),
  ('CHEESE-REDCHD', 'Red Cheddar Cheese', 'Dairy & Cheese', 'KG', 27000, 16740, 10, 54, 54, 45, TRUE, TRUE),
  ('CHEESE-WHTCHD', 'White Cheddar Cheese', 'Dairy & Cheese', 'KG', 30500, 18910, 10, 55, 55, 45, TRUE, TRUE),
  ('CHEESE-CHD', 'Cheddar Cheese', 'Dairy & Cheese', 'KG', 35000, 21700, 10, 56, 56, 45, TRUE, TRUE),
  ('CHEESE-KASH', 'Kashkaval Cow', 'Dairy & Cheese', 'KG', 59000, 36580, 10, 57, 57, 45, TRUE, TRUE)
ON CONFLICT (sku) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  unit = EXCLUDED.unit,
  price = EXCLUDED.price,
  cost_price = EXCLUDED.cost_price,
  min_stock = EXCLUDED.min_stock,
  sort = EXCLUDED.sort,
  plu = EXCLUDED.plu,
  shelf_life_days = EXCLUDED.shelf_life_days,
  track_stock = EXCLUDED.track_stock,
  active = TRUE;

-- 5. Ensure business profile has scaleLabel set to 'weight'
UPDATE settings
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{scaleLabel}', '"weight"')
WHERE key = 'business_profile';
