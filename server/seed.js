import { fileURLToPath } from "node:url";
import { pool, query, tx } from "./db.js";
import { hashPassword } from "./auth.js";

/* =====================================================================
   Starting catalogue — inserted ONCE on the very first boot. After that,
   products, locations and ranches are managed in BladeOS → Setup, and
   renames or retirements are never undone by a redeploy.
   ===================================================================== */
export const LOCATIONS = ["Cold Room A", "Cold Room B", "Display Chiller", "Freezer 01", "Freezer 02", "Processing Area"];
export const RANCHES = ["Ranch A — Kuje", "Ranch B — Gwagwalada"];
export const PRODUCTS = [
  // sku, name, category, unit, price, cost, min
  ["PB-BEEF", "Premium Beef", "Beef", "KG", 8500, 5270, 40],
  ["STEW-BEEF", "Stew Cuts", "Beef", "KG", 6800, 4216, 30],
  ["BL-BEEF", "Boneless Beef", "Beef", "KG", 9200, 5704, 20],
  ["MINCE-BEEF", "Minced Beef", "Beef", "KG", 7200, 4464, 20],
  ["OTH-BEEF", "Other Beef Cuts", "Beef", "KG", 5600, 3472, 15],
  ["GOAT-MEAT", "Goat Meat", "Goat", "KG", 7800, 4836, 25],
  ["RAM-MEAT", "Ram Meat", "Sheep", "KG", 8200, 5084, 10],
  ["CHICKEN", "Chicken", "Poultry", "Unit", 7200, 4464, 30],
  ["TURKEY", "Turkey", "Poultry", "Unit", 15500, 9610, 15],
  ["SAUSAGE", "Sausages", "Processed", "Pack", 3200, 1984, 20],
  ["KPOMO", "Kpomo", "By-product", "KG", 2600, 1612, 10],
];

export async function seedReference() {
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(727275)");
    const done = (await db.query("SELECT 1 FROM settings WHERE key = 'reference_seeded'")).rows[0];
    if (done) return;
    for (const [i, name] of LOCATIONS.entries()) {
      // Safe ranges: freezers −30 to −18 °C, chillers/cold rooms 0–4 °C, cutting room 0–10 °C.
      const range = /^freezer/i.test(name) ? [-30, -18] : /^processing/i.test(name) ? [0, 10] : [0, 4];
      await db.query("INSERT INTO storage_locations (name, sort, sells_first, temp_min, temp_max) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING",
        [name, i, name === "Display Chiller", range[0], range[1]]);
    }
    for (const name of RANCHES) await db.query("INSERT INTO ranches (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    for (const [i, p] of PRODUCTS.entries()) {
      await db.query(
        `INSERT INTO products (sku, name, category, unit, price, cost_price, min_stock, sort, plu) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (sku) DO NOTHING`,
        [...p, i, i + 1]   // PLU 1, 2, 3… for scale-printed labels
      );
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('reference_seeded', 'true'::jsonb)");
    console.log("Starting catalogue created: products, storage locations, ranches.");
  });
}

/* =====================================================================
   The shop's range from bladesbutchers.com, with its photos (public/products/).
   Runs ONCE: adds what's missing and puts photos on products that have none.
   Prices marked here are starting prices — the Owner sets the real ones in
   Business Setup. Packaging services aren't stock-counted.
   ===================================================================== */
export const WEBSITE_PHOTOS = {
  "PB-BEEF": "/products/beef.png", "BL-BEEF": "/products/boneless.jpeg", "MINCE-BEEF": "/products/minced.jpg",
  "STEW-BEEF": "/products/stew-cuts.jpg", "GOAT-MEAT": "/products/goat-meat.png", "CHICKEN": "/products/chicken.png",
  "TURKEY": "/products/turkey.png", "SAUSAGE": "/products/sausages.jpg",
};
export const WEBSITE_PRODUCTS = [
  // sku, name, category, unit, price, cost, min, vat %, photo, counted
  ["WHOLE-BIRD", "Whole Bird", "Poultry", "Unit", 9500, 5890, 10, 0, "/products/whole-bird.jpg", true],
  ["EGGS", "Eggs (crate)", "Poultry", "Pack", 5500, 3410, 10, 0, "/products/eggs.jpg", true],
  ["MARINATED", "Marinated Meat", "Processed", "KG", 9800, 6076, 10, 0, "/products/marinated-meat.jpg", true],
  ["FROZEN-PACK", "Frozen Meat Pack", "Processed", "Pack", 15000, 9300, 10, 0, "/products/frozen-meat-pack.jpg", true],
  ["PKG-SEAL", "Basic Sealing", "Packaging", "Unit", 200, 60, 0, 7.5, "/products/basic-sealing.png", false],
  ["PKG-KRAFT", "Kraft Box", "Packaging", "Unit", 1000, 450, 0, 7.5, "/products/kraft-box.png", false],
  ["PKG-TAKEOUT", "Plastic Takeout Pack", "Packaging", "Unit", 300, 120, 0, 7.5, "/products/takeout-pack.png", false],
  ["PKG-ZIPLOCK", "Branded Zip-Lock Bag", "Packaging", "Unit", 250, 100, 0, 7.5, "/products/zip-lock-bag.png", false],
];

export async function seedWebsiteCatalogue() {
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(727276)");
    if ((await db.query("SELECT 1 FROM settings WHERE key = 'catalogue_website_v1'")).rows[0]) return;
    for (const [sku, image] of Object.entries(WEBSITE_PHOTOS)) await db.query("UPDATE products SET image = $2 WHERE sku = $1 AND image IS NULL", [sku, image]);
    let added = 0;
    for (const [sku, name, category, unit, price, cost, min, vat, image, counted] of WEBSITE_PRODUCTS) {
      const exists = (await db.query("SELECT 1 FROM products WHERE sku = $1 OR lower(name) = lower($2)", [sku, name])).rows[0];
      if (exists) continue;
      const { s, n } = (await db.query("SELECT COALESCE(max(sort), 0) + 1 AS s, COALESCE(max(plu), 0) + 1 AS n FROM products")).rows[0];
      await db.query(
        `INSERT INTO products (sku, name, category, unit, price, cost_price, min_stock, sort, plu, vat_rate, image, track_stock, shelf_life_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [sku, name, category, unit, price, cost, min, s, n, vat, image, counted, category === "Packaging" ? 730 : unit === "Pack" ? 30 : 5]);
      added++;
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('catalogue_website_v1', 'true'::jsonb)");
    await db.query("INSERT INTO audit_log (action, detail) VALUES ('Website product range added', $1)", [`${added} new products, photos on ${Object.keys(WEBSITE_PHOTOS).length}`]);
  });
}

/** Creates the first account (the Super Admin) from ADMIN_EMAIL / ADMIN_PASSWORD if there are no users yet. */
export async function ensureOwner() {
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 8) {
    console.warn("\n⚠️  No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ chars) and redeploy to create the first (Super Admin) account.\n");
    return;
  }
  // ADMIN_PASSWORD lives in the hosting dashboard, so it's treated as temporary and must be replaced at first sign-in.
  await query("INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES ($1, lower($2), 'Super Admin', $3, TRUE)",
    [process.env.ADMIN_NAME || "Super Admin", email, await hashPassword(password)]);
  console.log(`Created Super Admin account: ${email}`);
}

/**
 * The system always has a Super Admin. On an existing install with none, the ADMIN_EMAIL account
 * (the person who set BladeOS up) is promoted. They sign in again under the new role.
 */
export async function ensureSuperAdmin() {
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(727277)");
    if ((await db.query("SELECT 1 FROM users WHERE role = 'Super Admin' AND active")).rows[0]) return;
    const email = process.env.ADMIN_EMAIL;
    if (!email) { console.warn("⚠️  No active Super Admin. Set ADMIN_EMAIL to the account to promote, and redeploy."); return; }
    const u = (await db.query("SELECT id, role FROM users WHERE email = lower($1) AND active", [email])).rows[0];
    if (!u) { console.warn(`⚠️  No active Super Admin, and no active account for ADMIN_EMAIL (${email}).`); return; }
    await db.query("UPDATE users SET role = 'Super Admin', extra_roles = '{}', updated_at = now() WHERE id = $1", [u.id]);
    await db.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
    await db.query("INSERT INTO audit_log (action, detail) VALUES ($1, $2)", [`Promoted ${email.toLowerCase()} to Super Admin`, `was ${u.role} (ADMIN_EMAIL, on start-up)`]);
    console.log(`Promoted ${email} to Super Admin.`);
  });
}

/** Called on every boot: reference data (idempotent) + first account + Super Admin. Business data is entered by staff. */
export async function bootstrap() {
  await seedReference();
  await seedWebsiteCatalogue();
  await ensureOwner();
  await ensureSuperAdmin();
  const { breakGlassMfa } = await import("./auth.js");
  await breakGlassMfa();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { migrate } = await import("./migrate.js");
  migrate()
    .then(bootstrap)
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
