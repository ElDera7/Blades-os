// Day-to-day operational controls:
//   • Till sessions — open with a float, close with a blind cash count, reviewed by another manager
//   • Cold-chain temperature log — readings per location against its safe range
//   • Blind stock counts — counted without seeing the system figure; variances become correction requests
//   • Batch trace — where a batch went (for recalls)
//   • Approval limits — how much an Operations Manager may approve
import { z } from "zod";
import { query, tx } from "./db.js";
import { requirePerm } from "./auth.js";
import { createAdjustment } from "./controls.js";
import { can } from "../src/shared/permissions.js";
import { ah, parse, audit, bad, notFound, conflict, HttpError, round3, fmtDate, fmtDateTime } from "./util.js";

const naira = (n) => `₦${Math.round(n).toLocaleString("en-NG")}`;
const money = z.coerce.number().int().min(0).max(1e12);
const lagosToday = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);

export const DEFAULT_LIMITS = { adjustment: 50000, refund: 50000, tillVariance: 5000, purchase: 500000, paymentVariance: 5000, discountPct: 10 };
export async function approvalLimits(db = { query }) {
  const r = (await db.query("SELECT value FROM settings WHERE key = 'approval_limits'")).rows[0];
  return { ...DEFAULT_LIMITS, ...(r?.value || {}) };
}

export async function openTill(db, userId) {
  return (await db.query("SELECT * FROM till_sessions WHERE user_id = $1 AND status = 'Open'", [userId])).rows[0] ?? null;
}

/** What should be in the drawer, and the session's takings by payment method. */
export async function tillSummary(db, session) {
  const [cash, methods, refunds, pending, sales] = await Promise.all([
    db.query(`SELECT COALESCE(sum(p.amount), 0) AS v FROM order_payments p JOIN orders o ON o.id = p.order_id
              WHERE p.till_session_id = $1 AND p.method = 'Cash' AND o.status <> 'Cancelled'`, [session.id]),
    db.query(`SELECT p.method, count(DISTINCT p.order_id)::int AS orders, COALESCE(sum(p.amount), 0) AS amount FROM order_payments p
              JOIN orders o ON o.id = p.order_id WHERE p.till_session_id = $1 AND o.status <> 'Cancelled' GROUP BY p.method ORDER BY p.method`, [session.id]),
    db.query("SELECT COALESCE(sum(amount), 0) AS v FROM refunds WHERE till_session_id = $1 AND status = 'Approved' AND method = 'Cash'", [session.id]),
    db.query("SELECT count(*)::int AS n FROM refunds WHERE till_session_id = $1 AND status = 'Pending'", [session.id]),
    db.query(`SELECT count(*)::int AS n, COALESCE(sum(gross_total), 0) AS gross, COALESCE(sum(discount_total), 0) AS discounts,
                COALESCE(sum(total), 0) AS net, COALESCE(sum(tax_total), 0) AS tax, COALESCE(sum(change_given), 0) AS change
              FROM orders WHERE till_session_id = $1 AND status <> 'Cancelled'`, [session.id]),
  ]);
  const cashIn = cash.rows[0].v, cashOut = refunds.rows[0].v;
  return {
    float: session.opening_float, cashIn, cashOut, expected: session.opening_float + cashIn - cashOut,
    byMethod: methods.rows, pendingCashRefunds: pending.rows[0].n, sales: sales.rows[0],
  };
}

export function operationRoutes(r) {
  /* ============================================================ till sessions */
  r.post("/till/open", requirePerm("till.use"), ah(async (req, res) => {
    const b = parse(z.object({ float: money }), req.body);
    const out = await tx(async (db) => {
      if (await openTill(db, req.user.id)) throw conflict("Your till is already open.");
      const n = (await db.query("SELECT nextval('till_code_seq') AS n")).rows[0].n;
      const code = `TILL-${n}`;
      await db.query("INSERT INTO till_sessions (code, user_id, opening_float) VALUES ($1,$2,$3)", [code, req.user.id, b.float]);
      await audit(db, req.user.id, `Opened till ${code}`, `float ${naira(b.float)}`);
      return { code };
    });
    res.status(201).json(out);
  }));

  r.post("/till/close", requirePerm("till.use"), ah(async (req, res) => {
    const b = parse(z.object({ counted: money, note: z.string().trim().max(200).optional() }), req.body);
    const out = await tx(async (db) => {
      const s = (await db.query("SELECT * FROM till_sessions WHERE user_id = $1 AND status = 'Open' FOR UPDATE", [req.user.id])).rows[0];
      if (!s) throw conflict("You don't have an open till.");
      const sum = await tillSummary(db, s);
      if (sum.pendingCashRefunds) throw conflict(`${sum.pendingCashRefunds} cash refund${sum.pendingCashRefunds === 1 ? " is" : "s are"} still awaiting approval — get ${sum.pendingCashRefunds === 1 ? "it" : "them"} approved or withdrawn before closing.`);
      const variance = b.counted - sum.expected;
      await db.query(
        "UPDATE till_sessions SET status = 'Closed', closed_at = now(), counted_cash = $2, expected_cash = $3, variance = $4, close_note = $5 WHERE id = $1",
        [s.id, b.counted, sum.expected, variance, b.note || null]
      );
      await audit(db, req.user.id, `Closed till ${s.code}`, `counted ${naira(b.counted)} · expected ${naira(sum.expected)} · ${variance === 0 ? "balanced" : `${variance > 0 ? "over" : "short"} ${naira(Math.abs(variance))}`}`);
      return { code: s.code, counted: b.counted, expected: sum.expected, variance };
    });
    res.json(out);
  }));

  /**
   * Daily sales by cashier (managers): what each person sold on a day, how they were paid, refunds against their sales,
   * and their End day count. Sales are counted by the day they were made (Lagos time), whatever the till session.
   */
  r.get("/reports/cashiers", requirePerm("till.review"), ah(async (req, res) => {
    if (req.query.day && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day))) throw bad("Pick a valid day.");
    const day = req.query.day ? String(req.query.day) : new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
    const LD = (col) => `(${col} AT TIME ZONE 'Africa/Lagos')::date`;
    const [sales, pays, refunds, tills] = await Promise.all([
      query(`SELECT o.user_id, count(*)::int AS n, COALESCE(sum(o.gross_total), 0) AS gross, COALESCE(sum(o.discount_total), 0) AS discounts,
               COALESCE(sum(o.total), 0) AS net, COALESCE(sum(o.total) FILTER (WHERE o.payment_status = 'Pending'), 0) AS unpaid,
               min(o.created_at) AS first, max(o.created_at) AS last
             FROM orders o WHERE o.status <> 'Cancelled' AND ${LD("o.created_at")} = $1 GROUP BY o.user_id`, [day]),
      query(`SELECT p.user_id, p.method, COALESCE(sum(p.amount), 0) AS amount FROM order_payments p JOIN orders o ON o.id = p.order_id
             WHERE o.status <> 'Cancelled' AND ${LD("p.paid_at")} = $1 GROUP BY p.user_id, p.method`, [day]),
      query(`SELECT o.user_id, count(*)::int AS n, COALESCE(sum(f.amount), 0) AS amount FROM refunds f JOIN orders o ON o.id = f.order_id
             WHERE f.status = 'Approved' AND ${LD("f.decided_at")} = $1 GROUP BY o.user_id`, [day]),
      query(`SELECT t.user_id, t.code, t.status, t.counted_cash, t.expected_cash, t.variance, t.closed_at, rv.name AS reviewer
             FROM till_sessions t LEFT JOIN users rv ON rv.id = t.reviewed_by
             WHERE ${LD("t.opened_at")} = $1 OR (t.closed_at IS NOT NULL AND ${LD("t.closed_at")} = $1) OR t.status = 'Open'
             ORDER BY t.opened_at`, [day]),
    ]);
    const ids = [...new Set([...sales.rows, ...pays.rows, ...refunds.rows, ...tills.rows.filter((t) => t.status !== "Open" || sales.rows.some((s) => s.user_id === t.user_id))].map((r) => r.user_id))];
    const names = ids.length ? Object.fromEntries((await query("SELECT id, name FROM users WHERE id = ANY($1)", [ids])).rows.map((u) => [u.id, u.name])) : {};
    const rows = ids.map((id) => {
      const s = sales.rows.find((x) => x.user_id === id) || { n: 0, gross: 0, discounts: 0, net: 0, unpaid: 0 };
      const by = (m) => pays.rows.filter((x) => x.user_id === id && x.method === m).reduce((t, x) => t + x.amount, 0);
      const ts = tills.rows.filter((t) => t.user_id === id);
      const closed = ts.filter((t) => t.status !== "Open");
      const open = ts.find((t) => t.status === "Open");
      return {
        id, name: names[id] ?? "—", sales: s.n, gross: s.gross, discounts: s.discounts, net: s.net, unpaid: s.unpaid,
        cash: by("Cash"), transfer: by("Transfer"), card: by("POS Card"),
        refunds: refunds.rows.find((x) => x.user_id === id)?.amount ?? 0,
        first: s.first ? fmtDateTime(s.first) : null, last: s.last ? fmtDateTime(s.last) : null,
        endDay: closed.length ? {
          status: closed.every((t) => t.status === "Reviewed") ? "Signed off" : "Ended",
          counted: closed.reduce((t, x) => t + (x.counted_cash ?? 0), 0), expected: closed.reduce((t, x) => t + (x.expected_cash ?? 0), 0),
          variance: closed.reduce((t, x) => t + (x.variance ?? 0), 0), reviewer: closed.map((t) => t.reviewer).filter(Boolean).join(", ") || null,
          codes: closed.map((t) => t.code),
        } : null,
        stillSelling: !!open,
      };
    }).filter((r) => r.sales || r.endDay || r.refunds || r.cash || r.transfer || r.card).sort((a, b) => b.net - a.net);
    const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
    res.json({ day, rows, totals: { sales: sum("sales"), gross: sum("gross"), discounts: sum("discounts"), net: sum("net"), unpaid: sum("unpaid"),
      cash: sum("cash"), transfer: sum("transfer"), card: sum("card"), refunds: sum("refunds"),
      variance: rows.reduce((t, r) => t + (r.endDay?.variance || 0), 0) } });
  }));

  r.post("/till/:code/review", requirePerm("till.review"), ah(async (req, res) => {
    const b = parse(z.object({ note: z.string().trim().max(200).optional() }), req.body);
    const out = await tx(async (db) => {
      const s = (await db.query("SELECT * FROM till_sessions WHERE code = $1 FOR UPDATE", [req.params.code])).rows[0];
      if (!s) throw notFound("Till session not found.");
      if (s.status !== "Closed") throw conflict(s.status === "Open" ? "That till is still open." : "Already reviewed.");
      if (s.user_id === req.user.id) throw new HttpError(403, "You can't review your own cash-up — another manager has to.");
      if (s.variance !== 0 && !(b.note && b.note.length >= 3)) throw bad("Explain the variance before signing off.");
      const limits = await approvalLimits(db);
      if (Math.abs(s.variance) > limits.tillVariance && !can(req.user.roles, "stock.adjust.direct")) {
        throw new HttpError(403, `A ${naira(Math.abs(s.variance))} variance is above the ${naira(limits.tillVariance)} limit — the Owner or MD must sign it off.`);
      }
      await db.query("UPDATE till_sessions SET status = 'Reviewed', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1", [s.id, req.user.id, b.note || null]);
      await audit(db, req.user.id, `Signed off cash-up ${s.code}`, `variance ${naira(s.variance)}${b.note ? ` · ${b.note}` : ""}`);
      return { code: s.code, status: "Reviewed" };
    });
    res.json(out);
  }));

  /* ============================================================ temperatures */
  r.post("/temperatures", requirePerm("temps.record"), ah(async (req, res) => {
    const b = parse(z.object({
      location: z.string().min(1),
      reading: z.coerce.number().min(-60).max(60),
      note: z.string().trim().max(200).optional(),
      action: z.string().trim().max(200).optional(),
      recordedAt: z.string().datetime({ offset: true }).optional(),   // taken while the till was offline
    }), req.body);
    const at = b.recordedAt ? new Date(b.recordedAt) : null;
    if (at && (at.getTime() > Date.now() + 10 * 60e3 || at.getTime() < Date.now() - 14 * 864e5)) throw bad("That reading's time is out of range — check the till's clock.");
    const out = await tx(async (db) => {
      const l = (await db.query("SELECT * FROM storage_locations WHERE name = $1 AND active", [b.location])).rows[0];
      if (!l) throw bad("Unknown storage location.");
      const reading = Math.round(b.reading * 10) / 10;
      const inRange = (l.temp_min == null || reading >= l.temp_min) && (l.temp_max == null || reading <= l.temp_max);
      if (!inRange && !(b.action && b.action.length >= 3)) {
        throw bad(`${reading}°C is outside ${l.name}'s safe range (${l.temp_min}°C to ${l.temp_max}°C). Record the corrective action taken.`);
      }
      await db.query(`INSERT INTO temperature_logs (location_id, reading_c, in_range, note, action, user_id, recorded_at, synced_at)
                      VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8)`,
        [l.id, reading, inRange, b.note || null, b.action || null, req.user.id, at, at ? new Date() : null]);
      if (!inRange) await audit(db, req.user.id, `Temperature breach at ${l.name}`, `${reading}°C (safe ${l.temp_min} to ${l.temp_max}°C) · ${b.action}`);
      return { ok: true, inRange, location: l.name, reading };
    });
    res.status(201).json(out);
  }));

  /* ============================================================ stock counts */
  r.post("/counts", requirePerm("counts.schedule"), ah(async (req, res) => {
    const b = parse(z.object({
      location: z.string().min(1),
      dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note: z.string().trim().max(200).optional(),
    }), req.body);
    if (b.dueOn < lagosToday()) throw bad("The due date can't be in the past.");
    const out = await tx(async (db) => {
      const l = (await db.query("SELECT * FROM storage_locations WHERE name = $1 AND active", [b.location])).rows[0];
      if (!l) throw bad("Unknown storage location.");
      if ((await db.query("SELECT 1 FROM stock_counts WHERE location_id = $1 AND status = 'Open'", [l.id])).rows[0]) {
        throw conflict(`${l.name} already has an open count.`);
      }
      const n = (await db.query("SELECT nextval('count_code_seq') AS n")).rows[0].n;
      const code = `CNT-${n}`;
      await db.query("INSERT INTO stock_counts (code, location_id, due_on, note, created_by) VALUES ($1,$2,$3,$4,$5)", [code, l.id, b.dueOn, b.note || null, req.user.id]);
      await audit(db, req.user.id, `Scheduled stock count ${code}`, `${l.name} · due ${fmtDate(b.dueOn)}`);
      return { code };
    });
    res.status(201).json(out);
  }));

  /** What to count — products only, never the system quantity (blind count). */
  r.get("/counts/:code", requirePerm("counts.perform"), ah(async (req, res) => {
    const c = (await query(`SELECT c.*, l.name AS location FROM stock_counts c JOIN storage_locations l ON l.id = c.location_id WHERE c.code = $1`, [req.params.code])).rows[0];
    if (!c) throw notFound("Count not found.");
    const products = (await query(
      `SELECT p.sku, p.name, p.unit, (s.qty > 0) AS held FROM products p
       LEFT JOIN stock s ON s.product_sku = p.sku AND s.location_id = $1
       WHERE p.active ORDER BY (s.qty > 0) DESC NULLS LAST, p.sort, p.name`, [c.location_id])).rows;
    res.json({ code: c.code, location: c.location, status: c.status, dueOn: fmtDate(c.due_on), note: c.note,
      products: products.map((p) => ({ sku: p.sku, name: p.name, unit: p.unit, required: !!p.held })) });
  }));

  r.post("/counts/:code/submit", requirePerm("counts.perform"), ah(async (req, res) => {
    const b = parse(z.object({
      lines: z.array(z.object({ sku: z.string().min(1), counted: z.coerce.number().min(0).max(1e6) })).max(500),
    }), req.body);
    const out = await tx(async (db) => {
      const c = (await db.query("SELECT c.*, l.name AS location FROM stock_counts c JOIN storage_locations l ON l.id = c.location_id WHERE c.code = $1 FOR UPDATE OF c", [req.params.code])).rows[0];
      if (!c) throw notFound("Count not found.");
      if (c.status !== "Open") throw conflict(`This count is ${c.status.toLowerCase()}.`);
      const stock = (await db.query(
        `SELECT p.sku, p.name, p.unit, COALESCE(s.qty, 0) AS qty FROM products p
         LEFT JOIN stock s ON s.product_sku = p.sku AND s.location_id = $1 WHERE p.active OR COALESCE(s.qty, 0) > 0 FOR UPDATE OF p`, [c.location_id])).rows;
      const bySku = Object.fromEntries(stock.map((s) => [s.sku, s]));
      const given = new Map(b.lines.map((l) => [l.sku, l.counted]));
      const missing = stock.filter((s) => s.qty > 0 && !given.has(s.sku)).map((s) => s.name);
      if (missing.length) throw bad(`Count every product held here — missing: ${missing.join(", ")}.`);
      let variances = 0;
      const raised = [];
      for (const [sku, counted] of given) {
        const s = bySku[sku];
        if (!s) throw bad(`Unknown product ${sku}.`);
        if (s.unit !== "KG" && !Number.isInteger(counted)) throw bad(`${s.name} is counted in whole ${s.unit.toLowerCase()}s.`);
        const variance = round3(counted - s.qty);
        let adj = null;
        if (Math.abs(variance) > 1e-9) {
          variances++;
          adj = await createAdjustment(db, req.user, { sku, location: c.location, kind: "correction", qty: variance, reason: "Stock count variance", note: `Blind count ${c.code}` }, { allowCounter: true });
          raised.push(adj.code);
        }
        await db.query("INSERT INTO stock_count_lines (count_id, product_sku, expected_qty, counted_qty, adjustment_code) VALUES ($1,$2,$3,$4,$5)",
          [c.id, sku, s.qty, counted, adj?.code ?? null]);
      }
      await db.query("UPDATE stock_counts SET status = 'Submitted', submitted_by = $2, submitted_at = now() WHERE id = $1", [c.id, req.user.id]);
      await audit(db, req.user.id, `Submitted stock count ${c.code}`, `${c.location} · ${given.size} lines · ${variances} variance${variances === 1 ? "" : "s"}${raised.length ? ` → ${raised.join(", ")}` : ""}`);
      return { code: c.code, lines: given.size, variances, adjustments: raised };
    });
    res.json(out);
  }));

  r.post("/counts/:code/cancel", requirePerm("counts.schedule"), ah(async (req, res) => {
    const { rows } = await query("UPDATE stock_counts SET status = 'Cancelled' WHERE code = $1 AND status = 'Open' RETURNING code", [req.params.code]);
    if (!rows[0]) throw conflict("Only an open count can be cancelled.");
    await audit(null, req.user.id, `Cancelled stock count ${rows[0].code}`, null);
    res.json({ ok: true });
  }));

  /* ============================================================ batch trace (recalls) */
  r.get("/trace/:lot", requirePerm("trace.view"), ah(async (req, res) => {
    const code = req.params.lot;
    const lots = (await query(
      `SELECT sl.id, sl.lot_code, sl.expires_on, sl.qty, p.name AS product, p.unit, l.name AS location
       FROM stock_lots sl JOIN products p ON p.sku = sl.product_sku JOIN storage_locations l ON l.id = sl.location_id
       WHERE upper(sl.lot_code) = upper($1) ORDER BY p.name, l.name`, [code])).rows;
    if (!lots.length) throw notFound(`No batch called ${code}.`);
    const ids = lots.map((l) => l.id);
    const batch = (await query(
      `SELECT b.code, b.processed_at, b.yield_pct, a.code AS animal, a.species, a.breed, r.name AS ranch
       FROM processing_batches b JOIN livestock a ON a.id = b.livestock_id JOIN ranches r ON r.id = a.ranch_id WHERE upper(b.code) = upper($1)`, [code])).rows[0];
    const sales = (await query(
      `SELECT o.code, o.created_at, o.status, o.channel, c.name AS customer, c.phone, p.name AS product, p.unit, sum((lt->>'qty')::numeric) AS qty
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
       LEFT JOIN customers c ON c.id = o.customer_id,
       jsonb_array_elements(oi.allocations) al, jsonb_array_elements(COALESCE(al->'lots', '[]'::jsonb)) lt
       WHERE (lt->>'lot_id')::int = ANY($1) AND o.status <> 'Cancelled'
       GROUP BY o.id, c.id, p.sku ORDER BY o.created_at DESC`, [ids])).rows;
    res.json({
      lot: lots[0].lot_code,
      batch: batch ? { code: batch.code, processed: fmtDateTime(batch.processed_at), animal: batch.animal, species: batch.species, breed: batch.breed, ranch: batch.ranch, yield: batch.yield_pct } : null,
      holdings: lots.map((l) => ({ product: l.product, unit: l.unit, location: l.location, qty: l.qty, expiresOn: fmtDate(l.expires_on) })),
      sales: sales.map((s) => ({ order: s.code, date: fmtDateTime(s.created_at), status: s.status, channel: s.channel, customer: s.customer ?? "Walk-in customer", phone: s.phone, product: s.product, qty: round3(s.qty), unit: s.unit })),
    });
  }));

  /* ============================================================ approval limits */
  r.patch("/settings/limits", requirePerm("controls.manage"), ah(async (req, res) => {
    const b = parse(z.object({ adjustment: money.optional(), refund: money.optional(), tillVariance: money.optional(), purchase: money.optional(), paymentVariance: money.optional(), discountPct: z.coerce.number().min(0).max(100).optional() }), req.body);
    const cur = await approvalLimits();
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    await query("INSERT INTO settings (key, value) VALUES ('approval_limits', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(next)]);
    const ch = Object.keys(next).filter((k) => next[k] !== cur[k]).map((k) => k === "discountPct" ? `discount ${cur[k]}% → ${next[k]}%` : `${k} ${naira(cur[k])} → ${naira(next[k])}`);
    if (ch.length) await audit(null, req.user.id, "Changed approval limits", ch.join(", "));
    res.json(next);
  }));
}
