// Purchase orders, payment reconciliation, food safety (HACCP) and backups.
import React, { useEffect, useMemo, useState } from "react";
import {
  Plus, Check, X, Truck, Ban, ChevronDown, ChevronUp, Info, Trash2, Banknote, ShieldCheck, ClipboardCheck, Download,
  DatabaseBackup, FlaskConical, HardDriveDownload, AlertTriangle, Pencil, Archive, RotateCcw, ListChecks,
} from "lucide-react";
import { C, nairaFmt, qtyFmt, exportCsv } from "../lib/theme.js";
import { PO_OVER_RECEIPT_PCT } from "../shared/permissions.js";
import { KpiCard, SectionHeader, Btn, StatusPill, Modal, Field, Input, Select, Card, Empty, ICONS, useBusy } from "../components/ui.jsx";
import { ColdChainCard } from "./Operations.jsx";

const todayIso = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const Note = ({ children, tone = C.gold }) => (
  <div className="rounded-xl px-4 py-3 mb-5 flex gap-2.5 items-start" style={{ background: C.cream }}>
    <Info size={15} style={{ color: tone, flexShrink: 0, marginTop: 2 }} />
    <p className="f-body text-xs" style={{ color: C.ink }}>{children}</p>
  </div>
);
const Tabs = ({ tabs, value, onChange }) => (
  <div className="flex gap-1.5 mb-4 overflow-x-auto">
    {tabs.map(([id, label]) => (
      <button key={id} onClick={() => onChange(id)} className="f-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0"
        style={{ background: value === id ? C.burgundy : C.cream, color: value === id ? "#fff" : C.muted }}>{label}</button>
    ))}
  </div>
);

/** A modal that asks for a note (reject / close / sign-off). */
function NoteModal({ title, label, hint, required = true, button, variant = "primary", icon = Check, onClose, onSubmit, children }) {
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const ok = !required || note.trim().length >= 3;
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (ok) run(async () => { if (await onSubmit(note.trim())) onClose(); }); }} className="space-y-4">
        {children}
        <Field label={label} hint={hint}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus /></Field>
        <Btn type="submit" variant={variant} icon={icon} full busy={busy} disabled={!ok}>{button}</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ PURCHASE ORDERS */
export function PurchasesView({ data, actions, permit }) {
  const pos = data.purchases || [];
  const me = data.user.id;
  const limits = data.limits || {};
  const isExec = permit("controls.manage");
  const seesPrices = permit("costs.view");
  const [tab, setTab] = useState("open");
  const [modal, setModal] = useState(null); // { kind, po }
  const [openCode, setOpenCode] = useState(null);

  const pending = pos.filter((p) => p.status === "Pending Approval");
  const toReceive = pos.filter((p) => ["Approved", "Partly Received"].includes(p.status));
  const mismatches = pos.filter((p) => p.match?.status === "Mismatch");
  const list = tab === "open" ? pos.filter((p) => ["Pending Approval", "Approved", "Partly Received"].includes(p.status))
    : tab === "match" ? pos.filter((p) => p.match && p.match.status !== "—") : pos.filter((p) => !["Pending Approval", "Approved", "Partly Received"].includes(p.status));

  return (
    <div>
      {modal?.kind === "new" && <NewPOModal data={data} actions={actions} onClose={() => setModal(null)} />}
      {modal?.kind === "receive" && <ReceivePOModal po={modal.po} locations={data.meta.locations} actions={actions} onClose={() => setModal(null)} />}
      {modal?.kind === "reject" && <NoteModal title={`Reject ${modal.po.code}`} label="Reason" button="Reject" variant="danger" icon={X} onClose={() => setModal(null)}
        onSubmit={(note) => actions.decidePO(modal.po.code, "reject", note)} />}
      {modal?.kind === "close" && <NoteModal title={`${modal.po.status === "Partly Received" ? "Close" : "Cancel"} ${modal.po.code}`} label="Reason"
        hint={modal.po.status === "Partly Received" ? "The rest won't be delivered — the PO closes with what arrived." : "Nothing has been received against it."}
        button={modal.po.status === "Partly Received" ? "Close purchase order" : "Cancel purchase order"} variant="danger" icon={Ban}
        onClose={() => setModal(null)} onSubmit={(note) => actions.closePO(modal.po.code, note)} />}

      <SectionHeader eyebrow="Procurement" title="Purchase Orders"
        action={permit("purchasing.create") && <Btn icon={Plus} small onClick={() => setModal({ kind: "new" })}>New Purchase Order</Btn>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <KpiCard label="Awaiting approval" value={pending.length} icon={ClipboardCheck} />
        <KpiCard label="To receive" value={toReceive.length} sub={toReceive.some((p) => p.expected && p.expected <= todayIso()) ? "some due today or late" : undefined} icon={Truck} />
        {seesPrices && <KpiCard label="On order" value={nairaFmt(toReceive.reduce((s, p) => s + p.total - p.match.received, 0))} sub="not yet received" icon={ICONS.DollarSign} />}
        {seesPrices && <KpiCard label="Invoice mismatches" value={mismatches.length} trend={mismatches.length ? "down" : null} sub={mismatches.length ? "check before paying" : "all matched"} icon={AlertTriangle} />}
      </div>
      <Note>
        Order → approve → receive → invoice. A purchase order needs a second manager's approval{seesPrices && limits.purchase ? ` (Operations Managers up to ${nairaFmt(limits.purchase)})` : ""};
        goods are received only against an approved order; the supplier's invoice is matched to what actually arrived before it's paid.
        {!seesPrices && " Prices aren't shown on your screen."}
      </Note>
      <Tabs value={tab} onChange={setTab} tabs={[["open", `Open (${pending.length + toReceive.length})`], ...(seesPrices ? [["match", "Invoice match"]] : []), ["done", "Closed"]]} />
      {list.length === 0 && <Card><Empty>{tab === "open" ? "No open purchase orders." : "Nothing here yet."}</Empty></Card>}
      <div className="space-y-3">
        {list.map((po) => {
          const canApprove = permit("purchasing.approve") && po.status === "Pending Approval" && po.createdById !== me;
          const aboveLimit = canApprove && !isExec && po.total > limits.purchase;
          const open = openCode === po.code;
          return (
            <Card key={po.code}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="f-mono text-sm font-semibold" style={{ color: C.ink }}>{po.code}</span>
                    <StatusPill status={po.status} />
                    {po.match && po.match.status !== "—" && <StatusPill status={po.match.status} />}
                  </div>
                  <div className="f-body text-sm mt-0.5" style={{ color: C.ink }}>{po.supplier}</div>
                  <div className="f-body text-xs" style={{ color: C.muted }}>
                    Raised by {po.createdBy} · {po.createdAt}{po.expectedOn ? ` · delivery ${po.expectedOn}` : ""}
                    {po.decidedBy ? ` · ${po.status === "Rejected" ? "rejected" : "approved"} by ${po.decidedBy}` : ""}
                  </div>
                  {po.note && <div className="f-body text-xs mt-0.5" style={{ color: C.muted }}>“{po.note}”</div>}
                  {po.decisionNote && po.status !== "Approved" && <div className="f-body text-xs mt-0.5" style={{ color: C.danger }}>{po.decisionNote}</div>}
                </div>
                {seesPrices && <div className="f-mono text-base font-semibold" style={{ color: C.burgundy }}>{nairaFmt(po.total)}</div>}
              </div>
              <div className="mt-3 space-y-1">
                {po.lines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-2 f-body text-xs">
                    <span className="min-w-0 truncate" style={{ color: C.ink }}>{l.description}{!l.sku && <span style={{ color: C.muted }}> (non-stock)</span>}</span>
                    <span className="f-mono shrink-0" style={{ color: C.muted }}>
                      {qtyFmt(l.receivedQty, l.unit)} / {qtyFmt(l.qty, l.unit)}{seesPrices ? ` × ${nairaFmt(l.unitCost)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
              {po.match && po.match.invoiced > 0 && (
                <div className="mt-2 f-body text-xs" style={{ color: po.match.status === "Mismatch" ? C.danger : C.muted }}>
                  Received {nairaFmt(po.match.received)} · invoiced {nairaFmt(po.match.invoiced)}
                  {po.match.status === "Mismatch" && ` · ${po.match.diff > 0 ? "over-invoiced" : "under-invoiced"} by ${nairaFmt(Math.abs(po.match.diff))}`}
                  {po.invoices?.length > 0 && ` · ${po.invoices.map((i) => i.reference || "invoice").join(", ")}`}
                </div>
              )}
              {aboveLimit && <p className="f-body text-xs mt-2" style={{ color: C.danger }}>Above your {nairaFmt(limits.purchase)} limit — the Owner or MD approves this one.</p>}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {canApprove && <Btn small icon={Check} disabled={aboveLimit} onClick={() => actions.decidePO(po.code, "approve")}>Approve</Btn>}
                {canApprove && <Btn small variant="danger" icon={X} onClick={() => setModal({ kind: "reject", po })}>Reject</Btn>}
                {permit("stock.receive") && ["Approved", "Partly Received"].includes(po.status) && <Btn small variant="gold" icon={Truck} onClick={() => setModal({ kind: "receive", po })}>Receive delivery</Btn>}
                {permit("purchasing.create") && ["Pending Approval", "Approved", "Partly Received"].includes(po.status) &&
                  <Btn small variant="ghost" icon={Ban} onClick={() => setModal({ kind: "close", po })}>{po.status === "Partly Received" ? "Close short" : "Cancel"}</Btn>}
                {po.receipts.length > 0 && <Btn small variant="ghost" icon={open ? ChevronUp : ChevronDown} onClick={() => setOpenCode(open ? null : po.code)}>Deliveries ({po.receipts.length})</Btn>}
              </div>
              {open && (
                <div className="mt-3 pt-3 border-t space-y-1.5" style={{ borderColor: C.line }}>
                  {po.receipts.map((r, i) => {
                    const l = po.lines.find((x) => x.id === r.line);
                    return (
                      <div key={i} className="f-body text-xs" style={{ color: C.ink }}>
                        {qtyFmt(r.qty, l?.unit)} {l?.description}{r.location ? ` → ${r.location}` : ""}{r.lot ? ` · lot ${r.lot}` : ""}
                        <span style={{ color: C.muted }}> · {r.note} · {r.who}, {r.at}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function NewPOModal({ data, actions, onClose }) {
  const suppliers = (data.suppliers || []).filter((s) => s.active);
  const products = data.inventory || [];
  const blank = () => ({ sku: products[0]?.sku ?? "", description: "", unit: "Item", qty: "", unitCost: products[0]?.costPrice != null ? String(products[0].costPrice) : "" });
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [expectedOn, setExpectedOn] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([blank()]);
  const [busy, run] = useBusy();
  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const n = { ...l, [k]: v };
    if (k === "sku" && v) { const p = products.find((x) => x.sku === v); if (p?.costPrice != null) n.unitCost = String(p.costPrice); }
    return n;
  }));
  const parsed = lines.map((l) => {
    const p = products.find((x) => x.sku === l.sku);
    const q = Number(l.qty), c = Number(l.unitCost);
    const err = l.qty === "" ? null : !(q > 0) ? "Qty above zero" : p && p.unit !== "KG" && !Number.isInteger(q) ? "Whole numbers" : !(Number.isInteger(c) && c >= 0) ? "Whole Naira" : null;
    return { ...l, p, q, c, err, ok: !err && q > 0 && l.unitCost !== "" && (l.sku || l.description.trim().length >= 2) };
  });
  const total = parsed.reduce((s, l) => s + (l.ok ? Math.round(l.q * l.c) : 0), 0);
  const valid = supplierId && parsed.length > 0 && parsed.every((l) => l.ok) && total > 0;
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await actions.createPO({
        supplierId: Number(supplierId), expectedOn, note: note.trim(),
        lines: parsed.map((l) => (l.sku ? { sku: l.sku, qty: l.q, unitCost: l.c } : { description: l.description.trim(), unit: l.unit.trim() || "Item", qty: l.q, unitCost: l.c })),
      });
      if (r) onClose();
    });
  };
  if (!suppliers.length) return (
    <Modal title="New Purchase Order" onClose={onClose}><Empty>Add the supplier first (Procurement → Suppliers).</Empty></Modal>
  );
  return (
    <Modal title="New Purchase Order" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Expected delivery (optional)"><Input type="date" min={todayIso()} value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} /></Field>
        </div>
        <div className="space-y-3">
          {parsed.map((l, i) => (
            <div key={i} className="rounded-xl p-3 space-y-2" style={{ background: C.cream }}>
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <Select value={l.sku} onChange={(e) => setLine(i, "sku", e.target.value)} aria-label="Product">
                    {products.map((p) => <option key={p.sku} value={p.sku}>{p.name} ({p.unit})</option>)}
                    <option value="">Other — not a stock product</option>
                  </Select>
                </div>
                {lines.length > 1 && <button type="button" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="p-2"><Trash2 size={14} style={{ color: C.muted }} /></button>}
              </div>
              {!l.sku && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2"><Input value={l.description} onChange={(e) => setLine(i, "description", e.target.value)} placeholder="e.g. Live cattle, vacuum bags" maxLength={120} aria-label="Description" /></div>
                  <Input value={l.unit} onChange={(e) => setLine(i, "unit", e.target.value)} placeholder="Unit" maxLength={20} aria-label="Unit" />
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 items-center">
                <Input mono type="number" min="0" step={l.p?.unit === "KG" ? "0.001" : "1"} value={l.qty} onChange={(e) => setLine(i, "qty", e.target.value)} placeholder={`Qty${l.p ? ` (${l.p.unit})` : ""}`} aria-label="Quantity" />
                <Input mono type="number" min="0" step="1" value={l.unitCost} onChange={(e) => setLine(i, "unitCost", e.target.value)} placeholder="₦ per unit" aria-label="Unit cost" />
                <span className="f-mono text-sm text-right" style={{ color: l.err ? C.danger : C.ink }}>{l.err || (l.ok ? nairaFmt(l.q * l.c) : "—")}</span>
              </div>
            </div>
          ))}
          <Btn small variant="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, blank()])}>Add line</Btn>
        </div>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. for the Christmas rush" /></Field>
        <div className="flex items-center justify-between">
          <span className="f-body text-sm font-semibold" style={{ color: C.ink }}>Total</span>
          <span className="f-mono text-xl font-bold" style={{ color: C.burgundy }}>{nairaFmt(total)}</span>
        </div>
        <Btn type="submit" icon={Check} full busy={busy} disabled={!valid}>Raise Purchase Order</Btn>
      </form>
    </Modal>
  );
}

function ReceivePOModal({ po, locations, actions, onClose }) {
  const lines = po.lines.filter((l) => l.outstanding > 0 || l.unit === "KG");
  const [location, setLocation] = useState(locations.includes("Cold Room A") ? "Cold Room A" : locations[0]);
  const [note, setNote] = useState("");
  const [f, setF] = useState(() => Object.fromEntries(lines.map((l) => [l.id, { qty: "", lot: "", expiresOn: "" }])));
  const [busy, run] = useBusy();
  const set = (id, k) => (e) => setF((p) => ({ ...p, [id]: { ...p[id], [k]: e.target.value } }));
  const rows = lines.map((l) => {
    const v = f[l.id]; const q = Number(v.qty);
    const max = l.unit === "KG" ? Math.round((l.outstanding + l.qty * PO_OVER_RECEIPT_PCT / 100) * 1000) / 1000 : l.outstanding;
    const err = v.qty === "" ? null : !(q >= 0) ? "Not valid" : l.unit !== "KG" && !Number.isInteger(q) ? "Whole numbers" : q > max + 1e-9 ? `Max ${max}` : v.expiresOn && v.expiresOn < todayIso() ? "Use-by has passed" : null;
    return { ...l, v, q: v.qty === "" ? 0 : q, err, max };
  });
  const chosen = rows.filter((r) => r.q > 0 && !r.err);
  const valid = chosen.length > 0 && !rows.some((r) => r.err) && note.trim().length >= 2;
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await actions.receivePO(po.code, { location, note: note.trim(), lines: chosen.map((x) => ({ lineId: x.id, qty: x.q, lot: x.v.lot.trim(), expiresOn: x.v.expiresOn })) });
      if (r) onClose();
    });
  };
  return (
    <Modal title={`Receive — ${po.code} · ${po.supplier}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Put stock into"><Select value={location} onChange={(e) => setLocation(e.target.value)}>{locations.map((l) => <option key={l}>{l}</option>)}</Select></Field>
          <Field label="Delivery note / waybill no."><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} required autoFocus /></Field>
        </div>
        <p className="f-body text-xs" style={{ color: C.muted }}>Weigh or count what actually arrived. Weighed lines may be up to {PO_OVER_RECEIPT_PCT}% over the order; anything else extra needs a new order. Reject anything past its use-by or above 4°C (chilled) / −18°C (frozen).</p>
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl p-3" style={{ background: C.cream }}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="f-body text-sm font-medium truncate" style={{ color: C.ink }}>{r.description}</span>
              <span className="f-mono text-xs shrink-0" style={{ color: C.muted }}>{qtyFmt(r.outstanding, r.unit)} outstanding</span>
            </div>
            <div className={`grid gap-2 ${r.sku ? "grid-cols-3" : "grid-cols-1"}`}>
              <Input mono type="number" min="0" step={r.unit === "KG" ? "0.001" : "1"} value={r.v.qty} onChange={set(r.id, "qty")} placeholder={`Received (${r.unit})`} aria-label={`${r.description} received`} />
              {r.sku && <Input value={r.v.lot} onChange={set(r.id, "lot")} placeholder="Supplier lot no." maxLength={40} aria-label={`${r.description} lot`} />}
              {r.sku && <Input type="date" min={todayIso()} value={r.v.expiresOn} onChange={set(r.id, "expiresOn")} aria-label={`${r.description} use-by`} title="Use-by date (blank = shelf life)" />}
            </div>
            {r.err && <div className="f-body text-xs mt-1" style={{ color: C.danger }}>{r.err}</div>}
          </div>
        ))}
        <Btn type="submit" variant="gold" icon={Truck} full busy={busy} disabled={!valid}>Receive into stock</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ PAYMENT RECONCILIATION */
export function PaymentsView({ data, actions, permit }) {
  const p = data.payments || { days: [], outstanding: 0 };
  const limits = data.limits || {};
  const isExec = permit("controls.manage");
  const [rec, setRec] = useState(null);
  const [signing, setSigning] = useState(null);
  const waiting = p.days.filter((d) => d.rec?.status === "Recorded" && !d.rec.mine);
  const variance14 = p.days.reduce((s, d) => s + (d.rec?.variance || 0), 0);

  return (
    <div>
      {rec && <ReconcileModal row={rec} actions={actions} onClose={() => setRec(null)} />}
      {signing && (
        <NoteModal title={`Sign off ${signing.method} — ${signing.label}`} label="Note" required={signing.rec.variance !== 0}
          hint={signing.rec.variance !== 0 ? "What explains the difference?" : "Optional"} button="Sign off" icon={ShieldCheck}
          onClose={() => setSigning(null)} onSubmit={(note) => actions.reviewRecon(signing.rec.id, note)}>
          <div className="grid grid-cols-3 gap-2 f-mono text-sm">
            <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>BladeOS</div>{nairaFmt(signing.rec.expected)}</div>
            <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Statement</div>{nairaFmt(signing.rec.actual)}</div>
            <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Variance</div><span style={{ color: signing.rec.variance ? C.danger : C.ok }}>{nairaFmt(signing.rec.variance)}</span></div>
          </div>
          {signing.rec.note && <p className="f-body text-xs" style={{ color: C.muted }}>{signing.rec.recordedBy}: “{signing.rec.note}”</p>}
          {!isExec && Math.abs(signing.rec.variance) > limits.paymentVariance && <p className="f-body text-xs" style={{ color: C.danger }}>Above your {nairaFmt(limits.paymentVariance)} limit — the Owner or MD must sign this off.</p>}
        </NoteModal>
      )}
      <SectionHeader eyebrow="Money" title="Payment Reconciliation" />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-5">
        <KpiCard label="Days to reconcile" value={p.outstanding} trend={p.outstanding ? "down" : null} sub={p.outstanding ? "last 14 days" : "all done"} icon={Banknote} />
        <KpiCard label="Waiting for your sign-off" value={waiting.length} icon={ShieldCheck} />
        <KpiCard label="Net variance (14 days)" value={nairaFmt(variance14)} trend={variance14 < 0 ? "down" : null} icon={ICONS.DollarSign} />
      </div>
      <Note>
        Every morning, compare yesterday's transfers with the bank statement and card takings with the POS-terminal settlement.
        Differences need an explanation and a second manager's sign-off{limits.paymentVariance != null ? ` (Operations Managers up to ${nairaFmt(limits.paymentVariance)})` : ""}. Cash is checked at till cash-up.
      </Note>
      {p.days.length === 0 && <Card><Empty>No transfer or card takings in the last 14 days.</Empty></Card>}
      <div className="space-y-2">
        {p.days.map((d) => (
          <Card key={`${d.day}-${d.method}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="f-body text-sm font-semibold" style={{ color: C.ink }}>{d.label}{d.isToday ? " (today)" : ""}</span>
                  <span className="f-body text-xs px-2 py-0.5 rounded-full" style={{ background: C.cream, color: C.muted }}>{d.method}</span>
                </div>
                <div className="f-body text-xs mt-0.5" style={{ color: C.muted }}>
                  {d.orders != null ? `${plural(d.orders, "payment")} · BladeOS ${nairaFmt(d.expected)}${d.refunds ? ` (after ${nairaFmt(d.refunds)} refunds)` : ""}` : `BladeOS ${nairaFmt(d.expected)}`}
                </div>
                {d.rec && (
                  <div className="f-body text-xs mt-0.5" style={{ color: d.rec.variance ? C.danger : C.ok }}>
                    Statement {nairaFmt(d.rec.actual)} · {d.rec.variance === 0 ? "matched" : `${d.rec.variance > 0 ? "over" : "short"} ${nairaFmt(Math.abs(d.rec.variance))}`}
                    <span style={{ color: C.muted }}> · {d.rec.recordedBy}{d.rec.statementRef ? ` · ${d.rec.statementRef}` : ""}{d.rec.reviewedBy ? ` · signed off by ${d.rec.reviewedBy}` : ""}</span>
                  </div>
                )}
                {d.rec?.drift && <div className="f-body text-xs mt-0.5" style={{ color: C.danger }}>Takings changed since this was recorded — record it again.</div>}
              </div>
              <div className="flex items-center gap-2">
                {d.rec ? <StatusPill status={d.rec.status} /> : !d.isToday && <StatusPill status="Pending" />}
                {(!d.rec || (d.rec.status === "Recorded" && (d.rec.mine || d.rec.drift))) && <Btn small icon={Banknote} onClick={() => setRec(d)}>{d.rec ? "Re-record" : "Reconcile"}</Btn>}
                {d.rec?.status === "Recorded" && !d.rec.mine && !d.rec.drift && <Btn small variant="gold" icon={ShieldCheck} onClick={() => setSigning(d)}>Sign off</Btn>}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ReconcileModal({ row, actions, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [actual, setActual] = useState(row.rec ? String(row.rec.actual) : "");
  const [statementRef, setStatementRef] = useState(row.rec?.statementRef ?? "");
  const [note, setNote] = useState(row.rec?.note ?? "");
  const [busy, run] = useBusy();
  useEffect(() => { actions.getRecon(row.day, row.method).then(setDetail).catch((e) => setError(e.message)); }, []);
  const a = Number(actual);
  const expected = detail?.expected ?? row.expected;
  const variance = actual === "" ? null : a - expected;
  const valid = actual !== "" && Number.isInteger(a) && a >= 0 && (variance === 0 || note.trim().length >= 3);
  const submit = (e) => {
    e.preventDefault();
    run(async () => { if (await actions.recordRecon({ day: row.day, method: row.method, actual: a, statementRef: statementRef.trim(), note: note.trim() })) onClose(); });
  };
  return (
    <Modal title={`${row.method} — ${row.label}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <p className="f-body text-sm" style={{ color: C.danger }}>{error}</p>}
        <div className="rounded-xl p-3 max-h-56 overflow-y-auto space-y-1" style={{ background: C.cream }}>
          {!detail && !error && <p className="f-body text-xs" style={{ color: C.muted }}>Loading payments…</p>}
          {detail?.orders.map((o) => (
            <div key={o.code} className="flex justify-between gap-2 f-body text-xs">
              <span className="min-w-0 truncate" style={{ color: C.ink }}><span className="f-mono">{o.code}</span> · {o.at.split(", ")[1]} · {o.customer}{o.ref ? <b> · {o.ref}</b> : ""}</span>
              <span className="f-mono shrink-0" style={{ color: C.ink }}>{nairaFmt(o.amount)}</span>
            </div>
          ))}
          {detail?.refunds.map((f) => (
            <div key={f.code} className="flex justify-between gap-2 f-body text-xs">
              <span style={{ color: C.danger }}>Refund {f.code} ({f.order})</span><span className="f-mono" style={{ color: C.danger }}>−{nairaFmt(f.amount)}</span>
            </div>
          ))}
          {detail && <div className="flex justify-between pt-1 border-t f-body text-sm font-semibold" style={{ borderColor: C.line, color: C.ink }}><span>BladeOS expects</span><span className="f-mono">{nairaFmt(expected)}</span></div>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={row.method === "Transfer" ? "Received per bank statement (₦)" : "Settled per terminal report (₦)"}
            error={variance ? `${variance > 0 ? "Over" : "Short"} by ${nairaFmt(Math.abs(variance))}` : null} hint={variance === 0 ? "Matches BladeOS" : null}>
            <Input mono type="number" min="0" step="1" value={actual} onChange={(e) => setActual(e.target.value)} required autoFocus />
          </Field>
          <Field label="Statement reference (optional)"><Input value={statementRef} onChange={(e) => setStatementRef(e.target.value)} maxLength={60} placeholder="e.g. GTB stmt p.3" /></Field>
        </div>
        <Field label={variance ? "Explain the difference" : "Note (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
          placeholder="e.g. transfer for ORD-1042 arrived next day; terminal charge" /></Field>
        <Btn type="submit" icon={Check} full busy={busy} disabled={!valid || !detail}>Record reconciliation</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ FOOD SAFETY (HACCP) */
export function FoodSafetyView({ data, actions, permit }) {
  const fs = data.foodSafety || { checklists: [], runs: [] };
  const me = data.user.id;
  const [doing, setDoing] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState("today");
  const active = fs.checklists.filter((c) => c.active);
  const toVerify = fs.runs.filter((r) => !r.verifiedBy && r.completedById !== me);
  const failures30 = fs.runs.filter((r) => !r.allOk).length;
  const canComplete = permit("haccp.complete"), canVerify = permit("haccp.verify");

  const exportHistory = () => exportCsv(`haccp-records-${todayIso()}.csv`, fs.runs.flatMap((r) => r.results.map((x) => ({
    Checklist: r.checklist, Period: r.period, Item: x.item, Result: x.ok ? "Pass" : "FAIL", "Corrective action": x.action || "",
    "Completed by": r.completedBy, "Completed at": r.completedAt, "Verified by": r.verifiedBy || "", "Verified at": r.verifiedAt || "", "Verification note": r.verifyNote || "",
  }))));

  return (
    <div>
      {doing && <ChecklistModal checklist={doing} actions={actions} onClose={() => setDoing(null)} />}
      {verifying && (
        <NoteModal title={`Verify — ${verifying.checklist}`} label="Verification note" required={!verifying.allOk}
          hint={verifying.allOk ? "Optional" : "Confirm the corrective actions worked."} button="Verify" icon={ShieldCheck}
          onClose={() => setVerifying(null)} onSubmit={(note) => actions.verifyHaccp(verifying.id, note)}>
          <RunResults run={verifying} />
        </NoteModal>
      )}
      {editing && <ChecklistEditor checklists={fs.checklists} actions={actions} onClose={() => setEditing(false)} />}
      <SectionHeader eyebrow="Food Safety" title="HACCP Checks"
        action={<div className="flex gap-2">
          {permit("setup.manage") && <Btn small variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Edit checklists</Btn>}
          {fs.runs.length > 0 && <Btn small variant="ghost" icon={Download} onClick={exportHistory}>Export records</Btn>}
        </div>} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-5">
        <KpiCard label="Due now" value={active.filter((c) => c.due).length} trend={active.some((c) => c.due) ? "down" : null} sub={active.some((c) => c.due) ? "complete before trading" : "all done"} icon={ListChecks} />
        {canVerify && <KpiCard label="To verify" value={toVerify.length} icon={ShieldCheck} />}
        <KpiCard label="Failed checks (45 days)" value={failures30} icon={AlertTriangle} />
      </div>
      <Note>
        Daily and weekly checks are the evidence an inspector asks for. Any “No” needs the corrective action taken; a manager who didn't do the check verifies it.
        Temperatures are logged under Cold Chain below.
      </Note>
      <Tabs value={tab} onChange={setTab} tabs={[["today", "Checklists"], ...(canVerify ? [["verify", `To verify (${toVerify.length})`]] : []), ["history", "History"], ["cold", "Cold chain"]]} />

      {tab === "today" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {active.map((c) => (
            <Card key={c.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="f-body text-sm font-semibold" style={{ color: C.ink }}>{c.name}</div>
                  <div className="f-body text-xs" style={{ color: C.muted }}>{c.frequency === "weekly" ? `Weekly · week of ${c.periodLabel}` : `Daily · ${c.periodLabel}`} · {plural(c.items.length, "check")}</div>
                </div>
                <StatusPill status={c.due ? "Due" : c.current.verifiedBy ? "Verified" : "Done"} />
              </div>
              {c.current && (
                <div className="f-body text-xs mt-2" style={{ color: c.current.allOk ? C.muted : C.danger }}>
                  {c.current.allOk ? "All checks passed" : `${plural(c.current.results.filter((x) => !x.ok).length, "check")} failed — action recorded`} · {c.current.completedBy}, {c.current.completedAt}
                </div>
              )}
              {c.due && canComplete && <div className="mt-3"><Btn small icon={ClipboardCheck} onClick={() => setDoing(c)}>Start checklist</Btn></div>}
            </Card>
          ))}
          {active.length === 0 && <Card><Empty>No checklists set up.</Empty></Card>}
        </div>
      )}

      {tab === "verify" && (
        <div className="space-y-2">
          {toVerify.length === 0 && <Card><Empty>Nothing waiting for verification.</Empty></Card>}
          {toVerify.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="f-body text-sm font-semibold" style={{ color: C.ink }}>{r.checklist} · {r.periodLabel}</div>
                  <div className="f-body text-xs" style={{ color: r.allOk ? C.muted : C.danger }}>{r.allOk ? "All passed" : `${plural(r.results.filter((x) => !x.ok).length, "failure")}`} · {r.completedBy}, {r.completedAt}</div>
                </div>
                <Btn small variant="gold" icon={ShieldCheck} onClick={() => setVerifying(r)}>Review & verify</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-2">
          {fs.runs.length === 0 && <Card><Empty>No checklists completed yet.</Empty></Card>}
          {fs.runs.map((r) => <HistoryRow key={r.id} run={r} />)}
        </div>
      )}

      {tab === "cold" && <ColdChainCard data={data} actions={actions} permit={permit} />}
    </div>
  );
}

function RunResults({ run }) {
  return (
    <div className="space-y-1.5">
      {run.results.map((x, i) => (
        <div key={i} className="f-body text-xs flex gap-2">
          <span className="shrink-0 font-semibold" style={{ color: x.ok ? C.ok : C.danger }}>{x.ok ? "✓" : "✗"}</span>
          <span style={{ color: C.ink }}>{x.item}{!x.ok && <span style={{ color: C.danger }}> — {x.action}</span>}</span>
        </div>
      ))}
      {run.note && <p className="f-body text-xs" style={{ color: C.muted }}>Note: {run.note}</p>}
    </div>
  );
}

function HistoryRow({ run }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button className="w-full flex items-center justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <div className="f-body text-sm font-semibold" style={{ color: C.ink }}>{run.checklist} · {run.periodLabel}</div>
          <div className="f-body text-xs" style={{ color: C.muted }}>{run.completedBy}, {run.completedAt}{run.verifiedBy ? ` · verified by ${run.verifiedBy}` : " · not yet verified"}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusPill status={run.allOk ? "Passed" : "Failed"} />
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>
      {open && <div className="mt-3 pt-3 border-t" style={{ borderColor: C.line }}><RunResults run={run} />{run.verifyNote && <p className="f-body text-xs mt-1" style={{ color: C.muted }}>Verifier: {run.verifyNote}</p>}</div>}
    </Card>
  );
}

function ChecklistModal({ checklist, actions, onClose }) {
  const [ans, setAns] = useState(() => checklist.items.map(() => ({ ok: null, action: "" })));
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const set = (i, v) => setAns((a) => a.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const missing = ans.filter((x) => x.ok === null).length;
  const needAction = ans.filter((x) => x.ok === false && x.action.trim().length < 3).length;
  const submit = (e) => {
    e.preventDefault();
    run(async () => { if (await actions.completeHaccp(checklist.id, { results: ans.map((x) => ({ ok: x.ok, action: x.ok ? "" : x.action.trim() })), note: note.trim() })) onClose(); });
  };
  return (
    <Modal title={checklist.name} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        {checklist.items.map((item, i) => (
          <div key={i} className="rounded-xl p-3" style={{ background: C.cream }}>
            <div className="flex items-start justify-between gap-3">
              <span className="f-body text-sm" style={{ color: C.ink }}>{item}</span>
              <div className="flex gap-1 shrink-0" role="group" aria-label={item}>
                {[[true, "Yes"], [false, "No"]].map(([v, l]) => (
                  <button key={l} type="button" onClick={() => set(i, { ok: v })} aria-pressed={ans[i].ok === v}
                    className="f-body text-xs font-semibold px-3 py-1.5 rounded-lg border"
                    style={{ background: ans[i].ok === v ? (v ? C.ok : C.danger) : "#fff", color: ans[i].ok === v ? "#fff" : C.ink, borderColor: ans[i].ok === v ? "transparent" : C.input }}>{l}</button>
                ))}
              </div>
            </div>
            {ans[i].ok === false && (
              <div className="mt-2"><Input value={ans[i].action} onChange={(e) => set(i, { action: e.target.value })} maxLength={300}
                placeholder="What did you do about it?" aria-label={`Corrective action: ${item}`} /></div>
            )}
          </div>
        ))}
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        <Btn type="submit" icon={Check} full busy={busy} disabled={missing > 0 || needAction > 0}>
          {missing ? `Answer ${plural(missing, "more check")}` : needAction ? "Record the corrective actions" : "Complete checklist"}
        </Btn>
      </form>
    </Modal>
  );
}

function ChecklistEditor({ checklists, actions, onClose }) {
  const [edit, setEdit] = useState(null); // checklist or "new"
  const [f, setF] = useState(null);
  const [busy, run] = useBusy();
  const start = (c) => { setEdit(c); setF(c === "new" ? { name: "", frequency: "daily", items: "" } : { name: c.name, frequency: c.frequency, items: c.items.join("\n") }); };
  const items = f ? f.items.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const valid = f && f.name.trim().length >= 3 && items.length > 0 && items.every((x) => x.length >= 3 && x.length <= 160);
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { name: f.name.trim(), frequency: f.frequency, items };
      const r = edit === "new" ? await actions.addChecklist(body) : await actions.updateChecklist(edit.id, body, `${body.name} saved`);
      if (r) { setEdit(null); setF(null); }
    });
  };
  return (
    <Modal title="Edit checklists" onClose={onClose} wide>
      {!edit ? (
        <div className="space-y-2">
          {checklists.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5" style={{ background: C.cream, opacity: c.active ? 1 : 0.6 }}>
              <div className="min-w-0"><div className="f-body text-sm font-medium" style={{ color: C.ink }}>{c.name}</div>
                <div className="f-body text-xs" style={{ color: C.muted }}>{c.frequency} · {plural(c.items.length, "check")}{c.active ? "" : " · retired"}</div></div>
              <div className="flex gap-1.5 shrink-0">
                {c.active && <Btn label="Edit checklist" small variant="ghost" icon={Pencil} onClick={() => start(c)} />}
                {c.active
                  ? <Btn label="Retire checklist" small variant="ghost" icon={Archive} onClick={() => actions.updateChecklist(c.id, { active: false }, `${c.name} retired`)} />
                  : <Btn small variant="ghost" icon={RotateCcw} onClick={() => actions.updateChecklist(c.id, { active: true }, `${c.name} restored`)}>Restore</Btn>}
              </div>
            </div>
          ))}
          <Btn small icon={Plus} onClick={() => start("new")}>Add checklist</Btn>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} autoFocus /></Field>
            <Field label="How often"><Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></Field>
          </div>
          <Field label="Checks — one per line, written so “Yes” is the safe answer" hint={`${plural(items.length, "check")}. Past records keep the wording they were done with.`}>
            <textarea value={f.items} onChange={(e) => setF({ ...f, items: e.target.value })} rows={8}
              className="w-full text-sm rounded-lg px-3 py-2 border outline-none focus:ring-2 bg-white f-body" style={{ borderColor: C.input }} />
          </Field>
          <div className="flex gap-2">
            <Btn type="submit" icon={Check} busy={busy} disabled={!valid}>Save</Btn>
            <Btn variant="ghost" onClick={() => { setEdit(null); setF(null); }}>Back</Btn>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ============================================================ BACKUPS (Administration) */
/** Fetch the checked backup file and save it — errors show as a message instead of a broken download. */
async function downloadBackup(actions) {
  try {
    const r = await fetch("/api/backups/download", { credentials: "same-origin" });
    if (!r.ok) { const e = await r.json().catch(() => ({})); actions.notify(e.error || "The backup couldn't be made.", "error"); return; }
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "")?.[1] || "bladeos-backup.bdb";
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    actions.notify(`Backup checked and saved as ${name} — keep it in two places`);
    await actions.refresh();
  } catch {
    actions.notify("The backup needs the internet — try again when you're online.", "error");
  }
}

export function BackupsCard({ data, actions, permit }) {
  const b = data.backups;
  const [busy, setBusy] = useState(null);
  if (!b) return null;
  if (b.mode === "manual") return <ManualBackupsCard b={b} actions={actions} permit={permit} />;
  const go = async (kind) => { setBusy(kind); await (kind === "run" ? actions.runBackup() : actions.testRestore()); setBusy(null); };
  const lastTest = b.tests[0];
  const kb = (n) => (n == null ? "—" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <DatabaseBackup size={18} style={{ color: C.burgundy }} />
          <h3 className="f-display text-base" style={{ color: C.ink }}>Backups</h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {permit("backups.manage") && b.ready && <Btn small icon={DatabaseBackup} busy={busy === "run"} disabled={!!busy} onClick={() => go("run")}>Back up now</Btn>}
          {permit("backups.manage") && b.ready && <Btn small variant="ghost" icon={FlaskConical} busy={busy === "test"} disabled={!!busy || !b.lastSuccess} onClick={() => go("test")}>Run restore test</Btn>}
          {permit("backups.download") && <Btn small variant="ghost" icon={HardDriveDownload} busy={busy === "dl"} disabled={!!busy} onClick={async () => { setBusy("dl"); await downloadBackup(actions); setBusy(null); }}>Download a copy</Btn>}
        </div>
      </div>
      {!b.ready ? (
        <div className="rounded-xl p-3 f-body text-xs space-y-1.5" style={{ background: "#F5E4E2", color: C.ink }}>
          <p className="font-semibold" style={{ color: C.danger }}>Automatic off-site backups are off. {b.problem}</p>
          <p>Create a bucket with any S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3) in a different company from your host, then add these settings to the app and redeploy:</p>
          <p className="f-mono">BACKUP_S3_ENDPOINT · BACKUP_S3_BUCKET · BACKUP_S3_ACCESS_KEY · BACKUP_S3_SECRET_KEY · BACKUP_S3_REGION · BACKUP_PASSPHRASE</p>
          <p>Until then, also turn on your host's own Postgres backups, and the Super Admin should download a copy weekly.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div className="rounded-xl p-3" style={{ background: C.cream }}>
            <div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Last good backup</div>
            <div className="f-body text-sm font-semibold" style={{ color: !b.lastSuccess || b.lastSuccess.hoursAgo > 36 ? C.danger : C.ink }}>{b.lastSuccess ? b.lastSuccess.at : "None yet"}</div>
            {b.lastSuccess && <div className="f-body text-[11px]" style={{ color: C.muted }}>{b.lastSuccess.rows?.toLocaleString("en-NG")} rows · {kb(b.lastSuccess.bytes)}</div>}
          </div>
          <div className="rounded-xl p-3" style={{ background: C.cream }}>
            <div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Last restore test</div>
            <div className="f-body text-sm font-semibold" style={{ color: lastTest?.status === "Failed" ? C.danger : C.ink }}>{lastTest ? `${lastTest.status} · ${lastTest.at}` : "Not run yet"}</div>
            {lastTest?.status === "Passed" && <div className="f-body text-[11px]" style={{ color: C.muted }}>{lastTest.tables} tables, {lastTest.rows?.toLocaleString("en-NG")} rows, {lastTest.fkChecked} links checked</div>}
            {lastTest?.status === "Failed" && <div className="f-body text-[11px]" style={{ color: C.danger }}>{lastTest.error}</div>}
          </div>
          <div className="rounded-xl p-3" style={{ background: C.cream }}>
            <div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Where</div>
            <div className="f-mono text-xs break-all" style={{ color: C.ink }}>{b.destination}</div>
            <div className="f-body text-[11px]" style={{ color: C.muted }}>{b.encrypted ? "Encrypted (AES-256)" : "Not encrypted"} · kept {b.retentionDays} days</div>
          </div>
        </div>
      )}
      <p className="f-body text-[11px] mb-2" style={{ color: C.muted }}>Daily after 02:00, restore-tested monthly. Keep BACKUP_PASSPHRASE somewhere safe outside your host — without it the copies can't be opened.</p>
      {b.recent.length > 0 && (
        <div className="space-y-1">
          {b.recent.slice(0, 5).map((x) => (
            <div key={x.id} className="flex items-center justify-between gap-2 f-body text-xs">
              <span className="min-w-0 truncate" style={{ color: C.ink }}>{x.at} · {x.storage === "download" ? `downloaded by ${x.who}` : `${x.kind}${x.kind === "manual" ? ` by ${x.who}` : ""}`}{x.error ? <span style={{ color: C.danger }}> · {x.error}</span> : ""}</span>
              <StatusPill status={x.status} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The host's own Postgres backups + a weekly, restore-checked, encrypted download kept elsewhere by the Super Admin. */
function ManualBackupsCard({ b, actions, permit }) {
  const [busy, setBusy] = useState(false);
  const kb = (n) => (n == null ? "—" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const d = b.lastDownload;
  const due = !d || d.daysAgo >= b.weeklyDays;
  const tile = (label, children) => (
    <div className="rounded-xl p-3" style={{ background: C.cream }}>
      <div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>{label}</div>
      {children}
    </div>
  );
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <DatabaseBackup size={18} style={{ color: C.burgundy }} />
          <h3 className="f-display text-base" style={{ color: C.ink }}>Backups</h3>
        </div>
        {permit("backups.download") && (
          <Btn small icon={HardDriveDownload} busy={busy} onClick={async () => { setBusy(true); await downloadBackup(actions); setBusy(false); }}>Download weekly backup</Btn>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        {tile("1 · Hosting backups", <>
          <div className="f-body text-sm font-semibold" style={{ color: C.ink }}>Set at your host</div>
          <div className="f-body text-[11px]" style={{ color: C.muted }}>Your database host's daily backups on (Fly.io, Neon, Supabase, Railway all offer them). Covers mistakes and bad updates.</div>
        </>)}
        {tile("2 · Weekly copy kept elsewhere", <>
          <div className="f-body text-sm font-semibold" style={{ color: due ? C.danger : C.ink }}>{d ? `${d.at}${due ? " — due now" : ""}` : "None yet — due now"}</div>
          {d && <div className="f-body text-[11px]" style={{ color: C.muted }}>by {d.who} · {d.rows?.toLocaleString("en-NG")} rows · {kb(d.bytes)} · restore-checked · fingerprint {d.fingerprint}</div>}
        </>)}
        {tile("Encryption", <>
          <div className="f-body text-sm font-semibold" style={{ color: b.passphraseOk ? C.ink : C.danger }}>{b.passphraseOk ? "On (AES-256)" : "Off — set BACKUP_PASSPHRASE"}</div>
          <div className="f-body text-[11px]" style={{ color: C.muted }}>{b.passphraseOk ? "Files can only be opened with the passphrase. Keep it written down safely, away from the host." : "Add BACKUP_PASSPHRASE (12+ characters) to the app's settings, so the file is useless to anyone who finds it."}</div>
        </>)}
      </div>
      <p className="f-body text-[11px] mb-2" style={{ color: C.muted }}>
        Every Monday the Super Admin downloads a copy. Each file is test-restored before you get it. Keep it in two places, e.g. the office laptop and Google Drive, and keep the last 8.
      </p>
      {b.recent.filter((x) => x.storage === "download").length > 0 && (
        <div className="space-y-1">
          {b.recent.filter((x) => x.storage === "download").slice(0, 5).map((x) => (
            <div key={x.id} className="flex items-center justify-between gap-2 f-body text-xs">
              <span className="min-w-0 truncate" style={{ color: C.ink }}>{x.at} · downloaded by {x.who}{x.error ? <span style={{ color: C.danger }}> · {x.error}</span> : ""}</span>
              <StatusPill status={x.status} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
