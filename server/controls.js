// Maker-checker controls: stock write-offs / count corrections and refunds.
//
//   request  → by staff with *.request (Storekeeper, Cashier, Operations Manager)
//   approve  → by MGMT with *.approve — never the person who requested it
//   direct   → Owner / MD only: posted at once, recorded as approved by themselves
//
// Nothing moves (no stock, no money) until a request is approved, and approval re-checks
// everything inside the same transaction that posts it.
import { z } from "zod";
import { tx } from "./db.js";
import { addStock, removeStock, returnAllocations } from "./stock.js";
import { openTill, approvalLimits } from "./operations.js";
import { can, WASTAGE_REASONS, CORRECTION_REASONS, REFUND_REASONS, RESTOCK_REASON } from "../src/shared/permissions.js";
import { ah, parse, audit, bad, notFound, conflict, HttpError, round3 } from "./util.js";

const naira = (n) => `₦${Math.round(n).toLocaleString("en-NG")}`;
const lagosDay = (d) => new Date(new Date(d).getTime() + 3600e3).toISOString().slice(0, 10);

/* ============================================================ stock adjustments */

const adjustSchema = z.object({
  sku: z.string().min(1),
  location: z.string().min(1),
  kind: z.enum(["wastage", "correction"]),
  qty: z.coerce.number().refine((v) => v !== 0 && Math.abs(v) <= 1e6, "must be a non-zero amount"),
  reason: z.string().min(1),
  note: z.string().trim().min(3, "explain what happened (at least 3 characters)").max(200),
  lotId: z.coerce.number().int().positive().optional(),   // write off one specific batch
});

async function postAdjustment(db, adj, userId) {
  const delta = adj.kind === "wastage" ? -adj.qty : adj.qty;
  const args = { sku: adj.product_sku, locationId: adj.location_id, kind: adj.kind, reference: adj.code, note: `${adj.reason} · ${adj.note ?? ""}`.trim(), userId };
  if (delta > 0) {
    const loc = (await db.query("SELECT active, name FROM storage_locations WHERE id = $1", [adj.location_id])).rows[0];
    if (!loc.active) throw conflict(`${loc.name} has been retired since this was requested.`);
    await addStock(db, { ...args, qty: delta });
  } else {
    await removeStock(db, { ...args, qty: -delta, lotId: adj.lot_id ?? undefined }); // throws 409 if the stock is no longer there
  }
}

/** POST /inventory/adjust with kind wastage|correction lands here. */
export async function requestAdjustment(req) {
  const b = parse(adjustSchema, req.body);
  return tx((db) => createAdjustment(db, req.user, b));
}

/** Create a write-off / correction (request, or direct post for Owner/MD). Also used by stock counts. */
export async function createAdjustment(db, user, b, { allowCounter = false } = {}) {
  const roles = user.roles;
  const direct = can(roles, "stock.adjust.direct");
  if (!direct && !can(roles, "stock.adjust.request") && !allowCounter) throw new HttpError(403, "Your role can't write off or correct stock.");
  const reasons = b.kind === "wastage" ? WASTAGE_REASONS : CORRECTION_REASONS;
  if (!reasons.includes(b.reason)) throw bad(`Pick a ${b.kind === "wastage" ? "write-off" : "correction"} reason.`);
  if (b.kind === "wastage" && b.qty < 0) throw bad("Enter the amount lost as a positive number.");
  const req = { user };
  {
    const loc = (await db.query("SELECT id, name, active FROM storage_locations WHERE name = $1", [b.location])).rows[0];
    if (!loc) throw bad("Unknown storage location.");
    const p = (await db.query("SELECT sku, name, unit, cost_price FROM products WHERE sku = $1 AND active", [b.sku])).rows[0];
    if (!p) throw notFound("Product not found.");
    if (p.unit !== "KG" && !Number.isInteger(b.qty)) throw bad(`${p.unit} items must be whole numbers.`);
    const delta = b.kind === "wastage" ? -b.qty : b.qty;
    if (delta > 0 && !loc.active) throw conflict(`${loc.name} is retired.`);
    if (b.lotId) {
      const lot = (await db.query("SELECT * FROM stock_lots WHERE id = $1 AND product_sku = $2 AND location_id = $3", [b.lotId, p.sku, loc.id])).rows[0];
      if (!lot) throw bad("That batch isn't held at this location.");
      if (delta > 0) throw bad("Pick a batch only when removing stock.");
      if (lot.qty + 1e-9 < -delta) throw conflict(`Only ${round3(lot.qty)} ${p.unit} left in batch ${lot.lot_code}.`);
    } else if (delta < 0) {
      const have = (await db.query("SELECT qty FROM stock WHERE product_sku = $1 AND location_id = $2", [p.sku, loc.id])).rows[0]?.qty ?? 0;
      if (have + 1e-9 < -delta) throw conflict(`Only ${round3(have)} ${p.unit} of ${p.name} is recorded at ${loc.name}.`);
    }
    const n = (await db.query("SELECT nextval('adjustment_code_seq') AS n")).rows[0].n;
    const code = `ADJ-${n}`;
    const value = Math.round(Math.abs(b.qty) * p.cost_price);
    const { rows } = await db.query(
      `INSERT INTO stock_adjustments (code, product_sku, location_id, kind, qty, reason, note, value_at_cost, status, requested_by, decided_by, decided_at, decision_note, lot_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [code, p.sku, loc.id, b.kind, round3(b.qty), b.reason, b.note, value, direct ? "Approved" : "Pending", req.user.id,
       direct ? req.user.id : null, direct ? new Date() : null, direct ? "Posted directly (leadership)" : null, b.lotId ?? null]
    );
    const what = `${b.kind === "wastage" ? "write-off" : "correction"} of ${delta > 0 ? "+" : "−"}${Math.abs(b.qty)} ${p.unit} ${p.name}`;
    if (direct) {
      await postAdjustment(db, rows[0], req.user.id);
      await audit(db, req.user.id, `Posted ${code}: ${what}`, `${loc.name} · ${b.reason} · ${naira(value)} at cost`);
    } else {
      await audit(db, req.user.id, `Requested ${code}: ${what}`, `${loc.name} · ${b.reason} · awaiting approval`);
    }
    return { code, status: rows[0].status, name: p.name, value };
  }
}

/* ============================================================ refunds */

const refundSchema = z.object({
  order: z.string().min(1),
  items: z.array(z.object({ itemId: z.coerce.number().int().positive(), qty: z.coerce.number().positive().max(1e6) })).min(1).max(50),
  reason: z.enum(REFUND_REASONS),
  method: z.enum(["Cash", "Transfer", "POS Card"]),
  note: z.string().trim().min(3, "explain what happened (at least 3 characters)").max(200),
});

async function applyRefund(db, refund, userId) {
  const lines = (await db.query(
    `SELECT ri.order_item_id AS id, ri.qty, ri.amount FROM refund_items ri WHERE ri.refund_id = $1 ORDER BY ri.order_item_id`, [refund.id])).rows;
  for (const l of lines) {
    const it = (await db.query("SELECT * FROM order_items WHERE id = $1 FOR UPDATE", [l.id])).rows[0];
    if (it.refunded_qty + l.qty > it.qty + 1e-9) throw conflict("Part of this refund has already been refunded.");
    await db.query("UPDATE order_items SET refunded_qty = refunded_qty + $2, refunded_amount = refunded_amount + $3 WHERE id = $1", [it.id, l.qty, l.amount]);
    if (refund.restock) {
      // Goods never left the counter: put them back into the exact batches the sale took them from.
      await returnAllocations(db, { sku: it.product_sku, allocations: it.allocations, qty: l.qty, kind: "return", reference: refund.code, note: "Refund — rung up in error", userId });
    }
  }
  await db.query("UPDATE orders SET refunded = refunded + $2, updated_at = now() WHERE id = $1", [refund.order_id, refund.amount]);
}

/* ============================================================ routes */

export function controlRoutes(r) {
  r.post("/refunds", ah(async (req, res) => {
    if (!req.user) throw new HttpError(401, "Please sign in.");
    const roles = req.user.roles;
    const direct = can(roles, "refunds.direct");
    if (!direct && !can(roles, "refunds.request")) throw new HttpError(403, "Your role can't issue refunds.");
    const b = parse(refundSchema, req.body);
    const out = await tx(async (db) => {
      const o = (await db.query("SELECT * FROM orders WHERE code = $1 FOR UPDATE", [b.order])).rows[0];
      if (!o) throw notFound("Order not found.");
      if (o.status !== "Delivered") throw conflict("Only delivered orders can be refunded — cancel an undelivered order instead.");
      if (o.payment_status !== "Paid") throw conflict("This order hasn't been paid, so there's nothing to refund.");
      const restock = b.reason === RESTOCK_REASON;
      if (restock && (o.channel !== "POS" || lagosDay(o.created_at) !== lagosDay(Date.now()))) {
        throw bad("\"Rung up in error\" only applies to a counter sale on the same day. Returned meat can't go back on sale — pick another reason.");
      }
      let till = null;
      if (b.method === "Cash") {
        till = await openTill(db, req.user.id);
        if (!till) throw conflict("Open your till to pay a cash refund, or refund by Transfer or POS Card.");
      }
      let amount = 0;
      const lines = [];
      for (const it of b.items) {
        const row = (await db.query(
          `SELECT oi.*, p.name, p.unit, COALESCE((SELECT sum(ri.qty) FROM refund_items ri JOIN refunds rf ON rf.id = ri.refund_id
             WHERE ri.order_item_id = oi.id AND rf.status = 'Pending'), 0) AS pending,
             COALESCE((SELECT sum(ri.amount) FROM refund_items ri JOIN refunds rf ON rf.id = ri.refund_id
             WHERE ri.order_item_id = oi.id AND rf.status = 'Pending'), 0) AS pending_amount
           FROM order_items oi JOIN products p ON p.sku = oi.product_sku WHERE oi.id = $1 AND oi.order_id = $2`, [it.itemId, o.id])).rows[0];
        if (!row) throw bad("That item isn't on this order.");
        if (row.unit !== "KG" && !Number.isInteger(it.qty)) throw bad(`${row.name} is refunded in whole ${row.unit.toLowerCase()}s.`);
        const left = round3(row.qty - row.refunded_qty - row.pending);
        if (it.qty > left + 1e-9) throw conflict(`Only ${left} ${row.unit} of ${row.name} can still be refunded.`);
        // Refund what was actually paid (after discounts). The last of a line refunds exactly what's left, so pennies never drift.
        const amt = it.qty >= left - 1e-9 ? row.subtotal - row.refunded_amount - row.pending_amount : Math.round((it.qty * row.subtotal) / row.qty);
        amount += amt;
        lines.push({ id: row.id, qty: round3(it.qty), amount: amt, name: row.name, unit: row.unit });
      }
      if (amount <= 0) throw bad("Nothing to refund.");
      const n = (await db.query("SELECT nextval('refund_code_seq') AS n")).rows[0].n;
      const code = `RF-${n}`;
      const { rows } = await db.query(
        `INSERT INTO refunds (code, order_id, amount, reason, restock, method, note, status, requested_by, decided_by, decided_at, decision_note, till_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [code, o.id, amount, b.reason, restock, b.method, b.note, direct ? "Approved" : "Pending", req.user.id,
         direct ? req.user.id : null, direct ? new Date() : null, direct ? "Issued directly (leadership)" : null, till?.id ?? null]
      );
      for (const l of lines) {
        await db.query("INSERT INTO refund_items (refund_id, order_item_id, qty, amount) VALUES ($1,$2,$3,$4)", [rows[0].id, l.id, l.qty, l.amount]);
      }
      const what = lines.map((l) => `${l.qty} ${l.unit} ${l.name}`).join(", ");
      if (direct) {
        await applyRefund(db, rows[0], req.user.id);
        await audit(db, req.user.id, `Refunded ${naira(amount)} on ${o.code} (${code})`, `${what} · ${b.reason} · ${b.method}${restock ? " · restocked" : " · written off"}`);
      } else {
        await audit(db, req.user.id, `Requested refund ${code} on ${o.code}`, `${naira(amount)} · ${what} · ${b.reason} · awaiting approval`);
      }
      return { code, amount, status: rows[0].status };
    });
    res.status(201).json(out);
  }));

  /** One decision endpoint for both kinds of request. */
  const decide = (kind) => ah(async (req, res) => {
    if (!req.user) throw new HttpError(401, "Please sign in.");
    const b = parse(z.object({
      decision: z.enum(["approve", "reject", "cancel"]),
      note: z.string().trim().max(200).optional(),
    }), req.body);
    const table = kind === "adjustment" ? "stock_adjustments" : "refunds";
    const out = await tx(async (db) => {
      const x = (await db.query(`SELECT * FROM ${table} WHERE code = $1 FOR UPDATE`, [req.params.code])).rows[0];
      if (!x) throw notFound("Request not found.");
      if (x.status !== "Pending") throw conflict(`This request was already ${x.status.toLowerCase()}.`);

      if (b.decision === "cancel") {
        if (x.requested_by !== req.user.id) throw new HttpError(403, "Only the person who made the request can withdraw it.");
      } else {
        if (!can(req.user.roles, kind === "adjustment" ? "stock.adjust.approve" : "refunds.approve")) {
          throw new HttpError(403, "Your role can't approve this.");
        }
        if (x.requested_by === req.user.id) throw new HttpError(403, "You can't approve or reject your own request — another manager has to.");
        if (b.decision === "reject" && !(b.note && b.note.length >= 3)) throw bad("Give a reason for rejecting it.");
        // Approval limits: above the limit only the Owner or MD can approve.
        if (b.decision === "approve" && !can(req.user.roles, kind === "adjustment" ? "stock.adjust.direct" : "refunds.direct")) {
          const limits = await approvalLimits(db);
          const value = kind === "adjustment" ? x.value_at_cost : x.amount;
          const limit = kind === "adjustment" ? limits.adjustment : limits.refund;
          if (value > limit) throw new HttpError(403, `${naira(value)} is above your ${naira(limit)} approval limit — the Owner or MD must approve it.`);
        }
      }

      const status = { approve: "Approved", reject: "Rejected", cancel: "Cancelled" }[b.decision];
      if (b.decision === "approve") {
        if (kind === "adjustment") await postAdjustment(db, x, req.user.id);
        else await applyRefund(db, x, req.user.id);
      }
      await db.query(`UPDATE ${table} SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
        [x.id, status, req.user.id, b.note || null]);
      const label = kind === "adjustment" ? `stock ${x.kind === "wastage" ? "write-off" : "correction"}` : "refund";
      const money = kind === "adjustment" ? `${naira(x.value_at_cost)} at cost` : naira(x.amount);
      await audit(db, req.user.id, `${status} ${label} ${x.code}`, `${money}${b.note ? ` · ${b.note}` : ""}`);
      return { code: x.code, status };
    });
    res.json(out);
  });

  r.post("/approvals/adjustments/:code", decide("adjustment"));
  r.post("/approvals/refunds/:code", decide("refund"));
}
