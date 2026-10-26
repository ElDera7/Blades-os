// Point of sale, to retail standard:
//   • one sale per "Complete" tap (client_ref makes retries safe)
//   • line and ticket discounts with a reason; above the seller's authority a manager approves with their PIN
//   • split tender: any mix of Cash / Transfer / POS Card; cash tendered and change recorded
//   • VAT per product, prices VAT-inclusive, shown on the receipt
//   • parked (held) tickets, cleared-ticket log, X / Z till reports, receipt header in settings
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, tx } from "./db.js";
import { requirePerm, requireAuth, signPurpose, verifyPurpose } from "./auth.js";
import { allocateStockUpTo } from "./stock.js";
import { openTill, tillSummary, approvalLimits } from "./operations.js";
import { can, UNLIMITED_APPROVER, DISCOUNT_REASONS, weakPin } from "../src/shared/permissions.js";
import { ah, parse, audit, bad, notFound, conflict, HttpError, round3, fmtDateTime } from "./util.js";

const naira = (n) => `₦${Math.round(n || 0).toLocaleString("en-NG")}`;
const id = z.coerce.number().int().positive();
const qtyNum = z.coerce.number().positive().max(100000);
const METHODS = ["Cash", "Transfer", "POS Card"];
const PIN_MAX_FAILS = 5;

export const DEFAULT_PROFILE = { name: "Blades & Butchers", tagline: "From Ranch to Retail", address: "", phone: "", email: "", tin: "", receiptFooter: "Thank you for shopping with us!", scaleLabel: "weight" };
/**
 * Cashiers never open a till and managers set nothing up: the first sale records a till session for that cashier behind the
 * scenes (no float — change money stays outside the system). End day is a blind count of the cash taken.
 */
export async function autoOpenTill(db, userId, at = null) {
  await db.query("SELECT pg_advisory_xact_lock(7710, $1)", [userId]); // two first sales at once can't open two tills
  const cur = await openTill(db, userId);
  if (cur) return cur;
  const n = (await db.query("SELECT nextval('till_code_seq') AS n")).rows[0].n;
  const t = (await db.query("INSERT INTO till_sessions (code, user_id, opening_float, opened_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now())) RETURNING *",
    [`TILL-${n}`, userId, 0, at])).rows[0];
  await audit(db, userId, `Started selling (${t.code})`, "first sale of the day");
  return t;
}

export async function businessProfile(db = { query }) {
  const r = (await db.query("SELECT value FROM settings WHERE key = 'business_profile'")).rows[0];
  return { ...DEFAULT_PROFILE, ...(r?.value || {}) };
}

const discountSchema = z.object({ type: z.enum(["pct", "amount"]), value: z.coerce.number().min(0).max(1e9) });
const discountAmount = (d, base) => (!d || !d.value ? 0 : Math.min(base, d.type === "pct" ? Math.round((base * Math.min(d.value, 100)) / 100) : Math.round(d.value)));

/** The most discount (as % of the ticket before discount) this user can give or approve. */
async function discountAuthority(db, roles) {
  if (can(roles, UNLIMITED_APPROVER)) return 100;
  if (!can(roles, "pos.discount")) return 0;
  return (await approvalLimits(db)).discountPct;
}

/** Record one tender against an order. */
export async function recordPayment(db, { orderId, method, amount, tendered = null, ref = null, tillId = null, userId }) {
  await db.query("INSERT INTO order_payments (order_id, method, amount, tendered, ref, till_session_id, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [orderId, method, amount, tendered, ref, tillId, userId]);
}


const lineSchema = z.object({
  sku: z.string().min(1), qty: qtyNum, scale: z.boolean().optional(),
  discount: discountSchema.optional(),
  price: z.coerce.number().int().min(0).max(1e9).optional(),       // offline only: the price the till charged
});
export const saleSchema = z.object({
  clientRef: z.string().trim().min(8).max(64).optional(),
  customerId: id.nullable().optional(),
  items: z.array(lineSchema).min(1).max(100),
  discount: discountSchema.optional(),                               // whole-ticket discount, after line discounts
  discountReason: z.string().trim().max(60).optional(),
  overrideToken: z.string().max(2000).optional(),                     // a manager's PIN approval (POST /pos/authorize)
  fulfilment: z.enum(["Walk-in", "Delivery"]).default("Walk-in"),
  area: z.string().trim().max(60).optional(),
  payments: z.array(z.object({
    method: z.enum(METHODS), amount: z.coerce.number().int().positive().max(1e12),
    tendered: z.coerce.number().int().positive().max(1e12).optional(),
    ref: z.string().trim().max(60).optional().or(z.literal("")),
  })).max(6).optional(),
  payLater: z.boolean().optional(),
  // Older clients: a single payment
  paymentStatus: z.enum(["Paid", "Pending"]).optional(),
  paymentMethod: z.enum(METHODS).optional(),
  paymentRef: z.string().trim().max(60).optional().or(z.literal("")),
});

const dupOf = async (clientRef) => {
  const d = (await query("SELECT code, total, change_given, offline_no FROM orders WHERE client_ref = $1", [clientRef])).rows[0];
  return d ? { code: d.code, total: d.total, change: d.change_given, offlineNo: d.offline_no, duplicate: true } : null;
};

/**
 * One sale. `off` = null for a live sale; for an uploaded offline sale { soldAt, offlineNo, tillCode, syncedBy }.
 * Offline sales already happened — the customer paid and left — so instead of refusing, the server records them and
 * flags what a manager should look at: stock the system didn't have, a price that had changed, a discount above
 * the seller's limit, or no till session to put the cash in.
 */
export async function saveSale(seller, b, off) {
  if (b.fulfilment === "Delivery" && !b.area) throw bad("Delivery orders need an area.");
  const payLater = b.payLater ?? b.paymentStatus === "Pending";
  if (b.clientRef) { const d = await dupOf(b.clientRef); if (d) return d; }
  const flags = [];
  const out = await tx(async (db) => {
    let till = null;
    if (!off) {
      till = await autoOpenTill(db, seller.id);
    } else {
      // The seller's till session that was open when the sale was made.
      till = (off.tillCode && (await db.query("SELECT * FROM till_sessions WHERE code = $1 AND user_id = $2", [off.tillCode, seller.id])).rows[0])
        || (await db.query(`SELECT * FROM till_sessions WHERE user_id = $1 AND opened_at <= $2 AND (closed_at IS NULL OR closed_at >= $2)
                            ORDER BY opened_at DESC LIMIT 1`, [seller.id, off.soldAt])).rows[0] || null;
      // None covering the sale: it goes into the till open now, or opens one from the time of the sale.
      if (!till) till = await autoOpenTill(db, seller.id, off.soldAt);
      else if (till.status !== "Open") flags.push(`till ${till.code} was already closed when this was uploaded — its cash-up didn't include this sale`);
    }
    let customer = null;
    if (b.customerId) {
      customer = (await db.query("SELECT * FROM customers WHERE id = $1", [b.customerId])).rows[0];
      if (!customer) { if (!off) throw notFound("Customer not found."); flags.push("customer record no longer exists"); }
    }
    if (b.fulfilment === "Delivery" && !customer) throw bad("Pick a customer for delivery orders.");

    const n = (await db.query("SELECT nextval('order_code_seq') AS n")).rows[0].n;
    const code = `ORD-${n}`;
    const skus = [...new Set(b.items.map((i) => i.sku))].sort();
    // Offline: a product retired since the sale is still recorded — it was sold.
    const prods = (await db.query(`SELECT * FROM products WHERE sku = ANY($1) ${off ? "" : "AND active"} ORDER BY sku FOR UPDATE`, [skus])).rows;
    const bySku = Object.fromEntries(prods.map((p) => [p.sku, p]));

    // 1. Price every line, then line discounts.
    const lines = b.items.map((it) => {
      const p = bySku[it.sku];
      if (!p) throw notFound(`Product ${it.sku} not found.`);
      if (p.unit !== "KG" && !Number.isInteger(it.qty)) throw bad(`${p.name} must be sold in whole ${p.unit.toLowerCase()}s.`);
      const qty = round3(it.qty);
      const price = off && it.price != null ? it.price : p.price;
      if (off && it.price != null && it.price !== p.price) flags.push(`${p.name} sold at ${naira(it.price)} (price now ${naira(p.price)})`);
      const gross = Math.round(qty * price);
      const lineDisc = discountAmount(it.discount, gross);
      return { p, price, qty, gross, discount: lineDisc, scale: p.unit === "KG" && it.scale === true };
    });
    const gross = lines.reduce((s, l) => s + l.gross, 0);
    // 2. Ticket discount, spread across lines in proportion (so refunds give back what was actually paid).
    const afterLines = lines.reduce((s, l) => s + l.gross - l.discount, 0);
    const ticketDisc = discountAmount(b.discount, afterLines);
    if (ticketDisc > 0) {
      let left = ticketDisc;
      lines.forEach((l, i) => {
        const base = l.gross - l.discount;
        const share = i === lines.length - 1 ? left : Math.min(left, Math.round((ticketDisc * base) / afterLines));
        l.discount += share; left -= share;
      });
    }
    const discountTotal = lines.reduce((s, l) => s + l.discount, 0);
    const total = gross - discountTotal;

    // 3. Who authorised the discount?
    let discountBy = null;
    if (discountTotal > 0) {
      if (!b.discountReason || !DISCOUNT_REASONS.includes(b.discountReason)) throw bad("Pick a reason for the discount.");
      const pct = (discountTotal / gross) * 100;
      const own = await discountAuthority(db, seller.roles);
      if (pct <= own + 1e-9) discountBy = seller.id;
      else if (off) {
        discountBy = seller.id;
        flags.push(`${pct.toFixed(1)}% discount is above ${seller.name}'s ${own}% limit and had no manager approval`);
      } else {
        if (!b.overrideToken) {
          throw new HttpError(403, own ? `A ${pct.toFixed(1)}% discount is above your ${own}% limit — a manager must approve it.` : "Discounts need a manager's approval.");
        }
        let c;
        try { c = verifyPurpose(b.overrideToken, "pos-override"); } catch { throw new HttpError(403, "The manager approval has expired — ask again."); }
        if (c.cashier !== seller.id) throw new HttpError(403, "That approval was for another till.");
        if (pct > c.maxPct + 1e-9) throw new HttpError(403, `The approving manager can authorise up to ${c.maxPct}% — this is ${pct.toFixed(1)}%.`);
        discountBy = c.approver;
      }
    }

    // 4. VAT (prices include it).
    for (const l of lines) {
      l.subtotal = l.gross - l.discount;
      l.vat = Number(l.p.vat_rate) || 0;
      l.tax = l.vat ? Math.round((l.subtotal * l.vat) / (100 + l.vat)) : 0;
    }
    const taxTotal = lines.reduce((s, l) => s + l.tax, 0);

    // 5. Tenders.
    let payments = b.payments || [];
    if (!payments.length && !payLater && b.paymentStatus !== "Pending") {
      payments = [{ method: b.paymentMethod ?? "Cash", amount: total, ref: b.paymentRef }]; // legacy single payment
    }
    if (payLater && payments.length) throw bad("A pay-later order can't also take payment now.");
    let change = 0;
    if (!payLater) {
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      if (total === 0 && payments.length) throw bad("Nothing to pay on this ticket.");
      if (paid !== total) throw bad(`Payments (${naira(paid)}) must add up to the total (${naira(total)}).`);
      for (const p of payments) {
        if (p.tendered != null && p.method !== "Cash") throw bad("Only cash has change.");
        if (p.tendered != null && p.tendered < p.amount) throw bad("Cash tendered is less than the amount.");
        change += p.tendered != null ? p.tendered - p.amount : 0;
      }
    }
    const methods = [...new Set(payments.map((p) => p.method))];
    const method = payLater ? (b.paymentMethod ?? null) : methods.length === 1 ? methods[0] : methods.length ? "Split" : null;
    const hasCash = payments.some((p) => p.method === "Cash");
    const firstRef = payments.find((p) => p.method !== "Cash" && p.ref)?.ref || null;
    const paid = !payLater;

    // 6. Stock (counter first, earliest use-by; expired never sold). Offline sales take what the system has.
    for (const l of lines) {
      const r = await allocateStockUpTo(db, { sku: l.p.sku, qty: l.qty, kind: "sale", reference: code, userId: seller.id, allowShort: !!off });
      l.allocations = r.allocations; l.short = r.short;
      if (r.short > 0) flags.push(`${l.p.name}: sold ${round3(r.short)} ${l.p.unit} more than the system showed — count it`);
    }
    const at = off ? off.soldAt : null;
    const isDelivery = b.fulfilment === "Delivery";
    const { rows } = await db.query(
      `INSERT INTO orders (code, customer_id, channel, status, payment_status, payment_method, total, area, user_id, till_session_id, cash_session_id,
         paid_at, payment_ref, gross_total, discount_total, discount_reason, discount_by, tax_total, change_given, client_ref,
         created_at, offline_no, synced_at, synced_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $5 = 'Paid' THEN COALESCE($20::timestamptz, now()) END, $12,$13,$14,$15,$16,$17,$18,$19,
         COALESCE($20::timestamptz, now()), $21, $22, $23) RETURNING id`,
      [code, customer?.id ?? null, isDelivery ? "Delivery" : "POS", isDelivery ? "Confirmed" : "Delivered",
       paid ? "Paid" : "Pending", method, total, isDelivery ? b.area : "Walk-in", seller.id, till?.id ?? null, hasCash ? till?.id ?? null : null,
       firstRef, gross, discountTotal, discountTotal ? b.discountReason : null, discountBy, taxTotal, change, b.clientRef ?? null,
       at, off?.offlineNo ?? null, off ? new Date() : null, off ? off.syncedBy.id : null]);
    const orderId = rows[0].id;
    for (const l of lines) {
      await db.query(
        `INSERT INTO order_items (order_id, product_sku, qty, unit_price, subtotal, allocations, scale_weighed, discount, vat_rate, tax, offline_short)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [orderId, l.p.sku, l.qty, l.price, l.subtotal, JSON.stringify(l.allocations), l.scale, l.discount, l.vat, l.tax, l.short || 0]);
    }
    for (const p of payments) {
      await db.query("INSERT INTO order_payments (order_id, method, amount, tendered, ref, till_session_id, user_id, paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))",
        [orderId, p.method, p.amount, p.method === "Cash" ? (p.tendered ?? p.amount) : null, p.method === "Cash" ? null : p.ref || null, till?.id ?? null, seller.id, at]);
    }
    const tenders = payments.map((p) => `${p.method} ${naira(p.amount)}`).join(" + ");
    const label = off ? `Offline sale ${code} (${off.offlineNo})` : `Sale ${code}`;
    await audit(db, seller.id, label, `${naira(total)} · ${customer?.name ?? "Walk-in"} · ${paid ? tenders : "Pending"}${change ? ` · change ${naira(change)}` : ""}${off ? ` · sold ${fmtDateTime(at)}, uploaded by ${off.syncedBy.name}` : ""}`);
    if (discountTotal) {
      await audit(db, discountBy, `Discount on ${code}`, `${naira(discountTotal)} (${((discountTotal / gross) * 100).toFixed(1)}%) · ${b.discountReason}${discountBy !== seller.id ? ` · approved for ${seller.name}` : ""}`);
    }
    if (flags.length) {
      await db.query("UPDATE orders SET offline_flags = $2 WHERE id = $1", [orderId, flags.join("; ")]);
      await audit(db, seller.id, `Offline sale ${code} needs a look`, flags.join("; "));
    }
    return { code, total, gross, discount: discountTotal, tax: taxTotal, change, paymentMethod: method, offlineNo: off?.offlineNo, flags };
  }).catch((e) => {
    // Two taps racing with the same clientRef: the loser reports the winner's sale.
    if (e.code === "23505" && b.clientRef) return null;
    throw e;
  });
  return out ?? (await dupOf(b.clientRef));
}

export function posRoutes(r) {
  /* ---------------------------------------------------------- the sale */
  r.post("/sales", requirePerm("pos.use"), ah(async (req, res) => {
    const b = parse(saleSchema, req.body);
    const out = await saveSale(req.user, b, null);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  /**
   * Sales made while the till had no internet, uploaded when it's back. Each keeps the time it was made, the till session
   * that was open, the price the customer was charged and the receipt number printed (e.g. T1-000123).
   * Uploaded by the seller, or by a manager on their behalf (when the seller has gone home).
   */
  r.post("/pos/offline-sales", requirePerm("pos.use"), ah(async (req, res) => {
    const b = parse(saleSchema.extend({
      clientRef: z.string().trim().min(8).max(64),
      offlineNo: z.string().trim().min(2).max(30),
      soldAt: z.string().datetime({ offset: true }),
      sellerId: id,
      tillCode: z.string().trim().max(30).optional().nullable(),
    }), req.body);
    const soldAt = new Date(b.soldAt);
    if (soldAt.getTime() > Date.now() + 10 * 60e3) throw bad("That sale is dated in the future — check the till's clock.");
    if (soldAt.getTime() < Date.now() - 14 * 864e5) throw bad("Offline sales older than 14 days can't be uploaded — a manager must enter them.");
    let seller = req.user;
    if (b.sellerId !== req.user.id) {
      if (!can(req.user.roles, "till.review")) throw new HttpError(403, "Only the seller or a manager can upload these sales.");
      seller = (await query("SELECT * FROM users WHERE id = $1", [b.sellerId])).rows[0];
      if (!seller) throw notFound("The seller's account no longer exists.");
      seller.roles = [seller.role, ...(seller.extra_roles || [])];
    }
    const out = await saveSale(seller, b, { soldAt, offlineNo: b.offlineNo, tillCode: b.tillCode, syncedBy: req.user });
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  /* ---------------------------------------------------------- manager override (PIN) */
  r.post("/pos/authorize", requirePerm("pos.use"), ah(async (req, res) => {
    const b = parse(z.object({ email: z.string().trim().email(), pin: z.string().regex(/^\d{4,6}$/, "4–6 digits"), pct: z.coerce.number().min(0).max(100) }), req.body);
    const out = await tx(async (db) => {
      const m = (await db.query("SELECT * FROM users WHERE lower(email) = lower($1) AND active FOR UPDATE", [b.email])).rows[0];
      const roles = m ? [m.role, ...(m.extra_roles || [])] : [];
      if (!m || !m.pos_pin_hash || !can(roles, "pos.discount")) throw new HttpError(403, "That person can't approve discounts, or hasn't set a till PIN.");
      if (m.id === req.user.id) throw new HttpError(403, "Another manager must approve — not the person selling.");
      if (m.pos_pin_locked_until && new Date(m.pos_pin_locked_until) > new Date()) throw new HttpError(429, "Too many wrong PINs — this manager's PIN is locked for 15 minutes.");
      if (!(await bcrypt.compare(b.pin, m.pos_pin_hash))) {
        const fails = m.pos_pin_fails + 1;
        const lock = fails >= PIN_MAX_FAILS;
        await db.query("UPDATE users SET pos_pin_fails = $2, pos_pin_locked_until = $3 WHERE id = $1",
          [m.id, lock ? 0 : fails, lock ? new Date(Date.now() + 15 * 60e3) : null]);
        await audit(db, req.user.id, "Wrong manager PIN at the till", `for ${m.name}${lock ? " · PIN locked 15 min" : ""}`);
        return { error: lock ? "Wrong PIN — locked for 15 minutes." : "Wrong PIN." };
      }
      await db.query("UPDATE users SET pos_pin_fails = 0, pos_pin_locked_until = NULL WHERE id = $1", [m.id]);
      const maxPct = await discountAuthority(db, roles);
      if (b.pct > maxPct + 1e-9) throw new HttpError(403, `${m.name} can approve up to ${maxPct}% — this is ${b.pct.toFixed(1)}%. Ask the Owner or MD.`);
      return { token: signPurpose({ purpose: "pos-override", approver: m.id, cashier: req.user.id, maxPct }, "10m"), approver: m.name, maxPct };
    });
    if (out.error) throw new HttpError(403, out.error);
    res.json(out);
  }));

  r.post("/auth/pos-pin", requirePerm("pos.discount"), ah(async (req, res) => {
    const b = parse(z.object({ password: z.string().min(1), pin: z.string().regex(/^\d{4,6}$/, "must be 4–6 digits") }), req.body);
    if (weakPin(b.pin)) throw bad("Pick a PIN that isn't one digit repeated or a straight run (like 1234).");
    if (!(await bcrypt.compare(b.password, req.user.password_hash))) throw bad("Current password is incorrect.");
    await query("UPDATE users SET pos_pin_hash = $2, pos_pin_fails = 0, pos_pin_locked_until = NULL WHERE id = $1", [req.user.id, await bcrypt.hash(b.pin, 10)]);
    await audit(null, req.user.id, "Set till approval PIN", null);
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------------- held (parked) tickets */
  const cartLine = z.object({ sku: z.string().min(1), qty: qtyNum, scale: z.boolean().optional(), discount: discountSchema.optional() });
  r.post("/pos/held", requirePerm("pos.use"), ah(async (req, res) => {
    const b = parse(z.object({
      label: z.string().trim().max(40).optional().or(z.literal("")),
      customerId: id.nullable().optional(),
      cart: z.object({ items: z.array(cartLine).min(1).max(100), discount: discountSchema.optional(), discountReason: z.string().max(60).optional() }),
      total: z.coerce.number().int().min(0).max(1e12),
    }), req.body);
    const count = (await query("SELECT count(*)::int AS n FROM pos_held")).rows[0].n;
    if (count >= 50) throw conflict("50 tickets are already on hold — recall or clear some first.");
    const label = b.label || `Ticket ${new Date(Date.now() + 3600e3).toISOString().slice(11, 16)}`;
    const row = (await query("INSERT INTO pos_held (label, customer_id, cart, total, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [label, b.customerId ?? null, JSON.stringify(b.cart), b.total, req.user.id])).rows[0];
    res.status(201).json({ id: row.id, label });
  }));

  /** Recall = take it off hold (returns the cart). Any till may recall a parked ticket. */
  r.post("/pos/held/:id/recall", requirePerm("pos.use"), ah(async (req, res) => {
    const row = (await query("DELETE FROM pos_held WHERE id = $1 RETURNING *", [req.params.id])).rows[0];
    if (!row) throw notFound("That ticket was already recalled on another till.");
    res.json({ label: row.label, customerId: row.customer_id, cart: row.cart });
  }));

  /** Clearing a ticket that had items is logged (loss prevention). */
  r.post("/pos/void", requirePerm("pos.use"), ah(async (req, res) => {
    const b = parse(z.object({ lines: z.coerce.number().int().min(1).max(100), value: z.coerce.number().int().min(0).max(1e12),
      reason: z.string().trim().max(60).optional() }), req.body);
    const till = await openTill({ query }, req.user.id);
    if (till) await query("UPDATE till_sessions SET voided_tickets = voided_tickets + 1, voided_value = voided_value + $2 WHERE id = $1", [till.id, b.value]);
    await audit(null, req.user.id, "Cleared a ticket", `${b.lines} line${b.lines === 1 ? "" : "s"} · ${naira(b.value)}${b.reason ? ` · ${b.reason}` : ""}${till ? ` · ${till.code}` : ""}`);
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------------- X / Z report */
  r.get("/till/:code/report", requireAuth, ah(async (req, res) => {
    const s = (await query(`SELECT t.*, u.name AS cashier FROM till_sessions t JOIN users u ON u.id = t.user_id WHERE t.code = $1`, [req.params.code])).rows[0];
    if (!s) throw notFound("Till session not found.");
    const reviewer = can(req.user.roles, "till.review");
    const mine = s.user_id === req.user.id;
    if (!reviewer && !mine) throw new HttpError(403, "You can only see your own till's report.");
    if (!reviewer && s.status === "Open") throw new HttpError(403, "Your Z report is ready once the till is closed (blind count).");
    const sum = await tillSummary({ query }, s);
    const [refunds, discounts, top] = await Promise.all([
      query(`SELECT method, count(*)::int AS n, COALESCE(sum(amount), 0) AS amount FROM refunds WHERE till_session_id = $1 AND status = 'Approved' GROUP BY method`, [s.id]),
      query(`SELECT discount_reason AS reason, count(*)::int AS n, COALESCE(sum(discount_total), 0) AS amount FROM orders
             WHERE till_session_id = $1 AND status <> 'Cancelled' AND discount_total > 0 GROUP BY discount_reason ORDER BY amount DESC`, [s.id]),
      query(`SELECT p.name, p.unit, sum(oi.qty) AS qty, sum(oi.subtotal) AS amount FROM order_items oi JOIN orders o ON o.id = oi.order_id
             JOIN products p ON p.sku = oi.product_sku WHERE o.till_session_id = $1 AND o.status <> 'Cancelled'
             GROUP BY p.name, p.unit ORDER BY amount DESC LIMIT 10`, [s.id]),
    ]);
    const showCash = reviewer || s.status !== "Open";
    res.json({
      type: s.status === "Open" ? "X" : "Z", code: s.code, cashier: s.cashier, status: s.status,
      openedAt: fmtDateTime(s.opened_at), closedAt: s.closed_at ? fmtDateTime(s.closed_at) : null, printedAt: fmtDateTime(new Date()),
      sales: { count: sum.sales.n, gross: sum.sales.gross, discounts: sum.sales.discounts, net: sum.sales.net, tax: sum.sales.tax },
      tenders: sum.byMethod, changeGiven: sum.sales.change,
      refunds: refunds.rows, discountsByReason: discounts.rows, topItems: top.rows.map((t) => ({ ...t, qty: round3(t.qty) })),
      voided: { tickets: s.voided_tickets, value: s.voided_value },
      cash: showCash ? { float: sum.float, cashIn: sum.cashIn, cashOut: sum.cashOut, expected: sum.expected,
        counted: s.counted_cash, variance: s.variance } : null,
    });
  }));

  /* ---------------------------------------------------------- receipt header */
  r.patch("/settings/business", requirePerm("setup.manage"), ah(async (req, res) => {
    const t = (n) => z.string().trim().max(n).optional();
    const b = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), tagline: t(80), address: t(160), phone: t(40), email: t(80),
      tin: t(30), receiptFooter: t(200), scaleLabel: z.enum(["weight", "price"]).optional() }), req.body);
    const cur = await businessProfile();
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    await query("INSERT INTO settings (key, value) VALUES ('business_profile', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(next)]);
    const ch = Object.keys(next).filter((k) => next[k] !== cur[k]);
    if (ch.length) await audit(null, req.user.id, "Updated receipt details", ch.join(", "));
    res.json(next);
  }));
}

/* ================================================================== state */
export async function posState(user) {
  const [held, profile, limits] = await Promise.all([
    query(`SELECT h.id, h.label, h.total, h.created_at, h.cart, c.name AS customer, u.name AS who FROM pos_held h
           LEFT JOIN customers c ON c.id = h.customer_id JOIN users u ON u.id = h.user_id ORDER BY h.created_at`),
    businessProfile(),
    approvalLimits(),
  ]);
  return {
    held: held.rows.map((h) => ({ id: h.id, label: h.label, total: h.total, customer: h.customer, who: h.who, at: fmtDateTime(h.created_at), lines: h.cart.items.length })),
    profile,
    discountReasons: DISCOUNT_REASONS,
    myDiscountPct: can(user.roles, UNLIMITED_APPROVER) ? 100 : can(user.roles, "pos.discount") ? limits.discountPct : 0,
  };
}
