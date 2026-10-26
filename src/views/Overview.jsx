import React, { useState } from "react";
import { DollarSign, TrendingUp, ClipboardList, Scissors, Boxes, Beef, Activity, AlertTriangle, FileText, Download, CheckCircle2, Circle, X, Rocket } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { C, nairaFmt, kgFmt, qtyFmt, longToday, greeting, stockStatus, exportCsv } from "../lib/theme.js";
import { KpiCard, SectionHeader, Btn, StatusPill, Card, ICONS, Empty } from "../components/ui.jsx";

const signed = (n, suffix = "%") => (n == null ? null : `${n >= 0 ? "+" : ""}${n}${suffix}`);

/* ============================================================ GETTING STARTED */
const DISMISS_KEY = "bladeos.setupDismissed";
function GettingStarted({ data, onNavigate }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } });
  const steps = [
    { label: "Review products, prices and costs", hint: "Business Setup → Products", route: "setup", done: (() => { try { return localStorage.getItem("bladeos.setupVisited") === "1"; } catch { return false; } })() },
    { label: "Add your suppliers", hint: "Suppliers → Add Supplier", route: "procurement", done: (data.suppliers || []).length > 0 },
    { label: "Enter opening stock for each cold room", hint: "Inventory → Opening stock", route: "inventory", done: (data.inventory || []).some((i) => i.qty > 0) },
    { label: "Register the herd on each ranch", hint: "Livestock → Add Animal", route: "ranch", done: (data.livestock || []).length > 0 },
    { label: "Create staff accounts", hint: "Administration → Add User", route: "admin", done: (data.users || []).length > 1 },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (hidden || left === 0) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, "1"); } catch {} setHidden(true); };
  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="f-display text-lg flex items-center gap-2" style={{ color: C.ink }}><Rocket size={16} style={{ color: C.gold }} /> Getting started</h3>
          <p className="f-body text-xs" style={{ color: C.muted }}>{steps.length - left} of {steps.length} done — finish these before the first sale.</p>
        </div>
        <button onClick={dismiss} aria-label="Hide getting started" className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-stone-100 shrink-0"><X size={14} style={{ color: C.muted }} /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
        {steps.map((s) => (
          <button key={s.label} onClick={() => onNavigate(s.route)} className="text-left rounded-xl px-3 py-2.5 flex gap-2.5 items-start transition-all hover:shadow-sm active:scale-[0.99]"
            style={{ background: s.done ? "#E7F0E9" : C.cream }}>
            {s.done ? <CheckCircle2 size={16} style={{ color: C.ok, flexShrink: 0, marginTop: 1 }} /> : <Circle size={16} style={{ color: C.mutedLight, flexShrink: 0, marginTop: 1 }} />}
            <span className="min-w-0">
              <span className="f-body text-xs font-semibold block" style={{ color: C.ink, textDecoration: s.done ? "line-through" : "none" }}>{s.label}</span>
              <span className="f-body text-[11px] block" style={{ color: C.muted }}>{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ============================================================ DASHBOARD */
export function Dashboard({ data, onOpenReport, onNavigate }) {
  const d = data.dashboard;
  const [metric, setMetric] = useState("revenue");
  const inventory = data.inventory || [];
  const orders = data.orders || [];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <div className="f-body text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: C.gold }}>{longToday()}</div>
          <h1 className="f-display text-2xl sm:text-3xl" style={{ color: C.ink }}>{greeting()}, {data.user.name.split(" ")[0]}</h1>
        </div>
        <Btn icon={FileText} onClick={() => onOpenReport("sales")}>Generate Report</Btn>
      </div>

      <GettingStarted data={data} onNavigate={onNavigate} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <KpiCard label="Today's Sales" value={nairaFmt(d.todaysRevenue)} sub={d.revenueChange != null ? `${signed(d.revenueChange)} vs yesterday` : "no sales yesterday"} trend={d.revenueChange > 0 ? "up" : d.revenueChange < 0 ? "down" : null} icon={DollarSign} onClick={() => onOpenReport("sales")} />
        <KpiCard label="30-Day Sales" value={nairaFmt(d.monthlyRevenue)} sub="rolling 30 days" icon={TrendingUp} onClick={() => onOpenReport("sales")} />
        <KpiCard label="Orders Today" value={d.ordersToday} sub={`${signed(d.ordersChange, "")} vs yesterday`} trend={d.ordersChange > 0 ? "up" : d.ordersChange < 0 ? "down" : null} icon={ClipboardList} onClick={() => onNavigate("orders")} />
        <KpiCard label="KG Sold Today" value={kgFmt(d.kgToday)} sub={d.kgChange != null ? `${signed(d.kgChange)} vs yesterday` : "meat products"} trend={d.kgChange > 0 ? "up" : d.kgChange < 0 ? "down" : null} icon={Scissors} onClick={() => onOpenReport("inventory")} />
        <KpiCard label="Inventory Value" value={nairaFmt(d.inventoryValue)} sub="at cost" icon={Boxes} onClick={() => onOpenReport("inventory")} />
        <KpiCard label="Active Livestock" value={d.activeLivestock} sub={`across ${data.meta.ranches.length} ranches`} icon={Beef} onClick={() => onOpenReport("ranch")} />
        <KpiCard label="Avg. Processing Yield" value={d.avgYield != null ? `${d.avgYield}%` : "—"} sub="last 6 batches" icon={Activity} onClick={() => onOpenReport("processing")} />
        <KpiCard label="Low Stock Items" value={d.lowStock} sub={d.lowStock > 0 ? "needs attention" : "all healthy"} trend={d.lowStock > 0 ? "down" : "up"} icon={AlertTriangle} onClick={() => onNavigate("inventory")} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        <Card className="lg:col-span-2 overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h3 className="f-display text-lg" style={{ color: C.ink }}>Sales Analytics — 30 Days</h3>
            <div className="flex gap-1 rounded-lg p-1 self-start" style={{ background: C.cream }}>
              {[{ k: "revenue", l: "Revenue" }, { k: "orders", l: "Orders" }, { k: "kg", l: "KG Sold" }].map((m) => (
                <button key={m.k} onClick={() => setMetric(m.k)} className="f-body text-xs font-semibold px-2.5 sm:px-3 py-1.5 rounded-md transition-all active:scale-95"
                  style={{ background: metric === m.k ? C.burgundy : "transparent", color: metric === m.k ? "#fff" : C.muted }}>{m.l}</button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={d.salesTrend}>
              <defs>
                <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.burgundy} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={C.burgundy} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} width={metric === "revenue" ? 55 : 35}
                tickFormatter={(v) => (metric === "revenue" ? `₦${(v / 1000).toFixed(0)}k` : v)} />
              <Tooltip formatter={(v) => (metric === "revenue" ? nairaFmt(v) : metric === "kg" ? kgFmt(v) : v)} contentStyle={{ borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 12 }} />
              <Area type="monotone" dataKey={metric} stroke={C.burgundy} strokeWidth={2} fill="url(#rev)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <h3 className="f-display text-lg mb-4" style={{ color: C.ink }}>Top Selling Products</h3>
          {d.topProducts.length === 0 && <Empty>No sales in the last 30 days.</Empty>}
          <div className="space-y-3">
            {d.topProducts.map((p, i) => (
              <div key={p.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="f-mono text-xs font-semibold w-4 shrink-0" style={{ color: C.gold }}>{i + 1}</span>
                  <div className="min-w-0">
                    <div className="f-body text-sm font-medium truncate" style={{ color: C.ink }}>{p.name}</div>
                    <div className="f-mono text-xs" style={{ color: C.muted }}>{p.qty.toLocaleString("en-NG")} {p.unit} · {nairaFmt(p.revenue)}</div>
                  </div>
                </div>
                {p.growth != null && (
                  <span className="f-mono text-xs font-semibold shrink-0 ml-2" style={{ color: p.growth >= 0 ? C.ok : C.danger }}>{signed(p.growth)}</span>
                )}
              </div>
            ))}
          </div>
          <p className="f-body text-[10px] mt-4" style={{ color: C.muted }}>Last 30 days · change vs previous 30</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Card>
          <h3 className="f-display text-lg mb-4" style={{ color: C.ink }}>Inventory Health</h3>
          <div className="space-y-2.5">
            {inventory.map((item) => {
              const status = stockStatus(item);
              const color = status === "Critical" ? C.danger : status === "Low" ? C.warn : C.ok;
              return (
                <div key={item.sku}>
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="f-body text-xs font-medium truncate" style={{ color: C.ink }}>{item.name}</span>
                    <span className="f-mono text-xs shrink-0" style={{ color }}>{qtyFmt(item.qty, item.unit)}</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.line }}>
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, (item.qty / Math.max(item.min * 3, 1)) * 100)}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <h3 className="f-display text-lg mb-4" style={{ color: C.ink }}>Recent Orders</h3>
          <div className="space-y-3">
            {orders.slice(0, 6).map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="f-body text-sm font-medium truncate" style={{ color: C.ink }}>{o.customer}</div>
                  <div className="f-mono text-xs truncate" style={{ color: C.muted }}>{o.id} · {o.product}</div>
                </div>
                <div className="text-right shrink-0 ml-2">
                  <div className="f-mono text-sm font-semibold" style={{ color: C.ink }}>{nairaFmt(o.amount)}</div>
                  <StatusPill status={o.status} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ============================================================ REPORTS */
const TABS = [["sales", "Sales"], ["inventory", "Inventory"], ["ranch", "Ranch"], ["processing", "Processing"], ["customer", "Customer"], ["marketing", "Marketing"]];

export function ReportsView({ data, initialTab, notify }) {
  const [tab, setTab] = useState(initialTab || "sales");
  const reports = data.reports;
  if (!reports) return <Empty>Reports aren't available for your role.</Empty>;

  const exportRows = {
    sales: () => (data.orders || []).map((o) => ({ order: o.id, date: o.date, customer: o.customer, products: o.product, amount: o.amount, payment: o.payment, status: o.status, channel: o.channel })),
    inventory: () => (data.inventory || []).map((i) => ({ sku: i.sku, product: i.name, qty: i.qty, unit: i.unit, min_stock: i.min, cost_price: i.costPrice, price: i.price, value_at_cost: Math.round(i.qty * i.costPrice), locations: i.locations.map((l) => `${l.name}: ${l.qty}`).join("; ") })),
    ranch: () => (data.livestock || []).map((l) => ({ id: l.id, tag: l.tag, species: l.species, breed: l.breed, sex: l.sex, age: l.ageYears, weight_kg: l.weight, ranch: l.location, health: l.health, status: l.status, acquired: l.acquisitionDate, cost: l.acquisitionCost })),
    processing: () => (data.processing?.log || []).map((p) => ({ batch: p.id, animal: p.animal, species: p.species, live_kg: p.live, saleable_kg: p.saleable, yield_pct: p.yield, waste_kg: p.waste, date: p.date })),
    customer: () => (data.customers || []).map((c) => ({ code: c.code, name: c.name, phone: c.phone, area: c.area, orders: c.orders, total_spent: c.spent, avg_order: c.avg, last_order: c.last })),
    marketing: () => (data.campaigns || []).map((c) => ({ campaign: c.name, platform: c.platform, budget: c.budget, leads: c.leads, orders: c.orders, revenue: c.revenue, roas: c.budget ? (c.revenue / c.budget).toFixed(2) : "" })),
  };

  const doExport = () => {
    const name = `bladeos-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    if (exportCsv(name, exportRows[tab]())) notify(`${name} exported`);
    else notify("Nothing to export yet", "error");
  };

  return (
    <div>
      <SectionHeader eyebrow="Reports" title="Management Reports" action={<Btn icon={Download} small variant="ghost" onClick={doExport}>Export CSV</Btn>} />
      <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="f-body text-xs font-semibold px-3.5 py-2 rounded-lg shrink-0 transition-all active:scale-95"
            style={{ background: tab === k ? C.charcoal : "#fff", color: tab === k ? "#fff" : C.muted, border: `1px solid ${C.border}` }}>{l}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {reports[tab].map((k) => <KpiCard key={k.label} label={k.label} value={k.value} icon={ICONS[k.icon]} />)}
      </div>
      <p className="f-body text-xs mt-4" style={{ color: C.muted }}>
        Month-to-date figures in Lagos time{tab === "marketing" ? "; campaign results are entered by the marketing team" : ""}. Export includes the full detail behind this tab.
      </p>
    </div>
  );
}

/* ============================================================ ROADMAP */
export function RoadmapView() {
  const phases = [
    ["Phase 1", "Digital Operations", "Live"], ["Phase 2", "Online Commerce", "Next"], ["Phase 3", "WhatsApp Automation", "Planned"],
    ["Phase 4", "Accounting Integration", "Planned"], ["Phase 5", "AI Business Intelligence", "Planned"], ["Phase 6", "Multi-Branch Operations", "Planned"],
    ["Phase 7", "Supplier Portal", "Planned"], ["Phase 8", "Customer Loyalty", "Planned"], ["Phase 9", "Advanced Ranch Analytics", "Planned"],
    ["Phase 10", "Predictive Inventory & Demand Forecasting", "Planned"],
  ];
  return (
    <div>
      <SectionHeader eyebrow="Coming Next" title="Product Roadmap" />
      <div className="space-y-2.5">
        {phases.map(([p, t, s]) => (
          <div key={p} className="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-4 rounded-xl px-4 sm:px-5 py-3.5 border" style={{ background: "#fff", borderColor: C.border }}>
            <span className="f-mono text-xs font-semibold w-14 sm:w-16 shrink-0" style={{ color: C.gold }}>{p}</span>
            <span className="f-body text-sm flex-1 min-w-[140px]" style={{ color: C.ink }}>{t}</span>
            <StatusPill status={s} />
          </div>
        ))}
      </div>
    </div>
  );
}
