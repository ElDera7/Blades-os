// Business controls:
//   • Backups          — status, back up now, restore test, Owner download (engine in backup.js)
//   • Payment reconciliation — transfers and card takings matched daily to bank / terminal statements
//   • Purchase orders  — raise → approve (limit) → receive (lots) → supplier invoice 3-way match
//   • HACCP checklists — daily / weekly food-safety checks, failures need a corrective action, verified by a manager
import { z } from "zod";
import { query, tx } from "./db.js";
import { requirePerm } from "./auth.js";
import { addStock } from "./stock.js";
import { approvalLimits } from "./operations.js";
import { backupConfig, runBackup, runRestoreTest, dumpDatabase, encrypt, restoreIntoScratch, sha256 } from "./backup.js";
import { can, UNLIMITED_APPROVER, PO_OVER_RECEIPT_PCT, PO_MATCH_TOLERANCE_PCT, RECON_METHODS } from "../src/shared/permissions.js";
import { ah, parse, audit, bad, notFound, conflict, HttpError, round3, fmtDate, fmtDateTime } from "./util.js";

const naira = (n) => `₦${Math.round(n || 0).toLocaleString("en-NG")}`;
const money = z.coerce.number().int().min(0).max(1e12);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lagosToday = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const TODAY = `(now() AT TIME ZONE 'Africa/Lagos')::date`;
const note3 = (s) => typeof s === "string" && s.trim().length >= 3;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/* ================================================================== payments: what BladeOS expects per day */
async function expectedFor(db, day, method) {
  const r = (await db.query(
    `SELECT
       (SELECT COALESCE(sum(p.amount), 0) FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE o.status <> 'Cancelled' AND p.method = $2
          AND (p.paid_at AT TIME ZONE 'Africa/Lagos')::date = $1) AS takings,
       (SELECT count(*)::int FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE o.status <> 'Cancelled' AND p.method = $2
          AND (p.paid_at AT TIME ZONE 'Africa/Lagos')::date = $1) AS orders,
       (SELECT COALESCE(sum(amount), 0) FROM refunds WHERE status = 'Approved' AND method = $2
          AND (decided_at AT TIME ZONE 'Africa/Lagos')::date = $1) AS refunds`, [day, method])).rows[0];
  return { takings: r.takings, refunds: r.refunds, orders: r.orders, expected: r.takings - r.refunds };
}

/* ================================================================== purchase orders: three-way match */
function matchOf(po) {
  const received = Math.round(po.lines.reduce((s, l) => s + l.receivedQty * l.unitCost, 0));
  const invoiced = po.invoiced;
  if (!invoiced) return { received, invoiced, status: received > 0 ? "Awaiting invoice" : "—", diff: 0 };
  const diff = invoiced - received;
  const tol = Math.max(1, Math.round(received * PO_MATCH_TOLERANCE_PCT / 100));
  return { received, invoiced, diff, status: Math.abs(diff) <= tol ? "Matched" : "Mismatch" };
}

async function loadPOs(where = "TRUE", params = []) {
  const pos = (await query(
    `SELECT po.*, to_char(po.expected_on, 'YYYY-MM-DD') AS expected_iso, s.name AS supplier, cu.name AS created_by_name, du.name AS decided_by_name,
       (SELECT COALESCE(sum(amount), 0) FROM supplier_entries e WHERE e.purchase_order_id = po.id AND e.kind = 'invoice') AS invoiced,
       (SELECT json_agg(json_build_object('reference', e.reference, 'amount', e.amount, 'date', e.entry_date) ORDER BY e.id)
          FROM supplier_entries e WHERE e.purchase_order_id = po.id AND e.kind = 'invoice') AS invoices
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN users cu ON cu.id = po.created_by LEFT JOIN users du ON du.id = po.decided_by
     WHERE ${where} ORDER BY po.created_at DESC LIMIT 200`, params)).rows;
  if (!pos.length) return [];
  const ids = pos.map((p) => p.id);
  const [lines, receipts] = await Promise.all([
    query(`SELECT * FROM purchase_order_lines WHERE po_id = ANY($1) ORDER BY id`, [ids]),
    query(`SELECT r.*, l.po_id, sl.name AS location, u.name AS who, lot.lot_code FROM po_receipts r JOIN purchase_order_lines l ON l.id = r.po_line_id
           LEFT JOIN storage_locations sl ON sl.id = r.location_id LEFT JOIN stock_lots lot ON lot.id = r.lot_id JOIN users u ON u.id = r.received_by
           WHERE l.po_id = ANY($1) ORDER BY r.received_at`, [ids]),
  ]);
  return pos.map((p) => {
    const po = {
      code: p.code, supplierId: p.supplier_id, supplier: p.supplier, status: p.status, expectedOn: p.expected_on ? fmtDate(p.expected_on) : null,
      expected: p.expected_iso,
      note: p.note, total: p.total, createdBy: p.created_by_name, createdById: p.created_by, createdAt: fmtDateTime(p.created_at),
      decidedBy: p.decided_by_name, decidedAt: p.decided_at ? fmtDateTime(p.decided_at) : null, decisionNote: p.decision_note,
      invoiced: p.invoiced, invoices: (p.invoices || []).map((i) => ({ ...i, date: fmtDate(i.date) })),
      lines: lines.rows.filter((l) => l.po_id === p.id).map((l) => ({
        id: l.id, sku: l.product_sku, description: l.description, qty: l.qty, unit: l.unit, unitCost: l.unit_cost,
        receivedQty: l.received_qty, outstanding: Math.max(0, round3(l.qty - l.received_qty)),
      })),
      receipts: receipts.rows.filter((r) => r.po_id === p.id).map((r) => ({
        line: r.po_line_id, qty: r.qty, location: r.location, lot: r.lot_code, note: r.note, who: r.who, at: fmtDateTime(r.received_at),
      })),
    };
    po.match = matchOf(po);
    return po;
  });
}

/* ================================================================== HACCP periods */
const PERIOD = (freq) => (freq === "weekly" ? `date_trunc('week', ${TODAY})::date` : TODAY);

/* ================================================================== routes */
export function businessRoutes(r) {
  /* ---------------------------------------------------------- backups */
  r.post("/backups/run", requirePerm("backups.manage"), ah(async (req, res) => {
    const cfg = backupConfig();
    if (!cfg.ready) throw conflict(cfg.problem);
    if ((await query("SELECT 1 FROM backups WHERE status = 'Running' AND started_at > now() - interval '1 hour'")).rows[0]) throw conflict("A backup is already running.");
    try {
      const b = await runBackup({ kind: "manual", userId: req.user.id });
      await audit(null, req.user.id, "Ran a backup", `${b.tables} tables · ${b.rows.toLocaleString("en-NG")} rows · ${Math.ceil(b.bytes / 1024)} KB`);
      res.status(201).json({ ok: true, ...b });
    } catch (e) {
      await audit(null, req.user.id, "Backup failed", e.message);
      throw new HttpError(502, `Backup failed: ${e.message}`);
    }
  }));

  r.post("/backups/test", requirePerm("backups.manage"), ah(async (req, res) => {
    const cfg = backupConfig();
    if (!cfg.ready) throw conflict(cfg.problem);
    try {
      const t = await runRestoreTest({ userId: req.user.id });
      await audit(null, req.user.id, `Restore test ${t.ok ? "passed" : "FAILED"}`, `${t.tables} tables · ${t.rows.toLocaleString("en-NG")} rows${t.problems.length ? ` · ${t.problems.slice(0, 3).join("; ")}` : ""}`);
      res.json(t);
    } catch (e) {
      await audit(null, req.user.id, "Restore test FAILED", e.message);
      throw new HttpError(502, `Restore test failed: ${e.message}`);
    }
  }));

  /**
   * Owner only: a full copy to keep somewhere safe (the weekly backup when there's no off-site storage).
   * Encrypted when BACKUP_PASSPHRASE is set. Before it's handed over, the exact file is restore-tested into a
   * throw-away schema (every table's rows and every link checked) — a copy that fails is never given out.
   */
  r.get("/backups/download", requirePerm("backups.download"), ah(async (req, res) => {
    const cfg = backupConfig();
    const dump = await dumpDatabase();
    const file = cfg.passphrase ? encrypt(dump.gz, cfg.passphrase) : dump.gz;
    const hash = sha256(file);
    const b = (await query(`INSERT INTO backups (kind, status, storage, bytes, sha256, tables, rows, encrypted, user_id)
                 VALUES ('manual', 'Running', 'download', $1, $2, $3, $4, $5, $6) RETURNING id`, [file.length, hash, dump.tables, dump.rows, !!cfg.passphrase, req.user.id])).rows[0];
    const t = (await query("INSERT INTO restore_tests (backup_id, user_id) VALUES ($1, $2) RETURNING id", [b.id, req.user.id])).rows[0];
    let check;
    try {
      check = await restoreIntoScratch(file, cfg.passphrase);
      if (check.rows !== dump.rows) check.detail.problems.push(`restored ${check.rows} rows; the copy recorded ${dump.rows}`);
    } catch (e) {
      check = { tables: 0, rows: 0, detail: { problems: [e.message] } };
    }
    const ok = check.detail.problems.length === 0;
    await query(`UPDATE restore_tests SET status = $2, tables = $3, rows = $4, detail = $5, error = $6, finished_at = now() WHERE id = $1`,
      [t.id, ok ? "Passed" : "Failed", check.tables, check.rows, JSON.stringify(check.detail), ok ? null : check.detail.problems.slice(0, 5).join("; ")]);
    await query("UPDATE backups SET status = $2, error = $3, finished_at = now() WHERE id = $1", [b.id, ok ? "Succeeded" : "Failed", ok ? null : "Failed its restore check"]);
    if (!ok) {
      await audit(null, req.user.id, "Backup download FAILED its restore check", check.detail.problems.slice(0, 3).join("; "));
      throw new HttpError(500, `This backup failed its check and wasn't downloaded: ${check.detail.problems[0]}`);
    }
    await audit(null, req.user.id, "Downloaded a full backup", `${dump.rows.toLocaleString("en-NG")} rows · ${cfg.passphrase ? "encrypted" : "NOT encrypted"} · restore-checked · sha256 ${hash.slice(0, 12)}`);
    const name = `bladeos-${new Date(Date.now() + 3600e3).toISOString().slice(0, 16).replace(/[T:]/g, "-")}.bdb${cfg.passphrase ? "" : ".gz"}`;
    res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Backup-SHA256": hash,
      "Access-Control-Expose-Headers": "Content-Disposition, X-Backup-SHA256" });
    res.send(file);
  }));

  /* ---------------------------------------------------------- payment reconciliation */
  r.get("/reconciliations/:day/:method", requirePerm("payments.reconcile"), ah(async (req, res) => {
    const day = parse(isoDate, req.params.day), method = parse(z.enum(RECON_METHODS), req.params.method);
    const [orders, refunds] = await Promise.all([
      query(`SELECT o.code, p.amount AS total, p.ref AS payment_ref, p.paid_at, o.channel, c.name AS customer, u.name AS who FROM order_payments p
             JOIN orders o ON o.id = p.order_id LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = p.user_id
             WHERE o.status <> 'Cancelled' AND p.method = $2 AND (p.paid_at AT TIME ZONE 'Africa/Lagos')::date = $1
             ORDER BY p.paid_at`, [day, method]),
      query(`SELECT f.code, f.amount, f.decided_at, o.code AS order_code FROM refunds f JOIN orders o ON o.id = f.order_id
             WHERE f.status = 'Approved' AND f.method = $2 AND (f.decided_at AT TIME ZONE 'Africa/Lagos')::date = $1 ORDER BY f.decided_at`, [day, method]),
    ]);
    res.json({
      day, method, ...(await expectedFor({ query }, day, method)),
      orders: orders.rows.map((o) => ({ code: o.code, amount: o.total, ref: o.payment_ref, at: fmtDateTime(o.paid_at), channel: o.channel, customer: o.customer ?? "Walk-in customer", who: o.who })),
      refunds: refunds.rows.map((f) => ({ code: f.code, amount: f.amount, order: f.order_code, at: fmtDateTime(f.decided_at) })),
    });
  }));

  r.post("/reconciliations", requirePerm("payments.reconcile"), ah(async (req, res) => {
    const b = parse(z.object({
      day: isoDate, method: z.enum(RECON_METHODS), actual: money,
      statementRef: z.string().trim().max(60).optional().or(z.literal("")),
      note: z.string().trim().max(300).optional().or(z.literal("")),
    }), req.body);
    const today = lagosToday();
    if (b.day > today) throw bad("That day hasn't happened yet.");
    if (b.day < addDays(today, -90)) throw bad("Only the last 90 days can be reconciled.");
    const out = await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('recon:' || $1 || $2))", [b.day, b.method]);
      const cur = (await db.query("SELECT * FROM payment_reconciliations WHERE day = $1 AND method = $2", [b.day, b.method])).rows[0];
      if (cur?.status === "Reviewed") throw conflict("That day is already reconciled and signed off.");
      const e = await expectedFor(db, b.day, b.method);
      const variance = b.actual - e.expected;
      if (variance !== 0 && !note3(b.note)) throw bad(`The statement differs from BladeOS by ${naira(Math.abs(variance))} — explain why (e.g. transfer arrived next day, terminal charge).`);
      await db.query(
        `INSERT INTO payment_reconciliations (day, method, expected, actual, variance, statement_ref, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (day, method) DO UPDATE SET expected = EXCLUDED.expected, actual = EXCLUDED.actual, variance = EXCLUDED.variance,
           statement_ref = EXCLUDED.statement_ref, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
        [b.day, b.method, e.expected, b.actual, variance, b.statementRef || null, b.note || null, req.user.id]);
      await audit(db, req.user.id, `Reconciled ${b.method} for ${fmtDate(b.day)}`,
        `BladeOS ${naira(e.expected)} · statement ${naira(b.actual)} · ${variance === 0 ? "matched" : `${variance > 0 ? "over" : "short"} ${naira(Math.abs(variance))}`}`);
      return { day: b.day, method: b.method, expected: e.expected, actual: b.actual, variance };
    });
    res.status(201).json(out);
  }));

  r.post("/reconciliations/:id/review", requirePerm("payments.reconcile"), ah(async (req, res) => {
    const b = parse(z.object({ note: z.string().trim().max(300).optional().or(z.literal("")) }), req.body);
    const out = await tx(async (db) => {
      const rec = (await db.query("SELECT *, to_char(day, 'YYYY-MM-DD') AS d FROM payment_reconciliations WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!rec) throw notFound("Reconciliation not found.");
      if (rec.status === "Reviewed") throw conflict("Already signed off.");
      if (rec.recorded_by === req.user.id) throw new HttpError(403, "You can't sign off a reconciliation you recorded — another manager has to.");
      const now = await expectedFor(db, rec.d, rec.method);
      if (now.expected !== rec.expected) throw conflict(`BladeOS takings for that day changed since it was recorded (${naira(rec.expected)} → ${naira(now.expected)}). Record it again first.`);
      if (rec.variance !== 0 && !note3(b.note)) throw bad("Add a note on the variance before signing off.");
      const limits = await approvalLimits(db);
      if (Math.abs(rec.variance) > limits.paymentVariance && !can(req.user.roles, UNLIMITED_APPROVER)) {
        throw new HttpError(403, `A ${naira(Math.abs(rec.variance))} variance is above the ${naira(limits.paymentVariance)} limit — the Owner or MD must sign it off.`);
      }
      await db.query("UPDATE payment_reconciliations SET status = 'Reviewed', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1", [rec.id, req.user.id, b.note || null]);
      await audit(db, req.user.id, `Signed off ${rec.method} reconciliation for ${fmtDate(rec.day)}`, `variance ${naira(rec.variance)}${b.note ? ` · ${b.note}` : ""}`);
      return { ok: true };
    });
    res.json(out);
  }));

  /* ---------------------------------------------------------- purchase orders */
  const poLine = z.object({
    sku: z.string().trim().min(1).optional().or(z.literal("")),
    description: z.string().trim().max(120).optional().or(z.literal("")),
    unit: z.string().trim().max(20).optional().or(z.literal("")),
    qty: z.coerce.number().positive().max(1e6),
    unitCost: money,
  });

  r.post("/purchase-orders", requirePerm("purchasing.create"), ah(async (req, res) => {
    const b = parse(z.object({
      supplierId: z.coerce.number().int().positive(),
      expectedOn: isoDate.optional().or(z.literal("")),
      note: z.string().trim().max(300).optional().or(z.literal("")),
      lines: z.array(poLine).min(1).max(50),
    }), req.body);
    if (b.expectedOn && b.expectedOn < lagosToday()) throw bad("The delivery date can't be in the past.");
    const out = await tx(async (db) => {
      const s = (await db.query("SELECT * FROM suppliers WHERE id = $1", [b.supplierId])).rows[0];
      if (!s) throw notFound("Supplier not found.");
      if (!s.active) throw conflict(`${s.name} is retired.`);
      const lines = [];
      for (const l of b.lines) {
        if (l.sku) {
          const p = (await db.query("SELECT sku, name, unit FROM products WHERE sku = $1 AND active", [l.sku])).rows[0];
          if (!p) throw bad(`Unknown product ${l.sku}.`);
          if (p.unit !== "KG" && !Number.isInteger(l.qty)) throw bad(`${p.name} is ordered in whole ${p.unit.toLowerCase()}s.`);
          lines.push({ sku: p.sku, description: p.name, unit: p.unit, qty: round3(l.qty), unitCost: l.unitCost });
        } else {
          if (!l.description || l.description.length < 2) throw bad("Describe each line that isn't a stock product (e.g. live cattle, packaging).");
          lines.push({ sku: null, description: l.description, unit: l.unit || "Item", qty: round3(l.qty), unitCost: l.unitCost });
        }
      }
      const total = lines.reduce((sum, l) => sum + Math.round(l.qty * l.unitCost), 0);
      if (total <= 0) throw bad("The order total can't be zero.");
      const exec = can(req.user.roles, UNLIMITED_APPROVER);
      const n = (await db.query("SELECT nextval('po_code_seq') AS n")).rows[0].n;
      const code = `PO-${n}`;
      const po = (await db.query(
        `INSERT INTO purchase_orders (code, supplier_id, status, expected_on, note, total, created_by, decided_by, decided_at, decision_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [code, s.id, exec ? "Approved" : "Pending Approval", b.expectedOn || null, b.note || null, total, req.user.id,
         exec ? req.user.id : null, exec ? new Date() : null, exec ? "Approved on creation (Owner/MD)" : null])).rows[0];
      for (const l of lines) {
        await db.query("INSERT INTO purchase_order_lines (po_id, product_sku, description, qty, unit, unit_cost) VALUES ($1,$2,$3,$4,$5,$6)",
          [po.id, l.sku, l.description, l.qty, l.unit, l.unitCost]);
      }
      await audit(db, req.user.id, `Raised ${code}`, `${s.name} · ${naira(total)} · ${plural(lines.length, "line")}${exec ? " · approved on creation" : ""}`);
      return { code, status: exec ? "Approved" : "Pending Approval", total };
    });
    res.status(201).json(out);
  }));

  r.post("/purchase-orders/:code/decide", requirePerm("purchasing.approve"), ah(async (req, res) => {
    const b = parse(z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(300).optional().or(z.literal("")) }), req.body);
    const out = await tx(async (db) => {
      const po = (await db.query("SELECT * FROM purchase_orders WHERE code = $1 FOR UPDATE", [req.params.code])).rows[0];
      if (!po) throw notFound("Purchase order not found.");
      if (po.status !== "Pending Approval") throw conflict(`${po.code} is ${po.status.toLowerCase()}.`);
      if (po.created_by === req.user.id) throw new HttpError(403, "You can't approve your own purchase order — another manager has to.");
      if (b.decision === "reject" && !note3(b.note)) throw bad("Give a reason for rejecting.");
      if (b.decision === "approve") {
        const limits = await approvalLimits(db);
        if (po.total > limits.purchase && !can(req.user.roles, UNLIMITED_APPROVER)) {
          throw new HttpError(403, `${naira(po.total)} is above the ${naira(limits.purchase)} purchase limit — the Owner or MD must approve it.`);
        }
      }
      const status = b.decision === "approve" ? "Approved" : "Rejected";
      await db.query("UPDATE purchase_orders SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [po.id, status, req.user.id, b.note || null]);
      await audit(db, req.user.id, `${status} ${po.code}`, `${naira(po.total)}${b.note ? ` · ${b.note}` : ""}`);
      return { code: po.code, status };
    });
    res.json(out);
  }));

  r.post("/purchase-orders/:code/receive", requirePerm("stock.receive"), ah(async (req, res) => {
    const b = parse(z.object({
      location: z.string().trim().optional().or(z.literal("")),
      note: z.string().trim().min(2, "add the supplier's delivery note / waybill number").max(200),
      lines: z.array(z.object({
        lineId: z.coerce.number().int().positive(),
        qty: z.coerce.number().min(0).max(1e6),
        lot: z.string().trim().max(40).optional().or(z.literal("")),
        expiresOn: isoDate.optional().or(z.literal("")),
      })).min(1).max(50),
    }), req.body);
    const today = lagosToday();
    const out = await tx(async (db) => {
      const po = (await db.query("SELECT po.*, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.code = $1 FOR UPDATE OF po", [req.params.code])).rows[0];
      if (!po) throw notFound("Purchase order not found.");
      if (!["Approved", "Partly Received"].includes(po.status)) {
        throw conflict(po.status === "Pending Approval" ? `${po.code} hasn't been approved yet — goods can't be received against it.` : `${po.code} is ${po.status.toLowerCase()}.`);
      }
      const lines = (await db.query("SELECT * FROM purchase_order_lines WHERE po_id = $1 ORDER BY id FOR UPDATE", [po.id])).rows;
      const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
      const todo = b.lines.filter((l) => l.qty > 0);
      if (!todo.length) throw bad("Enter the quantity received on at least one line.");
      let loc = null;
      if (todo.some((l) => byId[l.lineId]?.product_sku)) {
        loc = (await db.query("SELECT id, name, active FROM storage_locations WHERE name = $1", [b.location || ""])).rows[0];
        if (!loc) throw bad("Pick where the stock is going.");
        if (!loc.active) throw conflict(`${loc.name} is retired.`);
      }
      const grn = `GRN-${Date.now().toString(36).toUpperCase()}`;
      const done = [];
      for (const it of todo) {
        const l = byId[it.lineId];
        if (!l) throw bad("That line isn't on this purchase order.");
        if (l.unit !== "KG" && !Number.isInteger(it.qty)) throw bad(`${l.description} is received in whole ${l.unit.toLowerCase()}s.`);
        const qty = round3(it.qty);
        const remaining = round3(l.qty - l.received_qty);
        const allowed = l.unit === "KG" ? round3(remaining + l.qty * PO_OVER_RECEIPT_PCT / 100) : remaining;
        if (qty > allowed + 1e-9) {
          throw bad(remaining <= 0 ? `${l.description} has already been received in full.`
            : `${l.description}: only ${remaining} ${l.unit} outstanding${l.unit === "KG" ? ` (up to ${allowed} KG with the ${PO_OVER_RECEIPT_PCT}% weight allowance)` : ""}. Anything extra needs a new order.`);
        }
        let lotId = null;
        if (l.product_sku) {
          if (it.expiresOn && it.expiresOn < today) throw bad(`${l.description}: that use-by date has already passed — don't accept this stock.`);
          lotId = await addStock(db, { sku: l.product_sku, locationId: loc.id, qty, kind: "receipt", reference: grn,
            note: `${po.code} · ${po.supplier} · ${b.note}`, userId: req.user.id, lot: { code: it.lot || po.code, expiresOn: it.expiresOn || undefined } });
        }
        await db.query("INSERT INTO po_receipts (po_line_id, qty, location_id, lot_id, note, received_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [l.id, qty, l.product_sku ? loc.id : null, lotId, b.note, req.user.id]);
        await db.query("UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id = $1", [l.id, qty]);
        l.received_qty = round3(Number(l.received_qty) + qty);
        done.push(`${qty} ${l.unit} ${l.description}`);
      }
      const full = lines.every((l) => l.received_qty + 1e-9 >= l.qty);
      const status = full ? "Received" : "Partly Received";
      await db.query("UPDATE purchase_orders SET status = $2, closed_at = CASE WHEN $2::text = 'Received' THEN now() ELSE closed_at END WHERE id = $1", [po.id, status]);
      await audit(db, req.user.id, `Received against ${po.code}`, `${done.join(", ")}${loc ? ` → ${loc.name}` : ""} · ${b.note}`);
      return { code: po.code, status, reference: grn };
    });
    res.json(out);
  }));

  /** Cancel an order nothing has arrived against, or close one that was short-delivered. */
  r.post("/purchase-orders/:code/close", requirePerm("purchasing.create"), ah(async (req, res) => {
    const b = parse(z.object({ note: z.string().trim().min(3, "give a reason").max(300) }), req.body);
    const out = await tx(async (db) => {
      const po = (await db.query("SELECT * FROM purchase_orders WHERE code = $1 FOR UPDATE", [req.params.code])).rows[0];
      if (!po) throw notFound("Purchase order not found.");
      let status;
      if (["Pending Approval", "Approved"].includes(po.status)) status = "Cancelled";
      else if (po.status === "Partly Received") status = "Closed";
      else throw conflict(`${po.code} is ${po.status.toLowerCase()}.`);
      await db.query("UPDATE purchase_orders SET status = $2, closed_at = now(), decision_note = COALESCE(decision_note || ' · ', '') || $3 WHERE id = $1", [po.id, status, b.note]);
      await audit(db, req.user.id, `${status} ${po.code}`, b.note);
      return { code: po.code, status };
    });
    res.json(out);
  }));

  /* ---------------------------------------------------------- HACCP */
  r.post("/haccp/:id/complete", requirePerm("haccp.complete"), ah(async (req, res) => {
    const b = parse(z.object({
      results: z.array(z.object({ ok: z.boolean(), action: z.string().trim().max(300).optional().or(z.literal("")) })).min(1).max(40),
      note: z.string().trim().max(300).optional().or(z.literal("")),
      completedAt: z.string().datetime({ offset: true }).optional(),   // done while the till was offline
    }), req.body);
    const at = b.completedAt ? new Date(b.completedAt) : null;
    if (at && (at.getTime() > Date.now() + 10 * 60e3 || at.getTime() < Date.now() - 14 * 864e5)) throw bad("That checklist's time is out of range — check the till's clock.");
    const out = await tx(async (db) => {
      const c = (await db.query("SELECT * FROM haccp_checklists WHERE id = $1", [req.params.id])).rows[0];
      if (!c || !c.active) throw notFound("Checklist not found.");
      if (b.results.length !== c.items.length) throw bad("Answer every item on the checklist — the checklist may have changed; reload and try again.");
      const results = c.items.map((item, i) => ({ item, ok: b.results[i].ok, action: b.results[i].ok ? null : (b.results[i].action || "") }));
      const missing = results.filter((x) => !x.ok && !note3(x.action));
      if (missing.length) throw bad(`Record the corrective action for: ${missing.map((x) => x.item).join("; ")}.`);
      const period = at
        ? (await db.query(`SELECT CASE WHEN $2 = 'weekly' THEN date_trunc('week', ($1::timestamptz AT TIME ZONE 'Africa/Lagos'))::date
                                       ELSE ($1::timestamptz AT TIME ZONE 'Africa/Lagos')::date END AS d`, [at, c.frequency])).rows[0].d
        : (await db.query(`SELECT ${PERIOD(c.frequency)} AS d`)).rows[0].d;
      const allOk = results.every((x) => x.ok);
      try {
        await db.query(`INSERT INTO haccp_runs (checklist_id, period_start, results, all_ok, note, completed_by, completed_at, synced_at)
                        VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8)`,
          [c.id, period, JSON.stringify(results), allOk, b.note || null, req.user.id, at, at ? new Date() : null]);
      } catch (e) {
        if (e.code === "23505") throw conflict(`${c.name} is already done for ${c.frequency === "weekly" ? "this week" : "today"}.`);
        throw e;
      }
      const fails = results.filter((x) => !x.ok);
      await audit(db, req.user.id, `Completed ${c.name}`, allOk ? "all checks passed" : `${plural(fails.length, "failure")}: ${fails.map((x) => `${x.item} → ${x.action}`).join("; ")}`);
      return { ok: true, allOk, failures: fails.length };
    });
    res.status(201).json(out);
  }));

  r.post("/haccp/runs/:id/verify", requirePerm("haccp.verify"), ah(async (req, res) => {
    const b = parse(z.object({ note: z.string().trim().max(300).optional().or(z.literal("")) }), req.body);
    const out = await tx(async (db) => {
      const run = (await db.query("SELECT r.*, c.name FROM haccp_runs r JOIN haccp_checklists c ON c.id = r.checklist_id WHERE r.id = $1 FOR UPDATE OF r", [req.params.id])).rows[0];
      if (!run) throw notFound("Checklist record not found.");
      if (run.verified_by) throw conflict("Already verified.");
      if (run.completed_by === req.user.id) throw new HttpError(403, "You can't verify a checklist you completed — another manager has to.");
      if (!run.all_ok && !note3(b.note)) throw bad("Some checks failed — confirm the corrective actions worked before verifying.");
      await db.query("UPDATE haccp_runs SET verified_by = $2, verified_at = now(), verify_note = $3 WHERE id = $1", [run.id, req.user.id, b.note || null]);
      await audit(db, req.user.id, `Verified ${run.name}`, `${fmtDate(run.period_start)}${b.note ? ` · ${b.note}` : ""}`);
      return { ok: true };
    });
    res.json(out);
  }));

  const checklistBody = z.object({
    name: z.string().trim().min(3).max(60),
    frequency: z.enum(["daily", "weekly"]),
    items: z.array(z.string().trim().min(3).max(160)).min(1).max(40),
  });
  r.post("/haccp/checklists", requirePerm("setup.manage"), ah(async (req, res) => {
    const b = parse(checklistBody, req.body);
    const row = (await query("INSERT INTO haccp_checklists (name, frequency, items, sort) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort), 0) + 1 FROM haccp_checklists)) RETURNING id",
      [b.name, b.frequency, b.items])).rows[0];
    await audit(null, req.user.id, `Added checklist ${b.name}`, `${b.frequency} · ${plural(b.items.length, "item")}`);
    res.status(201).json({ id: row.id });
  }));

  r.patch("/haccp/checklists/:id", requirePerm("setup.manage"), ah(async (req, res) => {
    const b = parse(checklistBody.partial().extend({ active: z.boolean().optional() }), req.body);
    const c = (await query("SELECT * FROM haccp_checklists WHERE id = $1", [req.params.id])).rows[0];
    if (!c) throw notFound("Checklist not found.");
    const n = { name: b.name ?? c.name, frequency: b.frequency ?? c.frequency, items: b.items ?? c.items, active: b.active ?? c.active };
    await query("UPDATE haccp_checklists SET name = $2, frequency = $3, items = $4, active = $5 WHERE id = $1", [c.id, n.name, n.frequency, n.items, n.active]);
    const ch = [n.name !== c.name && `renamed from ${c.name}`, n.frequency !== c.frequency && `now ${n.frequency}`,
      JSON.stringify(n.items) !== JSON.stringify(c.items) && `${plural(n.items.length, "item")}`, n.active !== c.active && (n.active ? "restored" : "retired")].filter(Boolean);
    if (ch.length) await audit(null, req.user.id, `Updated checklist ${n.name}`, ch.join(", "));
    res.json({ ok: true });
  }));
}

/* ================================================================== state */
/** Without off-site storage, the Owner downloads a checked, encrypted copy at least this often. */
const WEEKLY_DAYS = 7;

export async function backupsState() {
  const cfg = backupConfig();
  const [recent, tests] = await Promise.all([
    query(`SELECT b.*, u.name AS who FROM backups b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.started_at DESC LIMIT 10`),
    query(`SELECT t.*, u.name AS who FROM restore_tests t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.started_at DESC LIMIT 5`),
  ]);
  const lastOk = recent.rows.find((b) => b.status === "Succeeded" && b.storage === "s3")
    ?? (await query("SELECT * FROM backups WHERE status = 'Succeeded' AND storage = 's3' ORDER BY started_at DESC LIMIT 1")).rows[0];
  const host = cfg.s3 ? (() => { try { return new URL(cfg.s3.endpoint).host; } catch { return cfg.s3.endpoint; } })() : null;
  const dl = (await query(`SELECT b.started_at, b.rows, b.bytes, b.encrypted, b.sha256, u.name AS who FROM backups b LEFT JOIN users u ON u.id = b.user_id
                           WHERE b.storage = 'download' AND b.status = 'Succeeded' ORDER BY b.started_at DESC LIMIT 1`)).rows[0];
  return {
    mode: cfg.mode, passphraseOk: cfg.passphraseOk, weeklyDays: WEEKLY_DAYS,
    lastDownload: dl ? { at: fmtDateTime(dl.started_at), daysAgo: Math.floor((Date.now() - new Date(dl.started_at).getTime()) / 864e5), who: dl.who,
      rows: dl.rows, bytes: dl.bytes, encrypted: dl.encrypted, fingerprint: dl.sha256?.slice(0, 12) } : null,
    ready: cfg.ready, problem: cfg.problem, encrypted: !!cfg.passphrase, retentionDays: cfg.retentionDays,
    destination: cfg.s3 ? `${host}/${cfg.s3.bucket}/${cfg.s3.prefix}` : null,
    lastSuccess: lastOk ? { at: fmtDateTime(lastOk.started_at), hoursAgo: Math.round((Date.now() - new Date(lastOk.started_at).getTime()) / 3600e3), rows: lastOk.rows, bytes: lastOk.bytes } : null,
    recent: recent.rows.map((b) => ({ id: b.id, kind: b.kind, status: b.status, storage: b.storage, at: fmtDateTime(b.started_at), rows: b.rows, tables: b.tables, bytes: b.bytes,
      encrypted: b.encrypted, error: b.error, who: b.who ?? "Scheduled" })),
    tests: tests.rows.map((t) => ({ id: t.id, status: t.status, at: fmtDateTime(t.started_at), tables: t.tables, rows: t.rows, error: t.error, who: t.who ?? "Scheduled",
      problems: t.detail?.problems ?? [], fkChecked: t.detail?.fkChecked ?? null })),
  };
}

export async function paymentsState(userId) {
  const days = (await query(
    `WITH d AS (SELECT generate_series(${TODAY} - 13, ${TODAY}, interval '1 day')::date AS day), m AS (SELECT unnest($1::text[]) AS method)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day, m.method,
       (SELECT COALESCE(sum(p.amount), 0) FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE o.status <> 'Cancelled' AND p.method = m.method
          AND (p.paid_at AT TIME ZONE 'Africa/Lagos')::date = d.day) AS takings,
       (SELECT count(*)::int FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE o.status <> 'Cancelled' AND p.method = m.method
          AND (p.paid_at AT TIME ZONE 'Africa/Lagos')::date = d.day) AS orders,
       (SELECT COALESCE(sum(amount), 0) FROM refunds f WHERE f.status = 'Approved' AND f.method = m.method
          AND (f.decided_at AT TIME ZONE 'Africa/Lagos')::date = d.day) AS refunds
     FROM d CROSS JOIN m ORDER BY d.day DESC, m.method`, [RECON_METHODS])).rows;
  const recs = (await query(
    `SELECT r.*, to_char(r.day, 'YYYY-MM-DD') AS d, ru.name AS recorded_by_name, vu.name AS reviewed_by_name FROM payment_reconciliations r
     JOIN users ru ON ru.id = r.recorded_by LEFT JOIN users vu ON vu.id = r.reviewed_by
     WHERE r.day >= ${TODAY} - 13 OR r.status = 'Recorded' ORDER BY r.day DESC`)).rows;
  const today = lagosToday();
  const rows = days.map((d) => {
    const rec = recs.find((r) => r.d === d.day && r.method === d.method);
    const expected = d.takings - d.refunds;
    return {
      day: d.day, label: fmtDate(d.day), method: d.method, takings: d.takings, refunds: d.refunds, orders: d.orders, expected, isToday: d.day === today,
      rec: rec ? {
        id: rec.id, expected: rec.expected, actual: rec.actual, variance: rec.variance, statementRef: rec.statement_ref, note: rec.note, status: rec.status,
        recordedBy: rec.recorded_by_name, recordedAt: fmtDateTime(rec.recorded_at), mine: rec.recorded_by === userId,
        reviewedBy: rec.reviewed_by_name, reviewedAt: rec.reviewed_at ? fmtDateTime(rec.reviewed_at) : null, reviewNote: rec.review_note,
        drift: rec.status === "Recorded" && rec.expected !== expected,
      } : null,
    };
  }).filter((r) => r.orders > 0 || r.refunds > 0 || r.rec);
  const older = recs.filter((r) => !rows.some((x) => x.rec?.id === r.id)).map((r) => ({
    day: r.d, label: fmtDate(r.d), method: r.method, expected: r.expected, takings: null, refunds: null, orders: null,
    rec: { id: r.id, expected: r.expected, actual: r.actual, variance: r.variance, statementRef: r.statement_ref, note: r.note, status: r.status,
      recordedBy: r.recorded_by_name, recordedAt: fmtDateTime(r.recorded_at), mine: r.recorded_by === userId, drift: false },
  }));
  return { days: [...rows, ...older], outstanding: rows.filter((r) => !r.isToday && !r.rec).length };
}

export async function purchasesState(roles) {
  const pos = await loadPOs(`po.status IN ('Pending Approval','Approved','Partly Received') OR po.created_at > now() - interval '60 days'`);
  if (can(roles, "costs.view")) return pos;
  // Storekeepers: what to receive, never what it costs.
  return pos.map(({ total, invoiced, invoices, match, ...po }) => ({ ...po, lines: po.lines.map(({ unitCost, ...l }) => l) }));
}

export async function foodSafetyState() {
  const [lists, runs] = await Promise.all([
    query(`SELECT c.*, to_char(${PERIOD("daily")}, 'YYYY-MM-DD') AS today, to_char(${PERIOD("weekly")}, 'YYYY-MM-DD') AS week FROM haccp_checklists c ORDER BY c.active DESC, c.sort, c.name`),
    query(`SELECT r.*, to_char(r.period_start, 'YYYY-MM-DD') AS period, c.name, c.frequency, cu.name AS completed_by_name, vu.name AS verified_by_name
           FROM haccp_runs r JOIN haccp_checklists c ON c.id = r.checklist_id JOIN users cu ON cu.id = r.completed_by LEFT JOIN users vu ON vu.id = r.verified_by
           WHERE r.period_start >= ${TODAY} - 45 OR r.verified_by IS NULL ORDER BY r.completed_at DESC LIMIT 400`),
  ]);
  const mapRun = (r) => ({
    id: r.id, checklistId: r.checklist_id, checklist: r.name, frequency: r.frequency, period: r.period, periodLabel: fmtDate(r.period),
    allOk: r.all_ok, results: r.results, note: r.note, completedBy: r.completed_by_name, completedById: r.completed_by, completedAt: fmtDateTime(r.completed_at),
    verifiedBy: r.verified_by_name, verifiedAt: r.verified_at ? fmtDateTime(r.verified_at) : null, verifyNote: r.verify_note,
  });
  const all = runs.rows.map(mapRun);
  return {
    checklists: lists.rows.map((c) => {
      const period = c.frequency === "weekly" ? c.week : c.today;
      const current = all.find((r) => r.checklistId === c.id && r.period === period) ?? null;
      return { id: c.id, name: c.name, frequency: c.frequency, items: c.items, active: c.active, period, periodLabel: fmtDate(period), due: c.active && !current, current };
    }),
    runs: all,
  };
}

export async function businessNotifications(user) {
  const roles = user.roles, out = [];
  if (can(roles, "backups.manage")) {
    const cfg = backupConfig();
    if (cfg.mode === "manual") {
      if (!cfg.passphraseOk) out.push({ icon: "AlertTriangle", tone: "danger", route: "admin", text: "Set BACKUP_PASSPHRASE (12+ characters) in the app's settings on your host so the weekly backup file is encrypted." });
      const last = (await query("SELECT max(started_at) AS at FROM backups WHERE storage = 'download' AND status = 'Succeeded'")).rows[0].at;
      const days = last ? (Date.now() - new Date(last).getTime()) / 864e5 : null;
      const owner = can(roles, "backups.download");
      if (days == null || days >= WEEKLY_DAYS) {
        const late = days == null || days >= WEEKLY_DAYS * 2;
        if (owner || late) out.push({ icon: "AlertTriangle", tone: late ? "danger" : "warn", route: "admin",
          text: (days == null ? "No backup has been downloaded yet" : `Weekly backup is due — last downloaded ${Math.floor(days)} days ago`)
            + (owner ? ". Administration → Backups → Download weekly backup." : ". Ask the Super Admin to download it.") });
      }
    } else if (!cfg.ready) out.push({ icon: "AlertTriangle", tone: "danger", route: "admin", text: `Automatic off-site backups are off — ${cfg.problem}` });
    else {
      const last = (await query("SELECT max(started_at) AS at FROM backups WHERE status = 'Succeeded' AND storage = 's3'")).rows[0].at;
      const hrs = last ? (Date.now() - new Date(last).getTime()) / 3600e3 : null;
      if (hrs == null || hrs > 36) out.push({ icon: "AlertTriangle", tone: "danger", route: "admin", text: last ? `The last good backup was ${Math.round(hrs)} hours ago — check Administration → Backups.` : "No off-site backup has been made yet." });
      const t = (await query("SELECT status, started_at FROM restore_tests WHERE status <> 'Running' ORDER BY started_at DESC LIMIT 1")).rows[0];
      if (t?.status === "Failed") out.push({ icon: "AlertTriangle", tone: "danger", route: "admin", text: "The last backup restore test FAILED — backups may not be usable." });
      else if (last && (!t || Date.now() - new Date(t.started_at).getTime() > 35 * 864e5)) out.push({ icon: "ShieldCheck", tone: "warn", route: "admin", text: "No restore test in the last 35 days." });
    }
  }
  if (can(roles, "payments.reconcile")) {
    const p = (await query(
      `WITH d AS (SELECT generate_series(${TODAY} - 7, ${TODAY} - 1, interval '1 day')::date AS day)
       SELECT count(*)::int AS n FROM d CROSS JOIN unnest($1::text[]) m(method)
       WHERE EXISTS (SELECT 1 FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE o.status <> 'Cancelled' AND p.method = m.method AND (p.paid_at AT TIME ZONE 'Africa/Lagos')::date = d.day)
         AND NOT EXISTS (SELECT 1 FROM payment_reconciliations r WHERE r.day = d.day AND r.method = m.method)`, [RECON_METHODS])).rows[0];
    if (p.n) out.push({ icon: "DollarSign", tone: "warn", route: "payments", text: `${plural(p.n, "day")} of transfer / card takings not yet matched to the bank or terminal statement.` });
    const w = (await query("SELECT count(*)::int AS n FROM payment_reconciliations WHERE status = 'Recorded' AND recorded_by <> $1", [user.id])).rows[0];
    if (w.n) out.push({ icon: "DollarSign", tone: "burgundy", route: "payments", text: `${plural(w.n, "payment reconciliation")} waiting for sign-off.` });
  }
  if (can(roles, "purchasing.approve")) {
    const p = (await query("SELECT count(*)::int AS n, COALESCE(sum(total), 0) AS v FROM purchase_orders WHERE status = 'Pending Approval' AND created_by <> $1", [user.id])).rows[0];
    if (p.n) out.push({ icon: "Package", tone: "burgundy", route: "purchases", text: `${plural(p.n, "purchase order")} (${naira(p.v)}) waiting for approval.` });
  }
  if (can(roles, "stock.receive") && can(roles, "purchasing.view")) {
    const d = (await query(`SELECT count(*)::int AS n FROM purchase_orders WHERE status IN ('Approved','Partly Received') AND expected_on <= ${TODAY}`)).rows[0];
    if (d.n) out.push({ icon: "Truck", tone: "gold", route: "purchases", text: `${plural(d.n, "purchase order")} due for delivery — receive against the PO.` });
  }
  if (can(roles, "payables.pay")) {
    const pos = await loadPOs(`po.status IN ('Partly Received','Received','Closed') AND po.created_at > now() - interval '120 days'`);
    for (const po of pos.filter((p) => p.match.status === "Mismatch").slice(0, 3)) {
      out.push({ icon: "AlertTriangle", tone: "danger", route: "purchases", text: `${po.code} (${po.supplier}): invoiced ${naira(po.match.invoiced)} but goods received are worth ${naira(po.match.received)} — check before paying.` });
    }
  }
  if (can(roles, "haccp.complete")) {
    const d = (await query(`SELECT count(*)::int AS n FROM haccp_checklists c WHERE c.active AND NOT EXISTS
      (SELECT 1 FROM haccp_runs r WHERE r.checklist_id = c.id AND r.period_start = CASE WHEN c.frequency = 'weekly' THEN date_trunc('week', ${TODAY})::date ELSE ${TODAY} END)`)).rows[0];
    if (d.n) out.push({ icon: "ClipboardList", tone: "warn", route: "foodsafety", text: `${plural(d.n, "food-safety checklist")} due.` });
  }
  if (can(roles, "haccp.verify")) {
    const v = (await query("SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT all_ok)::int AS f FROM haccp_runs WHERE verified_by IS NULL AND completed_by <> $1", [user.id])).rows[0];
    if (v.f) out.push({ icon: "AlertTriangle", tone: "danger", route: "foodsafety", text: `${plural(v.f, "food-safety checklist")} with failed checks to verify.` });
    else if (v.n) out.push({ icon: "ShieldCheck", tone: "burgundy", route: "foodsafety", text: `${plural(v.n, "food-safety checklist")} waiting for verification.` });
  }
  return out;
}
