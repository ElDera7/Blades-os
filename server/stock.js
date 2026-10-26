// Stock engine. Every quantity lives in a lot (batch + use-by date) at a location.
//   stock        — total per product per location (fast reads, row locks)
//   stock_lots   — the same quantity broken down by lot; always kept in step here
//   stock_movements — one ledger line per change
// Removals consume lots first-expiry-first-out (FEFO). Sales never take expired lots.
import { conflict, notFound, round3 } from "./util.js";

const TODAY = `(now() AT TIME ZONE 'Africa/Lagos')::date`;

async function bumpTotal(db, sku, locationId, delta, batch) {
  if (delta > 0) {
    await db.query(
      `INSERT INTO stock (product_sku, location_id, qty, last_batch) VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_sku, location_id)
       DO UPDATE SET qty = stock.qty + EXCLUDED.qty, last_batch = COALESCE(EXCLUDED.last_batch, stock.last_batch)`,
      [sku, locationId, delta, batch ?? null]
    );
  } else {
    await db.query("UPDATE stock SET qty = qty + $3 WHERE product_sku = $1 AND location_id = $2", [sku, locationId, delta]);
  }
}

async function logMovement(db, { sku, locationId, delta, kind, reference, note, userId, at }) {
  await db.query(
    `INSERT INTO stock_movements (product_sku, location_id, delta, kind, reference, note, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))`,
    [sku, locationId, delta, kind, reference ?? null, note ?? null, userId ?? null, at ?? null]
  );
}

/**
 * Add stock. `lot` is one of:
 *   { id }                       — back into an existing lot (cancellations, restocked refunds)
 *   { code, expiresOn }          — a named lot (processing batch, supplier delivery, transfer)
 *   undefined                    — a lot named after `reference`, use-by = today + product shelf life
 * Returns the lot id.
 */
export async function addStock(db, { sku, locationId, qty, kind, reference, note, userId, at, lot }) {
  let lotId;
  if (lot?.id) {
    const r = await db.query("UPDATE stock_lots SET qty = qty + $2 WHERE id = $1 AND location_id = $3 AND product_sku = $4 RETURNING id",
      [lot.id, qty, locationId, sku]);
    lotId = r.rows[0]?.id;
  }
  if (!lotId) {
    const code = lot?.code || reference || kind.toUpperCase();
    const r = await db.query(
      `INSERT INTO stock_lots (product_sku, location_id, lot_code, expires_on, qty)
       VALUES ($1, $2, $3, COALESCE($4::date, ${TODAY} + (SELECT shelf_life_days FROM products WHERE sku = $1)), $5)
       ON CONFLICT (product_sku, location_id, lot_code, expires_on) DO UPDATE SET qty = stock_lots.qty + EXCLUDED.qty
       RETURNING id`,
      [sku, locationId, code, lot?.expiresOn ?? null, qty]
    );
    lotId = r.rows[0].id;
  }
  await bumpTotal(db, sku, locationId, qty, kind === "production" ? reference : null);
  await logMovement(db, { sku, locationId, delta: qty, kind, reference, note, userId, at });
  return lotId;
}

/**
 * Remove qty from one location, oldest use-by first (or from one named lot).
 * `sellable` = skip expired lots (for sales). Returns [{ lot_id, lot_code, expires_on, qty }].
 */
export async function removeStock(db, { sku, locationId, qty, kind, reference, note, userId, lotId, sellable = false }) {
  const total = (await db.query("SELECT qty FROM stock WHERE product_sku = $1 AND location_id = $2 FOR UPDATE", [sku, locationId])).rows[0]?.qty ?? 0;
  if (total + 1e-9 < qty) throw conflict(`Only ${round3(total)} available at that location.`);
  const lots = (await db.query(
    `SELECT id, lot_code, expires_on, qty FROM stock_lots
     WHERE product_sku = $1 AND location_id = $2 AND qty > 0 ${lotId ? "AND id = $3" : ""} ${sellable ? `AND expires_on >= ${TODAY}` : ""}
     ORDER BY expires_on, id FOR UPDATE`,
    lotId ? [sku, locationId, lotId] : [sku, locationId]
  )).rows;
  const have = lots.reduce((s, l) => s + l.qty, 0);
  if (have + 1e-9 < qty) {
    throw conflict(lotId ? `Only ${round3(have)} left in that batch.` : sellable
      ? `Only ${round3(have)} is within its use-by date — the rest has expired and must be written off.`
      : `Only ${round3(have)} available at that location.`);
  }
  let left = qty;
  const taken = [];
  for (const l of lots) {
    if (left <= 1e-9) break;
    const take = round3(Math.min(l.qty, left));
    await db.query("UPDATE stock_lots SET qty = qty - $2 WHERE id = $1", [l.id, take]);
    taken.push({ lot_id: l.id, lot_code: l.lot_code, expires_on: l.expires_on, qty: take });
    left = round3(left - take);
  }
  await bumpTotal(db, sku, locationId, -qty);
  await logMovement(db, { sku, locationId, delta: -qty, kind, reference, note, userId });
  return taken;
}

/** Move stock between locations, keeping each lot's code and use-by date. */
export async function transferStock(db, { sku, fromId, toId, qty, reference, fromName, toName, userId }) {
  const taken = await removeStock(db, { sku, locationId: fromId, qty, kind: "transfer_out", reference, note: `to ${toName}`, userId });
  for (const t of taken) {
    await db.query(
      `INSERT INTO stock_lots (product_sku, location_id, lot_code, expires_on, qty) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_sku, location_id, lot_code, expires_on) DO UPDATE SET qty = stock_lots.qty + EXCLUDED.qty`,
      [sku, toId, t.lot_code, t.expires_on, t.qty]
    );
  }
  await bumpTotal(db, sku, toId, qty);
  await logMovement(db, { sku, locationId: toId, delta: qty, kind: "transfer_in", reference, note: `from ${fromName}`, userId });
  return taken;
}

/**
 * Take qty for a sale: "POS sells first" locations (the counter) first, then the location holding the
 * earliest use-by date; within a location, oldest use-by first. Expired lots are never sold.
 * Returns allocations [{ location_id, qty, lots: [{ lot_id, qty }] }] — kept on the order line for
 * restocking and for batch recalls.
 */
export async function allocateStock(db, args) {
  return (await allocateStockUpTo(db, { ...args, allowShort: false })).allocations;
}

/**
 * Like allocateStock, but with allowShort the sale goes through even when the system shows less than was sold
 * (an offline sale: the meat was physically there and has already been paid for). Takes what the system has and
 * reports the shortfall so a manager can count that product.
 */
export async function allocateStockUpTo(db, { sku, qty, kind, reference, userId, allowShort = false }) {
  const { rows: prod } = await db.query("SELECT name, track_stock FROM products WHERE sku = $1 AND active", [sku]);
  if (!prod[0]) throw notFound(`Product ${sku} not found.`);
  if (!prod[0].track_stock) return { allocations: [], short: 0 };   // a service or item that isn't counted: always sellable
  const { rows } = await db.query(
    `SELECT s.location_id,
            COALESCE(sum(sl.qty) FILTER (WHERE sl.expires_on >= ${TODAY}), 0) AS sellable,
            COALESCE(sum(sl.qty) FILTER (WHERE sl.expires_on < ${TODAY}), 0) AS expired,
            min(sl.expires_on) FILTER (WHERE sl.expires_on >= ${TODAY} AND sl.qty > 0) AS first_expiry
     FROM stock s JOIN storage_locations l ON l.id = s.location_id
     LEFT JOIN stock_lots sl ON sl.product_sku = s.product_sku AND sl.location_id = s.location_id AND sl.qty > 0
     WHERE s.product_sku = $1 AND s.qty > 0
     GROUP BY s.location_id, l.sells_first
     ORDER BY l.sells_first DESC, first_expiry NULLS LAST`,
    [sku]
  );
  const sellable = rows.reduce((s, r) => s + r.sellable, 0);
  const expired = rows.reduce((s, r) => s + r.expired, 0);
  let short = 0;
  if (sellable + 1e-9 < qty && allowShort) { short = round3(qty - sellable); qty = round3(sellable); }
  if (sellable + 1e-9 < qty) {
    throw conflict(`Not enough ${prod[0].name} in stock — only ${round3(sellable)} available` +
      (expired > 0 ? ` (${round3(expired)} more is past its use-by date and can't be sold).` : "."));
  }
  let left = qty;
  const allocations = [];
  for (const r of rows) {
    if (left <= 1e-9) break;
    if (r.sellable <= 0) continue;
    const take = round3(Math.min(r.sellable, left));
    const taken = await removeStock(db, { sku, locationId: r.location_id, qty: take, kind, reference, userId, sellable: true });
    allocations.push({ location_id: r.location_id, qty: take, lots: taken.map((t) => ({ lot_id: t.lot_id, qty: t.qty })) });
    left = round3(left - take);
  }
  return { allocations, short };
}

/** Put sold stock back exactly where it came from (cancellation / restocked refund). Takes up to `qty`. */
export async function returnAllocations(db, { sku, allocations, qty = Infinity, kind, reference, note, userId }) {
  let left = qty;
  for (const a of allocations) {
    const lots = a.lots?.length ? a.lots : [{ lot_id: null, qty: a.qty }]; // sales from before lot tracking
    for (const l of lots) {
      if (left <= 1e-9) return;
      const back = round3(Math.min(l.qty, left));
      await addStock(db, { sku, locationId: a.location_id, qty: back, kind, reference, note, userId, lot: l.lot_id ? { id: l.lot_id } : undefined });
      left = round3(left - back);
    }
  }
}
