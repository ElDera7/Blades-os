import { query } from "./db.js";
import { can, ROLES, APPROVAL_PERMS, EXPIRY_WARN_DAYS } from "../src/shared/permissions.js";
import { approvalLimits, tillSummary } from "./operations.js";
import { fmtDate, fmtShort, fmtDateTime, round2 } from "./util.js";
import { posState, businessProfile } from "./pos.js";
import { emailMarketingState, emailNotifications } from "./email.js";
import { backupsState, paymentsState, purchasesState, foodSafetyState, businessNotifications } from "./business.js";

// SQL snippets — every "day" and "month" is measured in Lagos time.
const TODAY = `(now() AT TIME ZONE 'Africa/Lagos')::date`;
const LDAY = (col) => `(${col} AT TIME ZONE 'Africa/Lagos')::date`;
const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')`;
const IN_MONTH = (col) => `(${col} AT TIME ZONE 'Africa/Lagos') >= ${MONTH_START}`;

const one = async (sql, p) => (await query(sql, p)).rows[0];
const many = async (sql, p) => (await query(sql, p)).rows;
const pct = (a, b) => (b ? round2(((a - b) / b) * 100) : null);
const naira = (n) => "₦" + Math.round(n || 0).toLocaleString("en-NG");

/* ------------------------------------------------------------------ pieces */

async function meta() {
  const [locations, ranches] = await Promise.all([
    many("SELECT name FROM storage_locations WHERE active ORDER BY sort, name"),
    many("SELECT name FROM ranches WHERE active ORDER BY name"),
  ]);
  return { locations: locations.map((r) => r.name), ranches: ranches.map((r) => r.name), roles: ROLES };
}

async function inventory() {
  const [rows, lots] = await Promise.all([
    many(`
      SELECT p.sku, p.name, p.category, p.unit, p.price, p.cost_price, p.min_stock, p.shelf_life_days, p.barcode, p.plu, p.vat_rate, p.image, p.track_stock,
        COALESCE(sum(s.qty), 0) AS qty,
        COALESCE(json_agg(json_build_object('name', l.name, 'qty', s.qty, 'batch', s.last_batch) ORDER BY l.sells_first DESC, s.qty DESC)
          FILTER (WHERE s.qty > 0), '[]') AS locations
      FROM products p
      LEFT JOIN stock s ON s.product_sku = p.sku
      LEFT JOIN storage_locations l ON l.id = s.location_id
      WHERE p.active
      GROUP BY p.sku ORDER BY p.sort, p.name`),
    many(`SELECT sl.id, sl.product_sku, sl.lot_code, to_char(sl.expires_on, 'YYYY-MM-DD') AS expires, sl.qty, l.name AS location,
            (sl.expires_on - ${TODAY}) AS days_left
          FROM stock_lots sl JOIN storage_locations l ON l.id = sl.location_id
          WHERE sl.qty > 0 ORDER BY sl.expires_on, sl.id`),
  ]);
  return rows.map((r) => {
    const mine = lots.filter((l) => l.product_sku === r.sku).map((l) => ({
      id: l.id, code: l.lot_code, location: l.location, qty: round2(l.qty), expiresOn: fmtDate(l.expires), expires: l.expires,
      daysLeft: l.days_left, status: l.days_left < 0 ? "Expired" : l.days_left <= EXPIRY_WARN_DAYS ? "Use soon" : "OK",
    }));
    const expiredQty = round2(mine.filter((l) => l.status === "Expired").reduce((s, l) => s + l.qty, 0));
    return {
      sku: r.sku, name: r.name, cat: r.category, unit: r.unit, price: r.price, costPrice: r.cost_price, shelfLife: r.shelf_life_days,
      barcode: r.barcode, plu: r.plu, vatRate: Number(r.vat_rate) || 0, image: r.image, trackStock: r.track_stock,
      min: r.min_stock, qty: round2(r.qty), expiredQty, sellable: round2(r.qty - expiredQty),
      locations: r.locations.map((l) => ({ ...l, qty: Number(l.qty) })), lots: mine,
      location: r.locations[0]?.name ?? "—",
      batch: r.locations.find((l) => l.batch)?.batch ?? "—",
    };
  });
}

/** Cold-chain status per location with a safe range. */
async function coldChain() {
  const [locs, logs] = await Promise.all([
    many(`SELECT id, name, temp_min, temp_max FROM storage_locations WHERE active ORDER BY sort, name`),
    many(`SELECT t.location_id, t.reading_c, t.in_range, t.note, t.action, t.recorded_at, u.name AS who
          FROM temperature_logs t JOIN users u ON u.id = t.user_id WHERE t.recorded_at > now() - interval '7 days'
          ORDER BY t.recorded_at DESC`),
  ]);
  return locs.map((l) => {
    const mine = logs.filter((g) => g.location_id === l.id);
    const last = mine[0];
    const hoursSince = last ? (Date.now() - new Date(last.recorded_at).getTime()) / 3600e3 : null;
    return {
      id: l.id, name: l.name, min: l.temp_min, max: l.temp_max, monitored: l.temp_min != null || l.temp_max != null,
      last: last ? { reading: last.reading_c, inRange: last.in_range, at: fmtDateTime(last.recorded_at), who: last.who } : null,
      overdue: (l.temp_min != null || l.temp_max != null) && (hoursSince == null || hoursSince > 12),
      breaches24h: mine.filter((g) => !g.in_range && Date.now() - new Date(g.recorded_at).getTime() < 864e5).length,
      history: mine.slice(0, 20).map((g) => ({ reading: g.reading_c, inRange: g.in_range, at: fmtDateTime(g.recorded_at), who: g.who, note: g.note, action: g.action })),
    };
  });
}

async function stockCounts(roles) {
  const showFigures = can(roles, "counts.schedule");
  const rows = await many(`
    SELECT c.code, c.status, c.due_on, c.note, c.created_at, c.submitted_at, l.name AS location, u.name AS created_by, s.name AS submitted_by,
      (SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id) AS lines,
      (SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id AND x.counted_qty <> x.expected_qty) AS variances,
      (SELECT json_agg(json_build_object('product', p.name, 'unit', p.unit, 'expected', x.expected_qty, 'counted', x.counted_qty, 'adjustment', x.adjustment_code) ORDER BY p.sort)
         FROM stock_count_lines x JOIN products p ON p.sku = x.product_sku WHERE x.count_id = c.id AND x.counted_qty <> x.expected_qty) AS detail
    FROM stock_counts c JOIN storage_locations l ON l.id = c.location_id JOIN users u ON u.id = c.created_by LEFT JOIN users s ON s.id = c.submitted_by
    WHERE c.status = 'Open' OR c.created_at > now() - interval '30 days'
    ORDER BY (c.status = 'Open') DESC, c.due_on, c.created_at DESC`);
  return rows.map((c) => ({
    code: c.code, status: c.status, location: c.location, dueOn: fmtDate(c.due_on), overdue: c.status === "Open" && new Date(c.due_on) < new Date(new Date().toDateString()),
    note: c.note, createdBy: c.created_by, submittedBy: c.submitted_by, submittedAt: c.submitted_at ? fmtDateTime(c.submitted_at) : null,
    lines: c.lines, variances: c.variances, detail: showFigures ? (c.detail || []) : null,
  }));
}

async function tills(roles, userId) {
  const mine = await one(`SELECT * FROM till_sessions WHERE user_id = $1 AND status = 'Open'`, [userId]);
  let myTill = null;
  if (mine) {
    const sales = await one(`SELECT count(*)::int AS n FROM orders WHERE till_session_id = $1 AND status <> 'Cancelled'`, [mine.id]);
    // Blind count: the holder sees the float and how many sales, not what the drawer "should" hold.
    myTill = { code: mine.code, float: mine.opening_float, openedAt: fmtDateTime(mine.opened_at), sales: sales.n,
      stale: Date.now() - new Date(mine.opened_at).getTime() > 16 * 3600e3 };
  }
  const lastClosed = await one(`SELECT code, counted_cash, expected_cash, variance, status FROM till_sessions WHERE user_id = $1 AND status <> 'Open' ORDER BY closed_at DESC LIMIT 1`, [userId]);
  let review = [];
  if (can(roles, "till.review")) {
    const rows = await many(`SELECT t.*, u.name AS cashier, r.name AS reviewer FROM till_sessions t JOIN users u ON u.id = t.user_id LEFT JOIN users r ON r.id = t.reviewed_by
      WHERE t.status = 'Closed' OR (t.status = 'Reviewed' AND t.reviewed_at > now() - interval '14 days') OR t.status = 'Open'
      ORDER BY (t.status = 'Closed') DESC, t.closed_at DESC NULLS FIRST LIMIT 60`);
    review = await Promise.all(rows.map(async (t) => {
      const sum = t.status === "Open" ? null : await tillSummary({ query }, t);
      return {
        code: t.code, cashier: t.cashier, mine: t.user_id === userId, status: t.status, openedAt: fmtDateTime(t.opened_at),
        closedAt: t.closed_at ? fmtDateTime(t.closed_at) : null, float: t.opening_float, counted: t.counted_cash, expected: t.expected_cash,
        variance: t.variance, closeNote: t.close_note, reviewer: t.reviewer, reviewedAt: t.reviewed_at ? fmtDateTime(t.reviewed_at) : null, reviewNote: t.review_note,
        byMethod: sum?.byMethod ?? [], cashIn: sum?.cashIn ?? null, cashOut: sum?.cashOut ?? null,
      };
    }));
  }
  return { mine: myTill, lastClosed: lastClosed ? { code: lastClosed.code, variance: lastClosed.variance, status: lastClosed.status } : null, review };
}

async function ledger() {
  const rows = await many(`
    SELECT m.delta, m.kind, m.reference, m.note, m.created_at, p.name, p.unit, l.name AS loc, u.name AS who
    FROM stock_movements m JOIN products p ON p.sku = m.product_sku JOIN storage_locations l ON l.id = m.location_id
    LEFT JOIN users u ON u.id = m.user_id
    ORDER BY m.created_at DESC, m.id DESC LIMIT 40`);
  const label = { production: "Batch", sale: "Sale", transfer_in: "Transfer in", transfer_out: "Transfer out", receipt: "Received", wastage: "Wastage", correction: "Correction", return: "Returned" };
  return rows.map((r) => ({
    date: fmtShort(r.created_at),
    delta: `${r.delta > 0 ? "+" : ""}${round2(r.delta)} ${r.unit}`,
    desc: `${label[r.kind]} · ${r.name} · ${r.loc}${r.reference ? ` · ${r.reference}` : ""}`,
    who: r.who,
  }));
}

async function livestock() {
  const rows = await many(`
    SELECT a.*, r.name AS ranch FROM livestock a JOIN ranches r ON r.id = a.ranch_id
    ORDER BY (a.status = 'Ready for Processing') DESC, (a.status IN ('Processed','Sold')), a.acquired_on DESC, a.id DESC`);
  return rows.map((a) => ({
    id: a.code, tag: a.tag, species: a.species, breed: a.breed, sex: a.sex, age: `${a.age_years} yrs`, ageYears: a.age_years,
    weight: a.weight_kg, acquisitionDate: fmtDate(a.acquired_on), acquisitionCost: a.acquisition_cost, // null = not yet costed
    location: a.ranch, pen: a.pen, health: a.health, vaccination: a.vaccination, status: a.status,
  }));
}

async function ranchStats() {
  return one(`
    SELECT count(*) FILTER (WHERE status NOT IN ('Processed','Sold'))::int AS herd,
      count(*) FILTER (WHERE status NOT IN ('Processed','Sold') AND species = 'Cattle')::int AS cattle,
      count(*) FILTER (WHERE status NOT IN ('Processed','Sold') AND species <> 'Cattle')::int AS small,
      count(*) FILTER (WHERE status = 'Ready for Processing')::int AS ready,
      COALESCE(sum(acquisition_cost) FILTER (WHERE status NOT IN ('Processed','Sold')), 0) AS value,
      count(*) FILTER (WHERE status NOT IN ('Processed','Sold') AND acquisition_cost IS NULL)::int AS uncosted,
      count(DISTINCT ranch_id)::int AS ranches
    FROM livestock`);
}

async function processing() {
  const [log, stats] = await Promise.all([
    many(`SELECT b.code, b.live_weight, b.saleable_kg, b.yield_pct, b.processed_at, b.outputs, a.code AS animal, a.species
          FROM processing_batches b JOIN livestock a ON a.id = b.livestock_id ORDER BY b.processed_at DESC LIMIT 30`),
    one(`SELECT count(*) FILTER (WHERE ${IN_MONTH("processed_at")})::int AS batches_mtd,
           COALESCE(sum(saleable_kg) FILTER (WHERE ${IN_MONTH("processed_at")}), 0) AS kg_mtd,
           avg(yield_pct) FILTER (WHERE processed_at > now() - interval '30 days') AS yield_30d
         FROM processing_batches`),
  ]);
  return {
    log: log.map((b) => ({ id: b.code, animal: b.animal, species: b.species, live: b.live_weight, saleable: round2(b.saleable_kg), yield: b.yield_pct, waste: b.outputs.waste ?? 0, date: fmtDate(b.processed_at) })),
    stats: { batchesMtd: stats.batches_mtd, kgMtd: round2(stats.kg_mtd), avgYield: stats.yield_30d ? round2(stats.yield_30d) : null },
  };
}

async function orders(limit = 300, where = "TRUE") {
  const rows = await many(`
    SELECT o.code, o.channel, o.status, o.payment_status, o.total, o.refunded, o.area, o.created_at, o.offline_no, c.id AS customer_id, c.name AS customer,
      (SELECT string_agg(p.name, ', ' ORDER BY oi.id) FROM order_items oi JOIN products p ON p.sku = oi.product_sku WHERE oi.order_id = o.id) AS products,
      (SELECT sum(oi.qty) FROM order_items oi WHERE oi.order_id = o.id) AS qty
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${where}
    ORDER BY o.created_at DESC, o.id DESC LIMIT ${Number(limit)}`);
  return rows.map((o) => ({
    id: o.code, customerId: o.customer_id, customer: o.customer ?? "Walk-in Customer", product: o.products ?? "—", qty: o.qty,
    amount: o.total, refunded: o.refunded, payment: o.payment_status, status: o.status, channel: o.channel, area: o.area ?? "—", date: fmtDate(o.created_at), offlineNo: o.offline_no,
  }));
}

async function customers() {
  const rows = await many(`
    SELECT c.id, c.code, c.name, c.phone, c.area, c.marketing_ok, c.email, c.address, c.birthday_month, c.birthday_day, c.unsubscribed_at,
      count(o.id)::int AS orders, COALESCE(sum(o.net_total), 0) AS spent, max(o.created_at) AS last,
      (SELECT array_agg(name) FROM (
         SELECT p.name FROM order_items oi JOIN orders o2 ON o2.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
         WHERE o2.customer_id = c.id AND o2.status <> 'Cancelled' GROUP BY p.name ORDER BY count(*) DESC LIMIT 2) f) AS favourites,
      (SELECT json_agg(h) FROM (
         SELECT o3.code AS id, o3.total AS amount, o3.status, o3.created_at,
           (SELECT string_agg(p.name, ', ') FROM order_items oi JOIN products p ON p.sku = oi.product_sku WHERE oi.order_id = o3.id) AS product
         FROM orders o3 WHERE o3.customer_id = c.id ORDER BY o3.created_at DESC LIMIT 8) h) AS history
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'Cancelled'
    WHERE c.erased_at IS NULL
    GROUP BY c.id ORDER BY spent DESC, c.name`);
  return rows.map((c) => ({
    id: c.id, code: c.code, name: c.name, phone: c.phone ?? "—", area: c.area ?? "—", marketingOk: c.marketing_ok, email: c.email ?? "", address: c.address ?? "",
    birthdayMonth: c.birthday_month, birthdayDay: c.birthday_day, unsubscribed: !!c.unsubscribed_at, orders: c.orders, spent: c.spent,
    avg: c.orders ? Math.round(c.spent / c.orders) : 0, last: c.last ? fmtDate(c.last) : "No orders yet",
    favourites: c.favourites ?? [], history: (c.history ?? []).map((h) => ({ ...h, date: fmtDate(h.created_at) })),
  }));
}

async function dashboard() {
  const [kpi, kg, trend, top, inv, live, yld, low] = await Promise.all([
    one(`SELECT
        COALESCE(sum(net_total) FILTER (WHERE ${LDAY("created_at")} = ${TODAY}), 0) AS rev_today,
        COALESCE(sum(net_total) FILTER (WHERE ${LDAY("created_at")} = ${TODAY} - 1), 0) AS rev_yday,
        count(*) FILTER (WHERE ${LDAY("created_at")} = ${TODAY})::int AS ord_today,
        count(*) FILTER (WHERE ${LDAY("created_at")} = ${TODAY} - 1)::int AS ord_yday
      FROM orders WHERE status <> 'Cancelled' AND created_at > now() - interval '3 days'`),
    one(`SELECT COALESCE(sum(oi.net_qty) FILTER (WHERE ${LDAY("o.created_at")} = ${TODAY}), 0) AS today,
        COALESCE(sum(oi.net_qty) FILTER (WHERE ${LDAY("o.created_at")} = ${TODAY} - 1), 0) AS yday
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
      WHERE p.unit = 'KG' AND o.status <> 'Cancelled' AND o.created_at > now() - interval '3 days'`),
    many(`WITH days AS (SELECT generate_series(${TODAY} - 29, ${TODAY}, interval '1 day')::date AS d),
        o AS (SELECT ${LDAY("created_at")} AS d, sum(net_total) AS revenue, count(*) AS orders FROM orders
              WHERE status <> 'Cancelled' AND created_at > now() - interval '31 days' GROUP BY 1),
        k AS (SELECT ${LDAY("o.created_at")} AS d, sum(oi.net_qty) AS kg FROM order_items oi JOIN orders o ON o.id = oi.order_id
              JOIN products p ON p.sku = oi.product_sku WHERE p.unit = 'KG' AND o.status <> 'Cancelled' AND o.created_at > now() - interval '31 days' GROUP BY 1)
      SELECT days.d, COALESCE(o.revenue, 0) AS revenue, COALESCE(o.orders, 0)::int AS orders, COALESCE(k.kg, 0) AS kg
      FROM days LEFT JOIN o ON o.d = days.d LEFT JOIN k ON k.d = days.d ORDER BY days.d`),
    many(`SELECT p.name, p.unit,
        sum(oi.net_qty) FILTER (WHERE o.created_at > now() - interval '30 days') AS qty,
        COALESCE(sum(oi.net_subtotal) FILTER (WHERE o.created_at > now() - interval '30 days'), 0) AS revenue,
        COALESCE(sum(oi.net_subtotal) FILTER (WHERE o.created_at <= now() - interval '30 days'), 0) AS prev
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
      WHERE o.status <> 'Cancelled' AND o.created_at > now() - interval '60 days'
      GROUP BY p.name, p.unit ORDER BY revenue DESC LIMIT 5`),
    one(`SELECT COALESCE(sum(s.qty * p.cost_price), 0) AS value FROM stock s JOIN products p ON p.sku = s.product_sku`),
    one(`SELECT count(*)::int AS n FROM livestock WHERE status NOT IN ('Processed','Sold')`),
    one(`SELECT avg(yield_pct) AS y FROM (SELECT yield_pct FROM processing_batches ORDER BY processed_at DESC LIMIT 6) t`),
    one(`SELECT count(*)::int AS n FROM (SELECT p.sku FROM products p LEFT JOIN stock s ON s.product_sku = p.sku
         WHERE p.active GROUP BY p.sku HAVING COALESCE(sum(s.qty), 0) < max(p.min_stock)) t`),
  ]);
  return {
    todaysRevenue: kpi.rev_today, revenueChange: pct(kpi.rev_today, kpi.rev_yday),
    ordersToday: kpi.ord_today, ordersChange: kpi.ord_today - kpi.ord_yday,
    kgToday: round2(kg.today), kgChange: pct(kg.today, kg.yday),
    monthlyRevenue: trend.reduce((s, d) => s + d.revenue, 0),
    inventoryValue: Math.round(inv.value), activeLivestock: live.n,
    avgYield: yld.y ? round2(yld.y) : null, lowStock: low.n,
    salesTrend: trend.map((d) => ({ date: `${d.d.getDate()}/${d.d.getMonth() + 1}`, revenue: d.revenue, orders: d.orders, kg: round2(d.kg) })),
    topProducts: top.map((t) => ({ name: t.name, unit: t.unit === "KG" ? "KG" : `${t.unit}s`, qty: round2(t.qty || 0), revenue: t.revenue, growth: pct(t.revenue, t.prev) })),
  };
}

async function reports() {
  const [sales, best, invMoves, closing, ranch, proc, cust, mkt] = await Promise.all([
    one(`SELECT COALESCE(sum(net_total), 0) AS revenue, count(*)::int AS orders,
           (SELECT COALESCE(sum(amount), 0) FROM refunds WHERE status = 'Approved' AND ${IN_MONTH("decided_at")}) AS refunds,
           (SELECT COALESCE(sum(value_at_cost), 0) FROM stock_adjustments WHERE status = 'Approved' AND kind = 'wastage' AND ${IN_MONTH("decided_at")}) AS writeoffs
         FROM orders WHERE status <> 'Cancelled' AND ${IN_MONTH("created_at")}`),
    one(`SELECT p.name FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
         WHERE o.status <> 'Cancelled' AND ${IN_MONTH("o.created_at")} GROUP BY p.name ORDER BY sum(oi.net_subtotal) DESC LIMIT 1`),
    one(`SELECT COALESCE(sum(m.delta), 0) AS net,
           COALESCE(sum(m.delta) FILTER (WHERE m.kind = 'production'), 0) AS produced,
           COALESCE(-sum(m.delta) FILTER (WHERE m.kind IN ('sale')), 0) - COALESCE(sum(m.delta) FILTER (WHERE m.kind = 'return'), 0) AS sold,
           COALESCE(-sum(m.delta) FILTER (WHERE m.kind = 'wastage'), 0) AS wasted
         FROM stock_movements m JOIN products p ON p.sku = m.product_sku WHERE p.unit = 'KG' AND ${IN_MONTH("m.created_at")}`),
    one(`SELECT COALESCE(sum(s.qty), 0) AS kg FROM stock s JOIN products p ON p.sku = s.product_sku WHERE p.unit = 'KG'`),
    one(`SELECT count(*) FILTER (WHERE status NOT IN ('Processed','Sold'))::int AS animals,
           COALESCE(sum(acquisition_cost) FILTER (WHERE status NOT IN ('Processed','Sold')), 0) AS value,
           count(*) FILTER (WHERE status NOT IN ('Processed','Sold') AND acquisition_cost IS NULL)::int AS uncosted,
           (SELECT count(*)::int FROM processing_batches WHERE ${IN_MONTH("processed_at")}) AS processed,
           (SELECT avg(a.age_years) FROM processing_batches b JOIN livestock a ON a.id = b.livestock_id WHERE b.processed_at > now() - interval '90 days') AS age
         FROM livestock`),
    one(`SELECT COALESCE(sum(live_weight), 0) AS input, COALESCE(sum(saleable_kg), 0) AS output, avg(yield_pct) AS yield,
           COALESCE(sum((outputs->>'waste')::numeric), 0) AS waste
         FROM processing_batches WHERE ${IN_MONTH("processed_at")}`),
    one(`WITH s AS (SELECT c.id, count(o.id) AS n, COALESCE(sum(o.net_total), 0) AS spent FROM customers c
           LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'Cancelled' GROUP BY c.id)
         SELECT (SELECT count(*)::int FROM customers WHERE ${IN_MONTH("created_at")}) AS new,
           count(*) FILTER (WHERE n > 1)::float / NULLIF(count(*) FILTER (WHERE n > 0), 0) AS returning,
           max(spent) AS top, avg(spent) FILTER (WHERE n > 0) AS avg FROM s`),
    one(`SELECT COALESCE(sum(leads), 0)::int AS leads, COALESCE(sum(budget), 0) AS spend, COALESCE(sum(revenue), 0) AS revenue,
           COALESCE(sum(orders), 0)::int AS orders FROM campaigns`),
  ]);
  // Share of weighed (KG) lines at the counter that came straight off the scale rather than typed in.
  const scale = await one(`SELECT count(*)::int AS lines, count(*) FILTER (WHERE oi.scale_weighed)::int AS weighed
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
    WHERE p.unit = 'KG' AND o.channel = 'POS' AND o.status <> 'Cancelled' AND ${IN_MONTH("o.created_at")}`);
  return {
    sales: [
      { label: "Revenue (MTD)", value: naira(sales.revenue), icon: "DollarSign" },
      { label: "Orders (MTD)", value: sales.orders.toLocaleString("en-NG"), icon: "ClipboardList" },
      { label: "Average Order", value: naira(sales.orders ? sales.revenue / sales.orders : 0), icon: "Activity" },
      { label: "Best Seller", value: best?.name ?? "—", icon: "TrendingUp" },
      { label: "Refunds (MTD)", value: naira(sales.refunds), icon: "AlertTriangle" },
      { label: "KG Sales Weighed on Scale", value: scale.lines ? `${Math.round((scale.weighed / scale.lines) * 100)}%` : "—", sub: scale.lines ? `${scale.weighed} of ${scale.lines} counter lines` : undefined, icon: "Activity" },
    ],
    inventory: [
      { label: "Opening Stock (KG)", value: round2(closing.kg - invMoves.net).toLocaleString("en-NG"), icon: "Boxes" },
      { label: "Production (KG)", value: round2(invMoves.produced).toLocaleString("en-NG"), icon: "Scissors" },
      { label: "Sales (KG)", value: round2(invMoves.sold).toLocaleString("en-NG"), icon: "ShoppingCart" },
      { label: "Closing Stock (KG)", value: round2(closing.kg).toLocaleString("en-NG"), icon: "Warehouse" },
      { label: "Write-offs (MTD, at cost)", value: naira(sales.writeoffs), icon: "AlertTriangle" },
    ],
    ranch: [
      { label: "Animals on Ranch", value: ranch.animals, icon: "Beef" },
      { label: "Processed (MTD)", value: ranch.processed, icon: "Scissors" },
      { label: "Herd Value (cost)", value: naira(ranch.value) + (ranch.uncosted ? ` + ${ranch.uncosted} uncosted` : ""), icon: "DollarSign" },
      { label: "Avg. Age at Processing", value: ranch.age ? `${round2(ranch.age)} yrs` : "—", icon: "Calendar" },
    ],
    processing: [
      { label: "Input (KG)", value: round2(proc.input).toLocaleString("en-NG"), icon: "Beef" },
      { label: "Output (KG)", value: round2(proc.output).toLocaleString("en-NG"), icon: "Scissors" },
      { label: "Avg. Yield", value: proc.yield ? `${round2(proc.yield)}%` : "—", icon: "Activity" },
      { label: "Waste (KG)", value: round2(proc.waste + invMoves.wasted).toLocaleString("en-NG"), icon: "AlertTriangle" },
    ],
    customer: [
      { label: "New Customers (MTD)", value: cust.new, icon: "Users" },
      { label: "Returning Rate", value: cust.returning != null ? `${Math.round(cust.returning * 100)}%` : "—", icon: "Activity" },
      { label: "Top Customer Spend", value: naira(cust.top), icon: "DollarSign" },
      { label: "Avg. Customer Spend", value: naira(cust.avg), icon: "TrendingUp" },
    ],
    marketing: [
      { label: "Campaign Leads", value: mkt.leads.toLocaleString("en-NG"), icon: "MessageCircle" },
      { label: "Campaign Orders", value: mkt.orders.toLocaleString("en-NG"), icon: "ClipboardList" },
      { label: "Ad Spend", value: naira(mkt.spend), icon: "DollarSign" },
      { label: "Blended ROAS", value: mkt.spend ? `${round2(mkt.revenue / mkt.spend)}x` : "—", icon: "TrendingUp" },
    ],
  };
}

async function insights() {
  const [best, low, waste, lapsed, worst, weekend, camp, ready] = await Promise.all([
    many(`SELECT p.name, p.unit, sum(oi.net_qty) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
          WHERE o.status <> 'Cancelled' AND o.created_at > now() - interval '30 days' GROUP BY p.name, p.unit ORDER BY sum(oi.net_subtotal) DESC LIMIT 3`),
    many(`SELECT p.name, COALESCE(sum(s.qty), 0) AS qty, p.min_stock, p.unit FROM products p LEFT JOIN stock s ON s.product_sku = p.sku
          WHERE p.active GROUP BY p.sku HAVING COALESCE(sum(s.qty), 0) < p.min_stock ORDER BY p.name`),
    one(`SELECT COALESCE((SELECT sum((outputs->>'waste')::numeric) FROM processing_batches WHERE ${IN_MONTH("processed_at")}), 0) AS proc,
           COALESCE((SELECT -sum(m.delta) FROM stock_movements m WHERE m.kind = 'wastage' AND ${IN_MONTH("m.created_at")}), 0) AS store,
           COALESCE((SELECT -sum(m.delta * p.cost_price) FROM stock_movements m JOIN products p ON p.sku = m.product_sku WHERE m.kind = 'wastage' AND ${IN_MONTH("m.created_at")}), 0) AS store_cost`),
    many(`SELECT c.name, max(o.created_at) AS last FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status <> 'Cancelled'
          WHERE c.erased_at IS NULL GROUP BY c.id HAVING max(o.created_at) < now() - interval '21 days' ORDER BY sum(o.net_total) DESC LIMIT 3`),
    one(`SELECT b.code, b.yield_pct FROM processing_batches b WHERE b.processed_at > now() - interval '30 days' ORDER BY b.yield_pct ASC LIMIT 1`),
    // "Last weekend" = the most recent fully completed Fri–Sun.
    one(`WITH t AS (SELECT ${TODAY} AS d, extract(isodow FROM ${TODAY})::int AS w),
           f AS (SELECT d - ((w + 2) % 7) - CASE WHEN w >= 5 THEN 7 ELSE 0 END AS fri FROM t),
           daily AS (SELECT ${LDAY("created_at")} AS day, sum(net_total) AS rev FROM orders
                     WHERE status <> 'Cancelled' AND created_at > now() - interval '29 days' GROUP BY 1)
         SELECT (SELECT sum(rev) FROM daily, f WHERE day BETWEEN f.fri AND f.fri + 2) AS weekend,
                (SELECT avg(rev) FROM daily WHERE extract(isodow FROM day) BETWEEN 1 AND 4) AS weekday_avg`),
    one(`SELECT name, orders FROM campaigns ORDER BY orders DESC LIMIT 1`),
    one(`SELECT count(*)::int AS n FROM livestock WHERE status = 'Ready for Processing'`),
  ]);
  const fmtQ = (r) => `${round2(r.qty)} ${r.unit === "KG" ? "KG" : `${r.unit.toLowerCase()}s`}`;
  return [
    { q: "What are our best-selling meats this month?",
      a: best.length ? `${best[0].name} leads with ${fmtQ(best[0])} sold in the last 30 days${best[1] ? `, followed by ${best.slice(1).map((b) => `${b.name} (${fmtQ(b)})`).join(" and ")}` : ""}.` : "No sales recorded in the last 30 days yet." },
    { q: "Which products are low in stock?",
      a: low.length ? `${low.map((l) => `${l.name} (${round2(l.qty)} of ${l.min_stock} ${l.unit} minimum)`).join(", ")} ${low.length === 1 ? "is" : "are"} below minimum stock.` : "Nothing is below its minimum stock level right now." },
    { q: "How much meat did we waste this month?",
      a: `${round2(waste.proc + waste.store)} KG this month — ${round2(waste.proc)} KG trimmed during processing and ${round2(waste.store)} KG written off from storage${waste.store_cost ? ` (about ${naira(waste.store_cost)} at cost)` : ""}.` },
    { q: "Which customers haven't ordered recently?",
      a: lapsed.length ? `${lapsed.map((c) => `${c.name} (last order ${fmtDate(c.last)})`).join(", ")} ${lapsed.length === 1 ? "hasn't" : "haven't"} ordered in over 3 weeks — worth a re-engagement offer.` : "Every customer with an order history has ordered in the last 3 weeks." },
    { q: "Which processing batch had the lowest yield?",
      a: worst ? `Batch ${worst.code} had the lowest yield in the last 30 days at ${worst.yield_pct}%.` : "No batches processed in the last 30 days." },
    { q: "What was our revenue last weekend?",
      a: weekend?.weekend ? `Weekend revenue (Fri–Sun) came to ${naira(weekend.weekend)}${weekend.weekday_avg ? ` — ${naira(weekend.weekend / 3)} a day versus a ${naira(weekend.weekday_avg)} weekday average` : ""}.` : "No weekend sales recorded in the last two weeks." },
    { q: "Which marketing campaign generated the most orders?",
      a: camp ? `${camp.name} generated the most orders (${camp.orders}).` : "No campaigns have been recorded yet." },
    { q: "How many animals are ready for processing?",
      a: `${ready.n} animal${ready.n === 1 ? " is" : "s are"} flagged Ready for Processing across both ranches.` },
  ];
}

async function notifications(user) {
  const out = [];
  const roles = user.roles;
  const waiting = [];
  if (can(roles, "stock.adjust.approve")) waiting.push(one(`SELECT count(*)::int AS n FROM stock_adjustments WHERE status = 'Pending' AND requested_by <> $1`, [user.id]));
  if (can(roles, "refunds.approve")) waiting.push(one(`SELECT count(*)::int AS n FROM refunds WHERE status = 'Pending' AND requested_by <> $1`, [user.id]));
  const pending = (await Promise.all(waiting)).reduce((s, x) => s + x.n, 0);
  if (pending) out.push({ icon: "ShieldCheck", tone: "burgundy", route: "approvals", text: `${pending} request${pending === 1 ? "" : "s"} waiting for your approval.` });
  if (can(roles, "inventory.view")) {
    const ex = await one(`SELECT count(DISTINCT sl.product_sku) FILTER (WHERE sl.expires_on < ${TODAY})::int AS expired,
        count(DISTINCT sl.product_sku) FILTER (WHERE sl.expires_on >= ${TODAY} AND sl.expires_on <= ${TODAY} + ${EXPIRY_WARN_DAYS})::int AS soon
      FROM stock_lots sl JOIN products p ON p.sku = sl.product_sku WHERE sl.qty > 0 AND p.active`);
    if (ex.expired) out.push({ icon: "AlertTriangle", tone: "danger", route: "inventory", text: `${ex.expired} product${ex.expired === 1 ? " has" : "s have"} stock past its use-by date — it can't be sold; write it off.` });
    if (ex.soon) out.push({ icon: "Calendar", tone: "warn", route: "inventory", text: `${ex.soon} product${ex.soon === 1 ? " has" : "s have"} a batch reaching its use-by date within ${EXPIRY_WARN_DAYS} days.` });
    const cc = await coldChain();
    const breach = cc.filter((l) => l.last && !l.last.inRange);
    for (const l of breach) out.push({ icon: "Snowflake", tone: "danger", route: "inventory", text: `${l.name} last read ${l.last.reading}°C — outside its ${l.min}°C to ${l.max}°C safe range.` });
    const overdue = cc.filter((l) => l.overdue);
    if (overdue.length && can(roles, "temps.record")) out.push({ icon: "Snowflake", tone: "warn", route: "inventory", text: `Temperature check overdue (12h+): ${overdue.map((l) => l.name).join(", ")}.` });
  }
  if (can(roles, "counts.perform")) {
    const due = await one(`SELECT count(*)::int AS n FROM stock_counts WHERE status = 'Open' AND due_on <= ${TODAY}`);
    if (due.n) out.push({ icon: "ClipboardList", tone: "burgundy", route: "inventory", text: `${due.n} stock count${due.n === 1 ? " is" : "s are"} due.` });
  }
  if (can(roles, "till.review") || can(roles, "counts.schedule")) {
    // Sales uploaded from a till that was offline, where the system had less stock than was sold.
    const short = await many(`SELECT DISTINCT p.name FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.sku = oi.product_sku
      WHERE oi.offline_short > 0 AND o.synced_at > now() - interval '7 days' ORDER BY p.name`);
    if (short.length) out.push({ icon: "ClipboardList", tone: "warn", route: "inventory", text: `Sold offline beyond recorded stock: ${short.map((x) => x.name).join(", ")} — schedule a count.` });
    const up = await one(`SELECT count(*)::int AS n, COALESCE(sum(total), 0) AS v FROM orders WHERE synced_at > now() - interval '24 hours'`);
    if (up.n) out.push({ icon: "DollarSign", tone: "muted", route: "orders", text: `${up.n} sale${up.n === 1 ? "" : "s"} (${naira(up.v)}) uploaded from a till that was offline in the last 24 hours.` });
    const look = await one(`SELECT count(*)::int AS n FROM orders WHERE offline_flags IS NOT NULL AND synced_at > now() - interval '7 days'`);
    if (look.n) out.push({ icon: "AlertTriangle", tone: "danger", route: "orders", text: `${look.n} sale${look.n === 1 ? "" : "s"} uploaded from an offline till with something to check (price, till or customer) — open the order.` });
  }
  if (can(roles, "till.review")) {
    const t = await one(`SELECT count(*)::int AS n FROM till_sessions WHERE status = 'Closed' AND user_id <> $1`, [user.id]);
    if (t.n) out.push({ icon: "DollarSign", tone: "burgundy", route: "approvals", text: `${t.n} till cash-up${t.n === 1 ? "" : "s"} waiting for sign-off.` });
    const stale = await one(`SELECT count(*)::int AS n FROM till_sessions WHERE status = 'Open' AND opened_at < now() - interval '16 hours'`);
    if (stale.n) out.push({ icon: "DollarSign", tone: "danger", route: "approvals", text: `${stale.n} till${stale.n === 1 ? " has" : "s have"} been open for over 16 hours — it wasn't closed at end of day.` });
  }
  if (can(roles, "costs.view") && can(roles, "ranch.view")) {
    const u = await one(`SELECT count(*)::int AS n FROM livestock WHERE acquisition_cost IS NULL AND status NOT IN ('Processed','Sold')`);
    if (u.n) out.push({ icon: "Beef", tone: "gold", route: "ranch", text: `${u.n} animal${u.n === 1 ? " has" : "s have"} no purchase cost recorded.` });
  }
  if (can(user.roles, "inventory.view")) {
    const low = await many(`SELECT p.name FROM products p LEFT JOIN stock s ON s.product_sku = p.sku WHERE p.active
      GROUP BY p.sku HAVING COALESCE(sum(s.qty), 0) < p.min_stock ORDER BY p.name`);
    if (low.length) out.push({ icon: "AlertTriangle", tone: "warn", route: "inventory",
      text: `${low.slice(0, 3).map((l) => l.name).join(", ")}${low.length > 3 ? ` +${low.length - 3} more` : ""} below minimum stock.` });
  }
  if (can(user.roles, "processing.view")) {
    const b = await one(`SELECT code, yield_pct FROM processing_batches WHERE processed_at > now() - interval '14 days' AND yield_pct < 65 ORDER BY yield_pct LIMIT 1`);
    if (b) out.push({ icon: "Scissors", tone: "gold", route: "processing", text: `Batch ${b.code} had unusually low yield (${b.yield_pct}%).` });
  }
  if (can(user.roles, "ranch.view")) {
    const r = await one(`SELECT count(*)::int AS n FROM livestock WHERE status = 'Ready for Processing'`);
    if (r.n) out.push({ icon: "Beef", tone: "burgundy", route: "processing", text: `${r.n} animal${r.n === 1 ? " is" : "s are"} ready for processing.` });
  }
  if (can(user.roles, "procurement.view")) {
    const s = await many(`SELECT s.name, sum(CASE WHEN e.kind = 'invoice' THEN e.amount ELSE -e.amount END) AS pending
      FROM suppliers s JOIN supplier_entries e ON e.supplier_id = s.id GROUP BY s.id
      HAVING sum(CASE WHEN e.kind = 'invoice' THEN e.amount ELSE -e.amount END) > 0 ORDER BY pending DESC`);
    for (const x of s.slice(0, 2)) out.push({ icon: "Package", tone: "danger", route: "procurement", text: `${naira(x.pending)} supplier invoice pending — ${x.name}.` });
  }
  if (can(user.roles, "delivery.view")) {
    const d = await one(`SELECT count(*)::int AS n FROM orders WHERE channel = 'Delivery' AND status NOT IN ('Delivered','Cancelled')`);
    if (d.n) out.push({ icon: "Truck", tone: "muted", route: "delivery", text: `${d.n} order${d.n === 1 ? " is" : "s are"} awaiting delivery.` });
  }
  if (can(user.roles, "orders.view")) {
    const p = await one(`SELECT count(*)::int AS n, COALESCE(sum(total), 0) AS amt FROM orders WHERE payment_status = 'Pending' AND status <> 'Cancelled'`);
    if (p.n) out.push({ icon: "DollarSign", tone: "danger", route: "orders", text: `${p.n} unpaid order${p.n === 1 ? "" : "s"} worth ${naira(p.amt)}.` });
  }
  return out;
}

async function suppliers() {
  const [rows, entries] = await Promise.all([
    many(`SELECT s.id, s.name, s.type, s.contact_name, s.phone, s.active,
        COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'invoice' AND e.entry_date >= date_trunc('year', ${TODAY})), 0) AS invoiced_ytd,
        COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'payment' AND e.entry_date >= date_trunc('year', ${TODAY})), 0) AS paid_ytd,
        COALESCE(sum(CASE WHEN e.kind = 'invoice' THEN e.amount ELSE -e.amount END), 0) AS balance
      FROM suppliers s LEFT JOIN supplier_entries e ON e.supplier_id = s.id
      GROUP BY s.id ORDER BY s.active DESC, balance DESC, s.name`),
    many(`SELECT e.id, e.supplier_id, e.kind, e.amount, e.reference, e.note, e.entry_date, u.name AS who
      FROM (SELECT *, row_number() OVER (PARTITION BY supplier_id ORDER BY entry_date DESC, id DESC) AS rn FROM supplier_entries) e
      LEFT JOIN users u ON u.id = e.user_id WHERE e.rn <= 10 ORDER BY e.entry_date DESC, e.id DESC`),
  ]);
  return rows.map((s) => ({
    id: s.id, name: s.name, type: s.type, contactName: s.contact_name ?? "", phone: s.phone ?? "", active: s.active,
    invoicedYtd: s.invoiced_ytd, paidYtd: s.paid_ytd, balance: s.balance,
    entries: entries.filter((e) => e.supplier_id === s.id).map((e) => ({ id: e.id, kind: e.kind, amount: e.amount, reference: e.reference, note: e.note, date: fmtDate(e.entry_date), who: e.who })),
  }));
}

async function setup() {
  const [products, locations, ranches, profile] = await Promise.all([
    many(`SELECT p.sku, p.name, p.category, p.unit, p.price, p.cost_price, p.min_stock, p.active, p.shelf_life_days, p.barcode, p.plu, p.vat_rate, p.image, p.track_stock,
        COALESCE((SELECT sum(qty) FROM stock WHERE product_sku = p.sku), 0) AS qty,
        EXISTS (SELECT 1 FROM stock_movements WHERE product_sku = p.sku) AS used
      FROM products p ORDER BY p.active DESC, p.sort, p.name`),
    many(`SELECT l.id, l.name, l.active, l.sells_first AS "sellsFirst", l.temp_min AS "tempMin", l.temp_max AS "tempMax", count(s.*) FILTER (WHERE s.qty > 0)::int AS products
      FROM storage_locations l LEFT JOIN stock s ON s.location_id = l.id GROUP BY l.id ORDER BY l.active DESC, l.sort, l.name`),
    many(`SELECT r.id, r.name, r.active, count(a.*) FILTER (WHERE a.status NOT IN ('Processed','Sold'))::int AS animals
      FROM ranches r LEFT JOIN livestock a ON a.ranch_id = r.id GROUP BY r.id ORDER BY r.active DESC, r.name`),
    businessProfile(),
  ]);
  return {
    products: products.map((p) => ({ sku: p.sku, name: p.name, category: p.category, unit: p.unit, price: p.price, costPrice: p.cost_price, min: p.min_stock, active: p.active, qty: round2(p.qty), used: p.used, shelfLife: p.shelf_life_days, barcode: p.barcode ?? "", plu: p.plu ?? "", vatRate: Number(p.vat_rate) || 0, image: p.image ?? "", trackStock: p.track_stock })),
    locations, ranches, profile,
  };
}

async function approvals(roles, userId) {
  const canApproveStock = can(roles, "stock.adjust.approve"), canApproveRefunds = can(roles, "refunds.approve");
  // Approvers see every request; requesters see their own.
  const [adj, rf] = await Promise.all([
    many(`SELECT a.code, a.kind, a.qty, a.reason, a.note, a.value_at_cost, a.status, a.requested_at, a.decided_at, a.decision_note,
            a.requested_by, p.name AS product, p.unit, l.name AS location, u.name AS requester, d.name AS decider
          FROM stock_adjustments a JOIN products p ON p.sku = a.product_sku JOIN storage_locations l ON l.id = a.location_id
          JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
          WHERE ($1 OR a.requested_by = $2) AND (a.status = 'Pending' OR a.requested_at > now() - interval '30 days')
          ORDER BY (a.status = 'Pending') DESC, a.requested_at DESC LIMIT 100`, [canApproveStock, userId]),
    many(`SELECT r.code, r.amount, r.reason, r.restock, r.method, r.note, r.status, r.requested_at, r.decided_at, r.decision_note,
            r.requested_by, o.code AS order_code, c.name AS customer, u.name AS requester, d.name AS decider,
            (SELECT string_agg(ri.qty || ' ' || p.unit || ' ' || p.name, ', ') FROM refund_items ri JOIN order_items oi ON oi.id = ri.order_item_id
               JOIN products p ON p.sku = oi.product_sku WHERE ri.refund_id = r.id) AS items
          FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = o.customer_id
          JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
          WHERE ($1 OR r.requested_by = $2) AND (r.status = 'Pending' OR r.requested_at > now() - interval '30 days')
          ORDER BY (r.status = 'Pending') DESC, r.requested_at DESC LIMIT 100`, [canApproveRefunds, userId]),
  ]);
  const showCost = can(roles, "costs.view");
  return {
    canApproveStock, canApproveRefunds,
    adjustments: adj.map((a) => ({
      code: a.code, kind: a.kind, qty: a.qty, unit: a.unit, product: a.product, location: a.location, reason: a.reason, note: a.note,
      value: showCost ? a.value_at_cost : null, status: a.status, mine: a.requested_by === userId,
      requester: a.requester, requestedAt: fmtDateTime(a.requested_at), decider: a.decider, decidedAt: a.decided_at ? fmtDateTime(a.decided_at) : null, decisionNote: a.decision_note,
    })),
    refunds: rf.map((r) => ({
      code: r.code, order: r.order_code, customer: r.customer ?? "Walk-in Customer", items: r.items, amount: r.amount, reason: r.reason,
      restock: r.restock, method: r.method, note: r.note, status: r.status, mine: r.requested_by === userId,
      requester: r.requester, requestedAt: fmtDateTime(r.requested_at), decider: r.decider, decidedAt: r.decided_at ? fmtDateTime(r.decided_at) : null, decisionNote: r.decision_note,
    })),
  };
}

/* ------------------------------------------------------------------ assemble */

export async function buildState(user) {
  const r = user.roles;
  const s = { user: { id: user.id, name: user.name, email: user.email, role: user.role, roles: user.roles } };
  const jobs = { meta: meta(), notifications: Promise.all([notifications(user), businessNotifications(user), emailNotifications(user)]).then(([a, b, e]) => [...b.filter((n) => n.tone === "danger"), ...e, ...a, ...b.filter((n) => n.tone !== "danger")]) };

  if (can(r, "dashboard.view")) jobs.dashboard = dashboard();
  if (can(r, "inventory.view") || can(r, "pos.use")) jobs.inventory = inventory();
  if (can(r, "inventory.view")) jobs.ledger = ledger();
  if (can(r, "ranch.view") || can(r, "processing.view")) { jobs.livestock = livestock(); jobs.ranchStats = ranchStats(); }
  if (can(r, "processing.view")) jobs.processing = processing();
  if (can(r, "orders.view") || can(r, "dashboard.view")) jobs.orders = orders();
  if (can(r, "delivery.view")) jobs.deliveries = orders(500, `o.channel = 'Delivery' AND o.status NOT IN ('Delivered','Cancelled')`);
  if (can(r, "customers.view") || can(r, "pos.use")) jobs.customers = customers();
  if (can(r, "procurement.view")) jobs.suppliers = suppliers();
  if (can(r, "marketing.view") || can(r, "reports.view")) {
    jobs.campaigns = many("SELECT id, name, platform, budget, leads, orders, revenue FROM campaigns ORDER BY created_at DESC, id DESC");
    jobs.content = many(`SELECT id, to_char(post_date, 'YYYY-MM-DD') AS date, title, type, platform, status FROM content_posts
      WHERE post_date >= ${TODAY} - 14 ORDER BY post_date, id`);
  }
  if (can(r, "reports.view")) jobs.reports = reports();
  if (can(r, "ai.use")) jobs.insights = insights();
  if (can(r, "setup.manage")) jobs.setup = setup();
  if (APPROVAL_PERMS.some((p) => can(r, p))) jobs.approvals = approvals(r, user.id);
  if (can(r, "inventory.view")) jobs.coldChain = coldChain();
  if (can(r, "counts.perform") || can(r, "counts.schedule")) jobs.counts = stockCounts(r);
  if (can(r, "till.use") || can(r, "till.review")) jobs.tills = tills(r, user.id);
  if (APPROVAL_PERMS.some((p) => can(r, p)) || can(r, "controls.manage")) jobs.limits = approvalLimits();
  if (can(r, "pos.use")) jobs.pos = posState(user);
  if (can(r, "backups.manage")) jobs.backups = backupsState();
  if (can(r, "marketing.view")) jobs.emailMarketing = emailMarketingState();
  if (can(r, "payments.reconcile")) jobs.payments = paymentsState(user.id);
  if (can(r, "purchasing.view")) jobs.purchases = purchasesState(r);
  if (can(r, "haccp.complete") || can(r, "haccp.verify")) jobs.foodSafety = foodSafetyState();
  if (can(r, "audit.view")) jobs.audit = many(`SELECT a.action, a.detail, a.created_at, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 60`).then((rows) => rows.map((x) => ({ who: x.name ?? "System", action: x.action, detail: x.detail, at: fmtDateTime(x.created_at) })));
  if (can(r, "users.manage")) jobs.users = many(`SELECT id, name, email, role, extra_roles, active, must_change_password, totp_enabled, last_login_at FROM users ORDER BY active DESC, name`)
    .then((rows) => rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, extraRoles: u.extra_roles, active: u.active,
      mustChangePassword: u.must_change_password, mfaEnabled: u.totp_enabled, lastLogin: u.last_login_at ? fmtDateTime(u.last_login_at) : "Never" })));

  const keys = Object.keys(jobs);
  const vals = await Promise.all(Object.values(jobs));
  keys.forEach((k, i) => (s[k] = vals[i]));

  // Cost prices, stock value at cost and purchase costs are management information.
  if (!can(r, "costs.view")) {
    s.inventory?.forEach((i) => delete i.costPrice);
    s.livestock?.forEach((a) => delete a.acquisitionCost);
    if (s.ranchStats) { delete s.ranchStats.value; delete s.ranchStats.uncosted; }
    s.setup?.products.forEach((p) => delete p.costPrice);
    s.counts?.forEach((x) => delete x.detail);
  }
  return s;
}
