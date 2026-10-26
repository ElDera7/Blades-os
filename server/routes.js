import express from "express";
import { z } from "zod";
import { query, tx } from "./db.js";
import { authRoutes, loadUser, requireAuth, requirePerm, requirePasswordChange, hashPassword, publicUser, passwordRule, rolesOf, checkPassword, endSessions } from "./auth.js";
import { controlRoutes, requestAdjustment } from "./controls.js";
import { buildState } from "./state.js";
import { addStock, allocateStock, transferStock, returnAllocations } from "./stock.js";
import { openTill, operationRoutes } from "./operations.js";
import { businessRoutes } from "./business.js";
import { emailRoutes } from "./email.js";
import { posRoutes, recordPayment } from "./pos.js";
import { ROLES, LEADERSHIP_ROLES, SUPER_ADMIN, COMBINABLE_ROLES, ORDER_FLOW, can, PROCESSING_SKUS, CONTENT_STATUSES } from "../src/shared/permissions.js";
import { ah, parse, audit, bad, notFound, conflict, HttpError, round2, round3, fmtDateTime } from "./util.js";

const money = z.coerce.number().int().min(0).max(1e12);
const qtyNum = z.coerce.number().positive().max(1e6);
const id = z.coerce.number().int().positive();

export function apiRouter() {
  const r = express.Router();

  // Mutations must be JSON — together with SameSite=Lax cookies this blocks cross-site form CSRF.
  r.use((req, res, next) => {
    // DELETE is exempt: browsers can't send it cross-site without a CORS preflight, and it has no body.
    const formOk = req.path === "/public/unsubscribe";   // the unsubscribe page's own form, and mail apps' one-click unsubscribe
    if (!["GET", "HEAD", "DELETE"].includes(req.method) && !req.is("application/json") && !formOk) {
      return next(new HttpError(415, "Requests must be JSON."));
    }
    // A browser always says where a request came from; refuse changes started by any other site.
    const origin = req.get("origin");
    if (origin && !["GET", "HEAD"].includes(req.method) && !formOk) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed → refused below */ }
      if (host !== req.get("host")) return next(new HttpError(403, "Request refused: it came from another website."));
    }
    // Business data is never kept in browser or proxy caches.
    res.set("Cache-Control", "no-store");
    next();
  });

  r.use(loadUser);
  r.use(requirePasswordChange);

  authRoutes(r);

  /* ------------------------------------------------------------ state */
  r.get("/state", requireAuth, ah(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await buildState(req.user));
  }));

  /* ------------------------------------------------------------ livestock */
  const animalSchema = z.object({
    species: z.enum(["Cattle", "Goat", "Sheep"]),
    breed: z.string().trim().min(1).max(60),
    sex: z.enum(["Male", "Female"]),
    age: z.coerce.number().min(0).max(30),
    weight: z.coerce.number().positive().max(2000),
    cost: money.nullable().optional(),   // purchase cost — only roles with cost access may enter it
    ranch: z.string().trim().min(1),
    pen: z.string().trim().max(30).optional(),
    health: z.enum(["Healthy", "Under Observation"]),
    acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });

  r.post("/livestock", requirePerm("ranch.edit"), ah(async (req, res) => {
    const a = parse(animalSchema, req.body);
    if (a.cost != null && !can(req.user.roles, "costs.view")) throw new HttpError(403, "Purchase costs are entered by management.");
    const out = await tx(async (db) => {
      const ranch = (await db.query("SELECT id FROM ranches WHERE name = $1 AND active", [a.ranch])).rows[0];
      if (!ranch) throw bad("Unknown or retired ranch.");
      const n = (await db.query("SELECT nextval('livestock_code_seq') AS n")).rows[0].n;
      const prefix = a.species === "Cattle" ? "COW" : a.species === "Goat" ? "GT" : "SHP";
      const code = `${prefix}-${String(n).padStart(5, "0")}`;
      const { rows } = await db.query(
        `INSERT INTO livestock (code, tag, species, breed, sex, age_years, weight_kg, acquired_on, acquisition_cost, ranch_id, pen, health, vaccination, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, (now() AT TIME ZONE 'Africa/Lagos')::date),$9,$10,$11,$12,'Pending','Active') RETURNING code`,
        [code, `TAG-${1000 + Number(n)}`, a.species, a.breed, a.sex, a.age, a.weight, a.acquiredOn ?? null, a.cost ?? null, ranch.id, a.pen || "Pen 01", a.health]
      );
      await audit(db, req.user.id, `Added ${rows[0].code}`, `${a.species} · ${a.breed} · ${a.weight} KG`);
      return rows[0];
    });
    res.status(201).json(out);
  }));

  r.patch("/livestock/:code", requirePerm("ranch.edit"), ah(async (req, res) => {
    const b = parse(z.object({
      status: z.enum(["Active", "Growing", "Ready for Processing", "Ready for Sale", "Sold"]).optional(),
      weight: z.coerce.number().positive().max(2000).optional(),
      health: z.enum(["Healthy", "Under Observation"]).optional(),
      vaccination: z.string().trim().min(1).max(40).optional(),
      pen: z.string().trim().min(1).max(30).optional(),
      cost: money.optional(),
    }), req.body);
    if (b.cost !== undefined && !can(req.user.roles, "costs.view")) throw new HttpError(403, "Purchase costs are entered by management.");
    const out = await tx(async (db) => {
      const cur = (await db.query("SELECT * FROM livestock WHERE code = $1 FOR UPDATE", [req.params.code])).rows[0];
      if (!cur) throw notFound("Animal not found.");
      if (cur.status === "Processed") throw conflict("This animal has already been processed.");
      const next = { ...cur, status: b.status ?? cur.status, weight_kg: b.weight ?? cur.weight_kg, health: b.health ?? cur.health, vaccination: b.vaccination ?? cur.vaccination, pen: b.pen ?? cur.pen, cost: b.cost ?? cur.acquisition_cost };
      await db.query(
        "UPDATE livestock SET status=$2, weight_kg=$3, health=$4, vaccination=$5, pen=$6, acquisition_cost=$7, updated_at=now() WHERE id=$1",
        [cur.id, next.status, next.weight_kg, next.health, next.vaccination, next.pen, next.cost]
      );
      const changes = [
        b.status && b.status !== cur.status && `status ${cur.status} → ${b.status}`,
        b.weight && b.weight !== cur.weight_kg && `weight ${cur.weight_kg} → ${b.weight} KG`,
        b.health && b.health !== cur.health && `health → ${b.health}`,
        b.vaccination && b.vaccination !== cur.vaccination && `vaccination → ${b.vaccination}`,
        b.pen && b.pen !== cur.pen && `pen → ${b.pen}`,
        b.cost !== undefined && b.cost !== cur.acquisition_cost && `purchase cost ${cur.acquisition_cost == null ? "recorded" : "changed"}: ₦${b.cost.toLocaleString("en-NG")}`,
      ].filter(Boolean);
      if (changes.length) await audit(db, req.user.id, `Updated ${cur.code}`, changes.join(", "));
      return { code: cur.code };
    });
    res.json(out);
  }));

  /* ------------------------------------------------------------ processing */
  const kg = z.coerce.number().min(0).max(2000);
  r.post("/processing", requirePerm("processing.edit"), ah(async (req, res) => {
    const b = parse(z.object({
      animal: z.string().min(1),
      location: z.string().min(1),
      outputs: z.object({ premium: kg, stew: kg, boneless: kg, minced: kg, other: kg, bones: kg, offal: kg, fat: kg, kpomo: kg, waste: kg }),
    }), req.body);
    const o = b.outputs;
    const out = await tx(async (db) => {
      const animal = (await db.query("SELECT * FROM livestock WHERE code = $1 FOR UPDATE", [b.animal])).rows[0];
      if (!animal) throw notFound("Animal not found.");
      if (animal.status !== "Ready for Processing") throw conflict(`${animal.code} is not marked Ready for Processing.`);
      const loc = (await db.query("SELECT id FROM storage_locations WHERE name = $1 AND active", [b.location])).rows[0];
      if (!loc) throw bad("Unknown or retired storage location.");

      const saleable = round3(o.premium + o.stew + o.boneless + o.minced + o.other);
      const everything = saleable + o.bones + o.offal + o.fat + o.kpomo + o.waste;
      if (saleable <= 0) throw bad("Enter the saleable meat weights.");
      if (everything > animal.weight_kg + 1e-9) throw bad(`Outputs total ${round2(everything)} KG — more than the ${animal.weight_kg} KG live weight.`);
      const yieldPct = round2((saleable / animal.weight_kg) * 100);

      const n = (await db.query("SELECT nextval('batch_code_seq') AS n")).rows[0].n;
      const code = `PB-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;

      // Cattle cuts map to beef SKUs; goat and sheep meat go to their own SKUs.
      const skuQty = animal.species === "Cattle"
        ? { "PB-BEEF": o.premium, "STEW-BEEF": o.stew, "BL-BEEF": o.boneless, "MINCE-BEEF": o.minced, "OTH-BEEF": o.other }
        : { [animal.species === "Goat" ? "GOAT-MEAT" : "RAM-MEAT"]: saleable };
      if (o.kpomo > 0) skuQty.KPOMO = o.kpomo;

      for (const [sku, qty] of Object.entries(skuQty)) {
        if (qty > 0) await addStock(db, { sku, locationId: loc.id, qty: round3(qty), kind: "production", reference: code, userId: req.user.id, batch: code });
      }
      await db.query(
        `INSERT INTO processing_batches (code, livestock_id, live_weight, saleable_kg, yield_pct, outputs, location_id, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [code, animal.id, animal.weight_kg, saleable, yieldPct, JSON.stringify(o), loc.id, req.user.id]
      );
      await db.query("UPDATE livestock SET status = 'Processed', updated_at = now() WHERE id = $1", [animal.id]);
      await audit(db, req.user.id, `Completed batch ${code}`, `${animal.code} · ${yieldPct}% yield · ${saleable} KG to ${b.location}`);
      return { code, yield: yieldPct, saleable };
    });
    res.status(201).json(out);
  }));

  /* ------------------------------------------------------------ inventory */
  r.post("/inventory/transfer", requirePerm("stock.transfer"), ah(async (req, res) => {
    const b = parse(z.object({ sku: z.string().min(1), from: z.string().min(1), to: z.string().min(1), qty: qtyNum }), req.body);
    if (b.from === b.to) throw bad("Pick a different destination.");
    const out = await tx(async (db) => {
      const locs = (await db.query("SELECT id, name, active FROM storage_locations WHERE name = ANY($1)", [[b.from, b.to]])).rows;
      const from = locs.find((l) => l.name === b.from), to = locs.find((l) => l.name === b.to);
      if (!from || !to) throw bad("Unknown storage location.");
      if (!to.active) throw conflict(`${to.name} is retired.`);
      const p = (await db.query("SELECT name, unit FROM products WHERE sku = $1", [b.sku])).rows[0];
      if (!p) throw notFound("Product not found.");
      if (p.unit !== "KG" && !Number.isInteger(b.qty)) throw bad(`${p.unit} items must be moved in whole numbers.`);
      const ref = `TRF-${Date.now().toString(36).toUpperCase()}`;
      await transferStock(db, { sku: b.sku, fromId: from.id, toId: to.id, qty: b.qty, reference: ref, fromName: from.name, toName: to.name, userId: req.user.id });
      await audit(db, req.user.id, `Transferred ${b.qty} ${p.unit} ${p.name}`, `${from.name} → ${to.name}`);
      return { ok: true, name: p.name };
    });
    res.json(out);
  }));

  r.post("/inventory/adjust", requireAuth, ah(async (req, res) => {
    // Write-offs and count corrections go through approval (server/controls.js). Only receipts post here.
    if (req.body?.kind === "wastage" || req.body?.kind === "correction") return res.status(201).json(await requestAdjustment(req));
    if (!can(req.user.roles, "stock.receive")) throw new HttpError(403, "Your role can't receive stock.");
    const b = parse(z.object({
      sku: z.string().min(1),
      location: z.string().min(1),
      kind: z.literal("receipt"),
      qty: z.coerce.number().positive().max(1e6),
      note: z.string().trim().min(2, "add the supplier / delivery note reference").max(200),
      lot: z.string().trim().max(40).optional().or(z.literal("")),          // supplier batch / lot number
      expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),        // use-by date on the label
    }), req.body);
    const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
    if (b.expiresOn && b.expiresOn < today) throw bad("That use-by date has already passed — this stock can't be received for sale.");
    const out = await tx(async (db) => {
      const loc = (await db.query("SELECT id, name, active FROM storage_locations WHERE name = $1", [b.location])).rows[0];
      if (!loc) throw bad("Unknown storage location.");
      if (!loc.active) throw conflict(`${loc.name} is retired.`);
      const p = (await db.query("SELECT name, unit FROM products WHERE sku = $1 AND active", [b.sku])).rows[0];
      if (!p) throw notFound("Product not found.");
      if (p.unit !== "KG" && !Number.isInteger(b.qty)) throw bad(`${p.unit} items must be whole numbers.`);
      const ref = `GRN-${Date.now().toString(36).toUpperCase()}`;
      await addStock(db, { sku: b.sku, locationId: loc.id, qty: b.qty, kind: "receipt", reference: ref, note: b.note, userId: req.user.id,
        lot: { code: b.lot || ref, expiresOn: b.expiresOn } });
      await audit(db, req.user.id, `Received ${b.qty} ${p.unit} ${p.name}`, `${loc.name} · ${b.note}`);
      return { ok: true, name: p.name };
    });
    res.json(out);
  }));

  /* ------------------------------------------------------------ orders */
  r.patch("/orders/:code", requirePerm("orders.edit"), ah(async (req, res) => {
    const b = parse(z.object({
      status: z.enum([...ORDER_FLOW, "Cancelled"]).optional(),
      paymentStatus: z.enum(["Paid", "Pending"]).optional(),
      paymentMethod: z.enum(["Cash", "Transfer", "POS Card"]).optional(),
      paymentRef: z.string().trim().max(60).optional().or(z.literal("")),
    }), req.body);
    const out = await tx(async (db) => {
      const o = (await db.query("SELECT * FROM orders WHERE code = $1 FOR UPDATE", [req.params.code])).rows[0];
      if (!o) throw notFound("Order not found.");
      let cashSession = o.cash_session_id, method = o.payment_method;
      if (b.paymentStatus === "Paid" && o.payment_status !== "Paid") {
        method = b.paymentMethod ?? o.payment_method ?? "Cash";
        if (method === "Cash") {
          // Cash collected later (e.g. on delivery) must land in someone's open till so it's counted at close.
          const till = await openTill(db, req.user.id);
          if (!till) throw conflict("Open your till to receive cash, or record the payment as Transfer or POS Card.");
          cashSession = till.id;
        }
      }
      if (b.paymentStatus === "Pending" && o.payment_status === "Paid") throw conflict("A paid order can't be set back to unpaid — use a refund.");
      const nowPaid = b.paymentStatus === "Paid" && o.payment_status !== "Paid";
      if (o.status === "Cancelled") throw conflict("This order was cancelled.");
      const changes = [];
      if (b.status && b.status !== o.status) {
        // Once goods have been handed over, money goes back through a refund (with approval), never a cancellation.
        if (o.status === "Delivered" && b.status === "Cancelled") {
          throw conflict("A delivered order can't be cancelled. Request a refund for the items instead.");
        }
        if (b.status === "Cancelled") {
          // Put the stock back where it came from.
          const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1", [o.id])).rows;
          for (const it of items) {
            await returnAllocations(db, { sku: it.product_sku, allocations: it.allocations, kind: "return", reference: o.code, note: "Order cancelled", userId: req.user.id });
          }
        } else if (ORDER_FLOW.indexOf(b.status) < ORDER_FLOW.indexOf(o.status)) {
          throw conflict(`Can't move an order back from ${o.status} to ${b.status}.`);
        }
        changes.push(`${o.status} → ${b.status}`);
      }
      if (b.paymentStatus && b.paymentStatus !== o.payment_status) changes.push(`payment ${o.payment_status} → ${b.paymentStatus}${b.paymentStatus === "Paid" ? ` (${method})` : ""}`);
      if (!changes.length) return { ok: true };
      // paid_at = the day the money arrived — that's the day the bank / terminal statement shows it.
      await db.query(`UPDATE orders SET status = $2, payment_status = $3, payment_method = $4, cash_session_id = $5, updated_at = now(),
                        paid_at = CASE WHEN $6 THEN now() ELSE paid_at END, payment_ref = CASE WHEN $6 THEN $7 ELSE payment_ref END WHERE id = $1`,
        [o.id, b.status ?? o.status, b.paymentStatus ?? o.payment_status, method, cashSession, nowPaid, nowPaid && method !== "Cash" ? b.paymentRef || null : null]);
      if (nowPaid) {
        const till = await openTill(db, req.user.id);
        await recordPayment(db, { orderId: o.id, method, amount: o.total, tendered: method === "Cash" ? o.total : null,
          ref: method === "Cash" ? null : b.paymentRef || null, tillId: method === "Cash" ? cashSession : till?.id ?? null, userId: req.user.id });
      }
      await audit(db, req.user.id, `Updated ${o.code}`, changes.join(", "));
      return { ok: true };
    });
    res.json(out);
  }));

  r.get("/orders/:code", requirePerm("orders.view"), ah(async (req, res) => {
    const o = (await query(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS staff_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.user_id WHERE o.code = $1`,
      [req.params.code])).rows[0];
    if (!o) throw notFound("Order not found.");
    const [items, refunds, payments] = await Promise.all([
      query(`SELECT oi.id, oi.qty, oi.unit_price, oi.subtotal, oi.discount, oi.vat_rate, oi.tax, oi.refunded_qty, p.name, p.unit,
               COALESCE((SELECT sum(ri.qty) FROM refund_items ri JOIN refunds rf ON rf.id = ri.refund_id
                         WHERE ri.order_item_id = oi.id AND rf.status = 'Pending'), 0) AS pending_qty
             FROM order_items oi JOIN products p ON p.sku = oi.product_sku WHERE oi.order_id = $1 ORDER BY oi.id`, [o.id]),
      query(`SELECT rf.code, rf.amount, rf.reason, rf.status, rf.restock, rf.requested_at, u.name AS requested_by, d.name AS decided_by
             FROM refunds rf JOIN users u ON u.id = rf.requested_by LEFT JOIN users d ON d.id = rf.decided_by
             WHERE rf.order_id = $1 ORDER BY rf.requested_at DESC`, [o.id]),
      query(`SELECT method, amount, tendered, ref, paid_at FROM order_payments WHERE order_id = $1 ORDER BY id`, [o.id]),
    ]);
    const refundable = o.status === "Delivered" && o.payment_status === "Paid";
    res.json({
      code: o.code, customer: o.customer_name ?? "Walk-in Customer", phone: o.customer_phone, staff: o.staff_name,
      offlineNo: o.offline_no, syncedAt: o.synced_at ? fmtDateTime(o.synced_at) : null, offlineFlags: o.offline_flags,
      channel: o.channel, status: o.status, payment: o.payment_status, paymentMethod: o.payment_method, paymentRef: o.payment_ref, paidAt: o.paid_at ? fmtDateTime(o.paid_at) : null,
      total: o.total, refunded: o.refunded, netTotal: o.net_total, area: o.area, createdAt: o.created_at, refundable,
      gross: o.gross_total ?? o.total, discount: o.discount_total, discountReason: o.discount_reason, tax: o.tax_total, change: o.change_given,
      payments: payments.rows.map((x) => ({ method: x.method, amount: x.amount, tendered: x.tendered, ref: x.ref, at: fmtDateTime(x.paid_at) })),
      items: items.rows.map((i) => ({
        // price = what was actually paid per unit after discounts, so refunds give back exactly that
        id: i.id, name: i.name, unit: i.unit, qty: i.qty, listPrice: i.unit_price, price: i.qty ? i.subtotal / i.qty : i.unit_price, subtotal: i.subtotal,
        discount: i.discount, vatRate: i.vat_rate, tax: i.tax, refundedQty: i.refunded_qty,
        refundableQty: refundable ? round3(i.qty - i.refunded_qty - i.pending_qty) : 0,
      })),
      refunds: refunds.rows.map((x) => ({ code: x.code, amount: x.amount, reason: x.reason, status: x.status, restock: x.restock, requestedBy: x.requested_by, decidedBy: x.decided_by, at: x.requested_at })),
    });
  }));

  /* ------------------------------------------------------------ customers */
  /** The details a customer gives at the counter. Birthday is day + month only (no year needed for greetings). */
  const customerFields = {
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().regex(/^[+\d][\d\s-]{6,19}$/, "looks invalid").optional().or(z.literal("")),
    email: z.string().trim().toLowerCase().email("looks invalid").max(120).optional().or(z.literal("")),
    birthdayMonth: z.coerce.number().int().min(1).max(12).nullable().optional().or(z.literal("")),
    birthdayDay: z.coerce.number().int().min(1).max(31).nullable().optional().or(z.literal("")),
    area: z.string().trim().max(60).optional(),
    address: z.string().trim().max(200).optional(),
    marketingOk: z.boolean().optional(),
  };
  const birthday = (b) => {
    const m = b.birthdayMonth || null, d = b.birthdayDay || null;
    if (!m !== !d) throw bad("Give both the day and the month of the birthday, or neither.");
    if (m && d > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]) throw bad("That day doesn't exist in that month.");
    return [m, d];
  };

  r.post("/customers", requirePerm("customers.edit"), ah(async (req, res) => {
    const b = parse(z.object(customerFields), req.body);
    const [bm, bd] = birthday(b);
    const out = await tx(async (db) => {
      if (b.email && (await db.query("SELECT 1 FROM customers WHERE lower(email) = $1 AND erased_at IS NULL", [b.email])).rows[0]) throw conflict("A customer with that email already exists.");
      const n = (await db.query("SELECT nextval('customer_code_seq') AS n")).rows[0].n;
      const { rows } = await db.query(
        `INSERT INTO customers (code, name, phone, area, marketing_ok, email, birthday_month, birthday_day, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code, name`,
        [`CUST-${n}`, b.name, b.phone || null, b.area || null, !!b.marketingOk, b.email || null, bm, bd, b.address || null]
      );
      await audit(db, req.user.id, `Added customer ${b.name}`, `${rows[0].code}${b.marketingOk ? ", agreed to marketing" : ""}`);
      return rows[0];
    });
    res.status(201).json(out);
  }));

  /** Edit a customer's details; marketing consent is recorded when given and withdrawn whenever they ask (NDPA 2023). */
  r.patch("/customers/:id", requirePerm("customers.edit"), ah(async (req, res) => {
    const b = parse(z.object(customerFields).partial(), req.body);
    const out = await tx(async (db) => {
      const c = (await db.query("SELECT * FROM customers WHERE id = $1 AND erased_at IS NULL FOR UPDATE", [req.params.id])).rows[0];
      if (!c) throw notFound("Customer not found.");
      const touchBirthday = b.birthdayMonth !== undefined || b.birthdayDay !== undefined;
      const [bm, bd] = touchBirthday ? birthday({ birthdayMonth: b.birthdayMonth ?? c.birthday_month, birthdayDay: b.birthdayDay ?? c.birthday_day, ...b }) : [c.birthday_month, c.birthday_day];
      const email = b.email !== undefined ? b.email || null : c.email;
      if (email && email !== c.email && (await db.query("SELECT 1 FROM customers WHERE lower(email) = $1 AND id <> $2 AND erased_at IS NULL", [email, c.id])).rows[0]) throw conflict("Another customer already has that email.");
      const n = { name: b.name ?? c.name, phone: b.phone !== undefined ? b.phone || null : c.phone, area: b.area !== undefined ? b.area || null : c.area,
        address: b.address !== undefined ? b.address || null : c.address, email, bm, bd, mk: b.marketingOk ?? c.marketing_ok };
      await db.query(`UPDATE customers SET name=$2, phone=$3, area=$4, address=$5, email=$6, birthday_month=$7, birthday_day=$8, marketing_ok=$9,
                        unsubscribed_at = CASE WHEN $9 THEN NULL ELSE unsubscribed_at END WHERE id=$1`,
        [c.id, n.name, n.phone, n.area, n.address, n.email, n.bm, n.bd, n.mk]);
      const ch = [
        n.name !== c.name && "name", n.phone !== c.phone && "phone", n.email !== c.email && "email", n.area !== c.area && "area",
        n.address !== c.address && "address", (n.bm !== c.birthday_month || n.bd !== c.birthday_day) && "birthday",
      ].filter(Boolean);
      if (n.mk !== c.marketing_ok) await audit(db, req.user.id, `${n.mk ? "Recorded marketing consent for" : "Withdrew marketing consent for"} ${n.name}`, c.code);
      if (ch.length) await audit(db, req.user.id, `Updated customer ${n.name}`, `${c.code}: ${ch.join(", ")}`);
      return { ok: true };
    });
    res.json(out);
  }));

  /** Right to erasure: the person's details go; their sales stay (tax records) without a name or number. */
  r.post("/customers/:id/erase", requirePerm("customers.erase"), ah(async (req, res) => {
    const out = await tx(async (db) => {
      const c = (await db.query("SELECT * FROM customers WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!c || c.erased_at) throw notFound("Customer not found.");
      await db.query("UPDATE customers SET name = 'Erased customer', phone = NULL, area = NULL, email = NULL, address = NULL, birthday_month = NULL, birthday_day = NULL, marketing_ok = FALSE, erased_at = now() WHERE id = $1", [c.id]);
      await db.query("UPDATE orders SET note = NULL WHERE customer_id = $1 AND note IS NOT NULL", [c.id]);
      await db.query("DELETE FROM pos_held WHERE customer_id = $1", [c.id]);
      await audit(db, req.user.id, "Erased a customer's personal data on request", c.code);
      return { code: c.code };
    });
    res.json(out);
  }));

  /* ------------------------------------------------------------ setup: products */
  const productBody = z.object({
    name: z.string().trim().min(2).max(60),
    category: z.string().trim().min(2).max(30),
    unit: z.enum(["KG", "Unit", "Pack"]),
    price: money,
    costPrice: money,
    min: z.coerce.number().min(0).max(1e6),
    shelfLife: z.coerce.number().int().min(1).max(730).optional(),
    barcode: z.string().trim().regex(/^\d{8,14}$/, "8–14 digits (EAN / UPC)").nullable().optional().or(z.literal("")),
    plu: z.coerce.number().int().min(1).max(99999).nullable().optional().or(z.literal("")),
    vatRate: z.coerce.number().min(0).max(100).optional(),
    // A photo in the app (/products/…) or on the web (https://…), shown on the POS tile.
    image: z.string().trim().max(300).regex(/^(\/products\/[\w.-]+|https:\/\/\S+)$/, "use /products/<file> or an https:// link").nullable().optional().or(z.literal("")),
    trackStock: z.boolean().optional(),   // false: always sellable, never counted (e.g. a sealing service)
  });

  r.post("/products", requirePerm("products.edit"), ah(async (req, res) => {
    const b = parse(productBody.extend({ sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, "use 2–24 letters, numbers or dashes").optional() }), req.body);
    const sku = b.sku || b.name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
    if (sku.length < 2) throw bad("Give the product a SKU.");
    const out = await tx(async (db) => {
      const clash = (await db.query("SELECT sku, active FROM products WHERE sku = $1 OR lower(name) = lower($2)", [sku, b.name])).rows[0];
      if (clash) throw conflict(clash.sku === sku ? `SKU ${sku} is already used${clash.active ? "" : " by a retired product"}.` : `A product called "${b.name}" already exists.`);
      const sort = (await db.query("SELECT COALESCE(max(sort), 0) + 1 AS s FROM products")).rows[0].s;
      const plu = b.plu || (await db.query("SELECT COALESCE(max(plu), 0) + 1 AS n FROM products")).rows[0].n;  // next free PLU
      await db.query(
        `INSERT INTO products (sku, name, category, unit, price, cost_price, min_stock, sort, shelf_life_days, barcode, plu, vat_rate, image, track_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [sku, b.name, b.category, b.unit, b.price, b.costPrice, b.min, sort, b.shelfLife ?? 5, b.barcode || null, plu, b.vatRate ?? 0, b.image || null, b.trackStock ?? true]
      );
      await audit(db, req.user.id, `Added product ${b.name}`, `${sku} · ₦${b.price.toLocaleString("en-NG")}/${b.unit}`);
      return { sku, name: b.name };
    });
    res.status(201).json(out);
  }));

  r.patch("/products/:sku", requirePerm("products.edit"), ah(async (req, res) => {
    const b = parse(productBody.partial().extend({ active: z.boolean().optional() }), req.body);
    const out = await tx(async (db) => {
      const cur = (await db.query("SELECT * FROM products WHERE sku = $1 FOR UPDATE", [req.params.sku])).rows[0];
      if (!cur) throw notFound("Product not found.");
      if (b.unit && b.unit !== cur.unit) {
        const used = (await db.query("SELECT 1 FROM stock_movements WHERE product_sku = $1 LIMIT 1", [cur.sku])).rows[0];
        if (used) throw conflict("The unit can't change once stock has moved — add a new product instead.");
      }
      if (b.name && b.name.toLowerCase() !== cur.name.toLowerCase()) {
        const clash = (await db.query("SELECT 1 FROM products WHERE lower(name) = lower($1) AND sku <> $2", [b.name, cur.sku])).rows[0];
        if (clash) throw conflict(`A product called "${b.name}" already exists.`);
      }
      if (b.active === false && cur.active) {
        if (PROCESSING_SKUS.includes(cur.sku)) throw conflict(`${cur.name} receives processing output, so it can't be retired. You can rename it instead.`);
        const held = (await db.query("SELECT COALESCE(sum(qty), 0) AS q FROM stock WHERE product_sku = $1", [cur.sku])).rows[0].q;
        if (held > 0) throw conflict(`${cur.name} still has ${round3(held)} ${cur.unit} in stock. Sell, write off or correct it to zero first.`);
      }
      const n = { name: b.name ?? cur.name, category: b.category ?? cur.category, unit: b.unit ?? cur.unit, price: b.price ?? cur.price, cost: b.costPrice ?? cur.cost_price, min: b.min ?? cur.min_stock, active: b.active ?? cur.active, shelf: b.shelfLife ?? cur.shelf_life_days,
        barcode: b.barcode !== undefined ? b.barcode || null : cur.barcode, plu: b.plu !== undefined ? b.plu || null : cur.plu, vat: b.vatRate ?? Number(cur.vat_rate),
        image: b.image !== undefined ? b.image || null : cur.image, track: b.trackStock ?? cur.track_stock };
      if (n.track === false && cur.track_stock) {
        const held = (await db.query("SELECT COALESCE(sum(qty), 0) AS q FROM stock WHERE product_sku = $1", [cur.sku])).rows[0].q;
        if (held > 0) throw conflict(`${cur.name} still has ${round3(held)} ${cur.unit} in stock — bring it to zero before turning stock counting off.`);
      }
      await db.query("UPDATE products SET name=$2, category=$3, unit=$4, price=$5, cost_price=$6, min_stock=$7, active=$8, shelf_life_days=$9, barcode=$10, plu=$11, vat_rate=$12, image=$13, track_stock=$14 WHERE sku=$1",
        [cur.sku, n.name, n.category, n.unit, n.price, n.cost, n.min, n.active, n.shelf, n.barcode, n.plu, n.vat, n.image, n.track]);
      const fmt = (v) => `₦${v.toLocaleString("en-NG")}`;
      const ch = [
        n.name !== cur.name && `renamed from ${cur.name}`,
        n.category !== cur.category && `category → ${n.category}`,
        n.unit !== cur.unit && `unit → ${n.unit}`,
        n.price !== cur.price && `price ${fmt(cur.price)} → ${fmt(n.price)}`,
        n.cost !== cur.cost_price && `cost ${fmt(cur.cost_price)} → ${fmt(n.cost)}`,
        n.min !== cur.min_stock && `min stock ${cur.min_stock} → ${n.min}`,
        n.image !== cur.image && "photo changed",
        n.track !== cur.track_stock && (n.track ? "stock counting on" : "stock counting off"),
        n.active !== cur.active && (n.active ? "restored" : "retired"),
        n.shelf !== cur.shelf_life_days && `shelf life ${cur.shelf_life_days} → ${n.shelf} days`,
        n.barcode !== cur.barcode && `barcode → ${n.barcode ?? "none"}`,
        n.plu !== cur.plu && `PLU → ${n.plu ?? "none"}`,
        n.vat !== Number(cur.vat_rate) && `VAT ${Number(cur.vat_rate)}% → ${n.vat}%`,
      ].filter(Boolean);
      if (ch.length) await audit(db, req.user.id, `Updated ${n.name}`, ch.join(", "));
      return { ok: true };
    });
    res.json(out);
  }));

  /* ------------------------------------------------------------ setup: locations & ranches */
  const placeRoutes = (path, table, label, inUseSql, inUseMsg) => {
    r.post(`/${path}`, requirePerm("setup.manage"), ah(async (req, res) => {
      const b = parse(z.object({ name: z.string().trim().min(2).max(50) }), req.body);
      const out = await tx(async (db) => {
        const clash = (await db.query(`SELECT active FROM ${table} WHERE lower(name) = lower($1)`, [b.name])).rows[0];
        if (clash) throw conflict(clash.active ? `"${b.name}" already exists.` : `"${b.name}" exists but is retired — restore it instead.`);
        const extra = table === "storage_locations" ? ", sort" : "";
        const sortVal = table === "storage_locations" ? ", (SELECT COALESCE(max(sort), 0) + 1 FROM storage_locations)" : "";
        const { rows } = await db.query(`INSERT INTO ${table} (name${extra}) VALUES ($1${sortVal}) RETURNING id`, [b.name]);
        await audit(db, req.user.id, `Added ${label} ${b.name}`, null);
        return { id: rows[0].id, name: b.name };
      });
      res.status(201).json(out);
    }));
    r.patch(`/${path}/:id`, requirePerm("setup.manage"), ah(async (req, res) => {
      const b = parse(z.object({ name: z.string().trim().min(2).max(50).optional(), active: z.boolean().optional(), sellsFirst: z.boolean().optional(),
        tempMin: z.coerce.number().min(-60).max(60).nullable().optional(), tempMax: z.coerce.number().min(-60).max(60).nullable().optional() }), req.body);
      const out = await tx(async (db) => {
        const cur = (await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!cur) throw notFound(`${label[0].toUpperCase() + label.slice(1)} not found.`);
        if (b.name && b.name.toLowerCase() !== cur.name.toLowerCase()) {
          const clash = (await db.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id <> $2`, [b.name, cur.id])).rows[0];
          if (clash) throw conflict(`"${b.name}" already exists.`);
        }
        if (b.active === false && cur.active) {
          const used = (await db.query(inUseSql, [cur.id])).rows[0];
          if (used?.n > 0) throw conflict(inUseMsg(cur.name, used.n));
          const left = (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE active AND id <> $1`, [cur.id])).rows[0].n;
          if (left === 0) throw conflict(`You need at least one active ${label}.`);
        }
        await db.query(`UPDATE ${table} SET name = $2, active = $3 WHERE id = $1`, [cur.id, b.name ?? cur.name, b.active ?? cur.active]);
        const counter = table === "storage_locations" && b.sellsFirst !== undefined && b.sellsFirst !== cur.sells_first;
        if (counter) await db.query("UPDATE storage_locations SET sells_first = $2 WHERE id = $1", [cur.id, b.sellsFirst]);
        const temps = table === "storage_locations" && (b.tempMin !== undefined || b.tempMax !== undefined);
        if (temps) {
          const lo = b.tempMin !== undefined ? b.tempMin : cur.temp_min, hi = b.tempMax !== undefined ? b.tempMax : cur.temp_max;
          if (lo != null && hi != null && lo > hi) throw bad("The minimum temperature must be below the maximum.");
          await db.query("UPDATE storage_locations SET temp_min = $2, temp_max = $3 WHERE id = $1", [cur.id, lo, hi]);
        }
        const ch = [b.name && b.name !== cur.name && `renamed from ${cur.name}`, b.active !== undefined && b.active !== cur.active && (b.active ? "restored" : "retired"),
          counter && (b.sellsFirst ? "POS now sells from here first" : "no longer POS-first"),
          temps && `safe range ${b.tempMin ?? cur.temp_min}°C to ${b.tempMax ?? cur.temp_max}°C`].filter(Boolean);
        if (ch.length) await audit(db, req.user.id, `Updated ${label} ${b.name ?? cur.name}`, ch.join(", "));
        return { ok: true };
      });
      res.json(out);
    }));
  };
  placeRoutes("locations", "storage_locations", "storage location",
    "SELECT count(*)::int AS n FROM stock WHERE location_id = $1 AND qty > 0",
    (name, n) => `${name} still holds ${n} product${n === 1 ? "" : "s"}. Transfer the stock out first.`);
  placeRoutes("ranches", "ranches", "ranch",
    "SELECT count(*)::int AS n FROM livestock WHERE ranch_id = $1 AND status NOT IN ('Processed','Sold')",
    (name, n) => `${name} still has ${n} animal${n === 1 ? "" : "s"} on it.`);

  /* ------------------------------------------------------------ procurement */
  const supplierBody = z.object({
    name: z.string().trim().min(2).max(80),
    type: z.string().trim().min(2).max(40),
    contactName: z.string().trim().max(60).optional().or(z.literal("")),
    phone: z.string().trim().regex(/^[+\d][\d\s-]{6,19}$/, "looks invalid").optional().or(z.literal("")),
  });

  r.post("/suppliers", requirePerm("procurement.edit"), ah(async (req, res) => {
    const b = parse(supplierBody, req.body);
    const out = await tx(async (db) => {
      const clash = (await db.query("SELECT 1 FROM suppliers WHERE lower(name) = lower($1)", [b.name])).rows[0];
      if (clash) throw conflict(`A supplier called "${b.name}" already exists.`);
      const { rows } = await db.query("INSERT INTO suppliers (name, type, contact_name, phone) VALUES ($1,$2,$3,$4) RETURNING id",
        [b.name, b.type, b.contactName || null, b.phone || null]);
      await audit(db, req.user.id, `Added supplier ${b.name}`, b.type);
      return { id: rows[0].id, name: b.name };
    });
    res.status(201).json(out);
  }));

  r.patch("/suppliers/:id", requirePerm("procurement.edit"), ah(async (req, res) => {
    const b = parse(supplierBody.partial().extend({ active: z.boolean().optional() }), req.body);
    const out = await tx(async (db) => {
      const s = (await db.query("SELECT * FROM suppliers WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!s) throw notFound("Supplier not found.");
      if (b.name && b.name.toLowerCase() !== s.name.toLowerCase()) {
        const clash = (await db.query("SELECT 1 FROM suppliers WHERE lower(name) = lower($1) AND id <> $2", [b.name, s.id])).rows[0];
        if (clash) throw conflict(`A supplier called "${b.name}" already exists.`);
      }
      if (b.active === false && s.active) {
        const bal = (await db.query("SELECT COALESCE(sum(CASE WHEN kind='invoice' THEN amount ELSE -amount END), 0) AS b FROM supplier_entries WHERE supplier_id = $1", [s.id])).rows[0].b;
        if (bal > 0) throw conflict(`${s.name} still has ₦${bal.toLocaleString("en-NG")} outstanding.`);
      }
      const n = { name: b.name ?? s.name, type: b.type ?? s.type, contact: b.contactName !== undefined ? b.contactName || null : s.contact_name, phone: b.phone !== undefined ? b.phone || null : s.phone, active: b.active ?? s.active };
      await db.query("UPDATE suppliers SET name=$2, type=$3, contact_name=$4, phone=$5, active=$6 WHERE id=$1", [s.id, n.name, n.type, n.contact, n.phone, n.active]);
      const ch = [n.name !== s.name && `renamed from ${s.name}`, n.type !== s.type && `type → ${n.type}`, n.contact !== s.contact_name && "contact updated",
        n.phone !== s.phone && "phone updated", n.active !== s.active && (n.active ? "restored" : "retired")].filter(Boolean);
      if (ch.length) await audit(db, req.user.id, `Updated supplier ${n.name}`, ch.join(", "));
      return { ok: true };
    });
    res.json(out);
  }));

  r.post("/suppliers/:id/entries", requireAuth, ah(async (req, res) => {
    const b = parse(z.object({
      kind: z.enum(["invoice", "payment"]),
      amount: z.coerce.number().int().positive().max(1e12),
      reference: z.string().trim().max(60).optional().or(z.literal("")),
      note: z.string().trim().max(200).optional().or(z.literal("")),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      poCode: z.string().trim().max(20).optional().or(z.literal("")),   // invoice against a purchase order (3-way match)
    }), req.body);
    if (!can(req.user.roles, b.kind === "payment" ? "payables.pay" : "procurement.edit")) {
      throw new HttpError(403, b.kind === "payment" ? "Only an Owner, MD or Administrator can record supplier payments." : "Your role can't record supplier invoices.");
    }
    const out = await tx(async (db) => {
      const s = (await db.query("SELECT * FROM suppliers WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!s) throw notFound("Supplier not found.");
      if (!s.active) throw conflict("This supplier is retired.");
      if (b.date && b.date > new Date(Date.now() + 3600e3).toISOString().slice(0, 10)) throw bad("The date can't be in the future.");
      if (b.kind === "payment") {
        const bal = (await db.query("SELECT COALESCE(sum(CASE WHEN kind='invoice' THEN amount ELSE -amount END), 0) AS b FROM supplier_entries WHERE supplier_id = $1", [s.id])).rows[0].b;
        if (b.amount > bal) throw conflict(`That's more than the ₦${bal.toLocaleString("en-NG")} owed to ${s.name}.`);
      }
      let po = null;
      if (b.poCode && b.kind === "invoice") {
        po = (await db.query("SELECT id, code, supplier_id, status FROM purchase_orders WHERE upper(code) = upper($1)", [b.poCode])).rows[0];
        if (!po) throw bad(`No purchase order ${b.poCode}.`);
        if (po.supplier_id !== s.id) throw bad(`${po.code} is for a different supplier.`);
        if (["Pending Approval", "Rejected", "Cancelled"].includes(po.status)) throw conflict(`${po.code} is ${po.status.toLowerCase()} — nothing can be invoiced against it.`);
      }
      await db.query(
        `INSERT INTO supplier_entries (supplier_id, kind, amount, reference, note, entry_date, user_id, purchase_order_id)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, (now() AT TIME ZONE 'Africa/Lagos')::date),$7,$8)`,
        [s.id, b.kind, b.amount, b.reference || null, b.note || null, b.date ?? null, req.user.id, po?.id ?? null]
      );
      await audit(db, req.user.id, `${b.kind === "invoice" ? "Recorded invoice from" : "Paid"} ${s.name}`, `₦${b.amount.toLocaleString("en-NG")}${b.reference ? ` · ${b.reference}` : ""}${po ? ` · ${po.code}` : ""}`);
      return { ok: true, name: s.name };
    });
    res.status(201).json(out);
  }));

  /* ------------------------------------------------------------ marketing */
  const campaignBody = z.object({
    name: z.string().trim().min(2).max(80),
    platform: z.string().trim().min(2).max(60),
    budget: money, leads: z.coerce.number().int().min(0).max(1e7), orders: z.coerce.number().int().min(0).max(1e7), revenue: money,
  });
  r.post("/campaigns", requirePerm("marketing.edit"), ah(async (req, res) => {
    const b = parse(campaignBody, req.body);
    const { rows } = await query("INSERT INTO campaigns (name, platform, budget, leads, orders, revenue) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [b.name, b.platform, b.budget, b.leads, b.orders, b.revenue]);
    await audit(null, req.user.id, `Added campaign ${b.name}`, b.platform);
    res.status(201).json({ id: rows[0].id, name: b.name });
  }));
  r.patch("/campaigns/:id", requirePerm("marketing.edit"), ah(async (req, res) => {
    const b = parse(campaignBody.partial(), req.body);
    const out = await tx(async (db) => {
      const c0 = (await db.query("SELECT * FROM campaigns WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!c0) throw notFound("Campaign not found.");
      const n = { ...c0, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      await db.query("UPDATE campaigns SET name=$2, platform=$3, budget=$4, leads=$5, orders=$6, revenue=$7 WHERE id=$1",
        [c0.id, n.name, n.platform, n.budget, n.leads, n.orders, n.revenue]);
      await audit(db, req.user.id, `Updated campaign ${n.name}`, `${n.leads} leads · ${n.orders} orders · ₦${n.revenue.toLocaleString("en-NG")}`);
      return { ok: true };
    });
    res.json(out);
  }));
  r.delete("/campaigns/:id", requirePerm("marketing.edit"), ah(async (req, res) => {
    const { rows } = await query("DELETE FROM campaigns WHERE id = $1 RETURNING name", [req.params.id]);
    if (!rows[0]) throw notFound("Campaign not found.");
    await audit(null, req.user.id, `Deleted campaign ${rows[0].name}`, null);
    res.json({ ok: true });
  }));

  const postBody = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string().trim().min(2).max(120),
    type: z.string().trim().min(2).max(40),
    platform: z.string().trim().min(2).max(40),
    status: z.enum(CONTENT_STATUSES),
  });
  r.post("/content", requirePerm("marketing.edit"), ah(async (req, res) => {
    const b = parse(postBody, req.body);
    const { rows } = await query("INSERT INTO content_posts (post_date, title, type, platform, status, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [b.date, b.title, b.type, b.platform, b.status, req.user.id]);
    res.status(201).json({ id: rows[0].id });
  }));
  r.patch("/content/:id", requirePerm("marketing.edit"), ah(async (req, res) => {
    const b = parse(postBody.partial(), req.body);
    const cur = (await query("SELECT * FROM content_posts WHERE id = $1", [req.params.id])).rows[0];
    if (!cur) throw notFound("Post not found.");
    await query("UPDATE content_posts SET post_date=COALESCE($2::date, post_date), title=$3, type=$4, platform=$5, status=$6 WHERE id=$1",
      [cur.id, b.date ?? null, b.title ?? cur.title, b.type ?? cur.type, b.platform ?? cur.platform, b.status ?? cur.status]);
    if (b.status && b.status !== cur.status) await audit(null, req.user.id, `Content "${b.title ?? cur.title}"`, `${cur.status} → ${b.status}`);
    res.json({ ok: true });
  }));
  r.delete("/content/:id", requirePerm("marketing.edit"), ah(async (req, res) => {
    const { rows } = await query("DELETE FROM content_posts WHERE id = $1 RETURNING id", [req.params.id]);
    if (!rows[0]) throw notFound("Post not found.");
    res.json({ ok: true });
  }));

  /* ------------------------------------------------------------ users */
  const extraRolesSchema = z.array(z.enum(COMBINABLE_ROLES)).max(4).optional();
  // Leadership accounts (Super Admin, Owner, MD, Administrator) are granted and changed by the Super Admin only.
  const onlyOwnerFor = (actor, ...roles) => {
    if (roles.some((r) => LEADERSHIP_ROLES.includes(r)) && actor.role !== SUPER_ADMIN) {
      throw new HttpError(403, "Only the Super Admin can grant or change Super Admin, Owner, Managing Director or Administrator accounts.");
    }
  };
  const cleanExtras = (primary, extras = []) => {
    const list = [...new Set(extras)].filter((r) => r !== primary);
    if (list.length && LEADERSHIP_ROLES.includes(primary)) throw bad(`${primary} can't hold additional roles.`);
    return list;
  };

  r.post("/users", requirePerm("users.manage"), ah(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email(), role: z.enum(ROLES), extraRoles: extraRolesSchema, password: passwordRule }), req.body);
    onlyOwnerFor(req.user, b.role);
    checkPassword(b.password, b.email);
    const extras = cleanExtras(b.role, b.extraRoles);
    // A password set by someone else is temporary: the new user must replace it at first sign-in.
    const { rows } = await query(
      "INSERT INTO users (name, email, role, extra_roles, password_hash, must_change_password) VALUES ($1, lower($2), $3, $4, $5, TRUE) RETURNING *",
      [b.name, b.email, b.role, extras, await hashPassword(b.password)]
    );
    await audit(null, req.user.id, `Created user ${b.email}`, [b.role, ...extras].join(" + "));
    res.status(201).json(publicUser(rows[0]));
  }));

  r.patch("/users/:id", requirePerm("users.manage"), ah(async (req, res) => {
    const b = parse(z.object({ role: z.enum(ROLES).optional(), extraRoles: extraRolesSchema, active: z.boolean().optional(), password: passwordRule.optional(), name: z.string().trim().min(2).max(80).optional(), resetMfa: z.literal(true).optional() }), req.body);
    const out = await tx(async (db) => {
      const u = (await db.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!u) throw notFound("User not found.");
      onlyOwnerFor(req.user, u.role, ...(b.role ? [b.role] : []));
      const role = b.role ?? u.role;
      const extras = b.extraRoles !== undefined ? cleanExtras(role, b.extraRoles) : cleanExtras(role, LEADERSHIP_ROLES.includes(role) ? [] : u.extra_roles);
      const rolesChanged = role !== u.role || extras.join() !== (u.extra_roles || []).join();
      if (u.id === req.user.id && (b.active === false || rolesChanged)) throw bad("You can't deactivate or change the roles of your own account.");
      // Never leave the system without an active Super Admin.
      if (u.role === SUPER_ADMIN && (b.active === false || role !== SUPER_ADMIN)) {
        const supers = (await db.query("SELECT count(*)::int AS n FROM users WHERE role = $2 AND active AND id <> $1", [u.id, SUPER_ADMIN])).rows[0].n;
        if (supers === 0) throw conflict("There must be at least one active Super Admin.");
      }
      const reset = !!b.password;
      if (reset) checkPassword(b.password, u.email);
      if (b.resetMfa) {
        if (u.id === req.user.id) throw bad("You can't reset your own two-step sign-in. Use a recovery code, or ask the Super Admin.");
        await db.query("UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = NULL, recovery_codes = '{}' WHERE id = $1", [u.id]);
      }
      await db.query(
        `UPDATE users SET role=$2, extra_roles=$3, active=$4, name=$5, password_hash=COALESCE($6, password_hash),
           must_change_password = must_change_password OR $7, updated_at=now() WHERE id=$1`,
        [u.id, role, extras, b.active ?? u.active, b.name ?? u.name, reset ? await hashPassword(b.password) : null, reset && u.id !== req.user.id]
      );
      const ch = [
        rolesChanged && `roles ${rolesOf(u).join(" + ")} → ${[role, ...extras].join(" + ")}`,
        b.active !== undefined && b.active !== u.active && (b.active ? "reactivated" : "deactivated"),
        reset && "password reset (temporary)",
        b.resetMfa && "two-step sign-in reset (must set up again)",
        b.name && b.name !== u.name && `name → ${b.name}`,
      ].filter(Boolean);
      // Anything that changes what this person may do ends their open sessions: they sign in again under the new rules.
      if (reset || b.resetMfa || rolesChanged || b.active === false) {
        const ended = await endSessions(db, u.id, u.id === req.user.id ? req.sessionId : null);
        if (ended) ch.push(`signed out of ${ended} session${ended === 1 ? "" : "s"}`);
      }
      if (ch.length) await audit(db, req.user.id, `Updated user ${u.email}`, ch.join(", "));
      return { ok: true };
    });
    res.json(out);
  }));

  controlRoutes(r);
  operationRoutes(r);
  businessRoutes(r);
  emailRoutes(r);
  posRoutes(r);

  r.use((req, _res, next) => next(new HttpError(404, "Unknown API endpoint.")));
  return r;
}
