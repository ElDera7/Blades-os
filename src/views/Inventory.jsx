import React, { useEffect, useState } from "react";
import { Boxes, DollarSign, AlertTriangle, Snowflake, Truck, History, PackagePlus, Pencil, Check, Layers, Search } from "lucide-react";
import { C, nairaFmt, kgFmt, qtyFmt, stockStatus } from "../lib/theme.js";
import { WASTAGE_REASONS, CORRECTION_REASONS } from "../shared/permissions.js";
import { ColdChainCard, CountsCard, BatchesModal, TraceModal } from "./Operations.jsx";
import { KpiCard, SectionHeader, Btn, StatusPill, Modal, Field, Input, Select, Card, Table, useBusy } from "../components/ui.jsx";
import { api } from "../lib/api.js";

export function InventoryView({ data, actions, permit }) {
  const inventory = (data.inventory || []).filter((i) => i.trackStock !== false); // services and uncounted items have no stock to manage
  const locations = data.meta.locations;
  const [modal, setModal] = useState(null); // {type, sku?}
  const canReceive = permit("stock.receive");
  const canTransfer = permit("stock.transfer");
  const canAdjust = permit("stock.adjust.request") || permit("stock.adjust.direct");
  const adjustDirect = permit("stock.adjust.direct");
  const canEdit = canReceive || canAdjust; // opens the Receive / Adjust dialog
  const canPrice = permit("products.edit");
  const showCost = permit("costs.view");

  const byLocation = locations.map((loc) => {
    const rows = inventory.flatMap((it) => it.locations.filter((l) => l.name === loc).map((l) => ({ ...l, unit: it.unit, name: it.name })));
    return { loc, kg: rows.filter((r) => r.unit === "KG").reduce((s, r) => s + r.qty, 0), units: rows.filter((r) => r.unit !== "KG").reduce((s, r) => s + r.qty, 0), count: rows.length };
  });
  const value = showCost ? inventory.reduce((s, i) => s + i.qty * i.costPrice, 0) : null;

  return (
    <div>
      {modal?.type === "opening" && <OpeningStockModal inventory={inventory} locations={locations} onClose={() => setModal(null)} actions={actions} />}
      {modal?.type === "transfer" && <TransferModal inventory={inventory} locations={locations} initialSku={modal.sku} onClose={() => setModal(null)} onSubmit={actions.transfer} />}
      {modal?.type === "adjust" && <AdjustModal inventory={inventory} locations={locations} initialSku={modal.sku} onClose={() => setModal(null)} onSubmit={actions.adjust}
        canReceive={canReceive} canAdjust={canAdjust} direct={adjustDirect} />}
      {modal?.type === "batches" && <BatchesModal item={inventory.find((i) => i.sku === modal.sku)} permit={permit} onClose={() => setModal(null)} onTrace={(code) => setModal({ type: "trace", lot: code })} />}
      {modal?.type === "trace" && <TraceModal lot={modal.lot} actions={actions} onClose={() => setModal(null)} />}
      {modal?.type === "product" && <ProductModal item={inventory.find((i) => i.sku === modal.sku)} onClose={() => setModal(null)} onSubmit={actions.updateProduct} />}

      <SectionHeader eyebrow="Inventory" title="Stock & Cold Room" action={(canEdit || canTransfer || permit("trace.view")) && (<>
        {permit("trace.view") && <Btn icon={Search} small variant="ghost" onClick={() => setModal({ type: "trace", lot: "" })}>Trace Batch</Btn>}
        {canReceive && <Btn icon={Layers} small onClick={() => setModal({ type: "opening" })}>Opening stock</Btn>}
        {canEdit && <Btn icon={PackagePlus} small variant="ghost" onClick={() => setModal({ type: "adjust" })}>{canReceive && canAdjust ? "Receive / Adjust" : canReceive ? "Receive Stock" : "Adjust Stock"}</Btn>}
        {canTransfer && <Btn icon={Truck} small onClick={() => setModal({ type: "transfer" })}>Transfer Stock</Btn>}
      </>)} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <KpiCard label="Products Tracked" value={inventory.length} icon={Boxes} />
        {showCost ? <KpiCard label="Total Value (Cost)" value={nairaFmt(value)} icon={DollarSign} />
          : <KpiCard label="Units / Packs" value={inventory.filter((i) => i.unit !== "KG").reduce((s, i) => s + i.qty, 0).toLocaleString("en-NG")} icon={DollarSign} />}
        <KpiCard label="Below Minimum" value={inventory.filter((i) => i.qty < i.min).length} trend={inventory.some((i) => i.qty < i.min) ? "down" : null} sub="products" icon={AlertTriangle} />
        <KpiCard label="Storage Locations" value={locations.length} icon={Snowflake} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5 mb-6">
        {byLocation.map((l) => (
          <Card key={l.loc}>
            <div className="flex items-center gap-2 mb-2">
              <Snowflake size={14} style={{ color: C.burgundy }} />
              <span className="f-body text-sm font-semibold truncate" style={{ color: C.ink }}>{l.loc}</span>
            </div>
            <div className="f-mono text-lg font-semibold" style={{ color: C.ink }}>{l.count ? kgFmt(l.kg) : "—"}</div>
            <div className="f-body text-xs" style={{ color: C.muted }}>
              {l.count} product{l.count !== 1 ? "s" : ""}{l.units ? ` · ${l.units} units/packs` : ""}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        <ColdChainCard data={data} actions={actions} permit={permit} />
        {(permit("counts.perform") || permit("counts.schedule")) && <CountsCard data={data} actions={actions} permit={permit} />}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Card pad={false} className="xl:col-span-2">
          <div className="px-5 py-4 border-b f-display text-base" style={{ borderColor: C.line, color: C.ink }}>Product Inventory</div>
          <Table head={["Product", "On Hand", "Min", "Where", "Price", "Status", ""]} minWidth={760}>
            {inventory.map((it) => (
              <tr key={it.sku} className="border-t align-top" style={{ borderColor: C.rowLine }}>
                <td className="px-5 py-3">
                  <div className="f-body text-sm font-medium" style={{ color: C.ink }}>{it.name}</div>
                  <div className="f-mono text-[11px]" style={{ color: C.muted }}>{it.sku}</div>
                </td>
                <td className="px-5 py-3 f-mono text-sm font-semibold whitespace-nowrap" style={{ color: C.ink }}>{qtyFmt(it.qty, it.unit)}</td>
                <td className="px-5 py-3 f-mono text-xs whitespace-nowrap" style={{ color: C.muted }}>{qtyFmt(it.min, it.unit)}</td>
                <td className="px-5 py-3 f-body text-xs" style={{ color: C.muted }}>
                  {it.locations.length === 0 ? "—" : it.locations.map((l) => <div key={l.name} className="whitespace-nowrap">{l.name}: <span className="f-mono">{l.qty}</span></div>)}
                  {it.lots?.length > 0 && (
                    <button onClick={() => setModal({ type: "batches", sku: it.sku })} className="mt-1 inline-flex items-center gap-1 hover:underline" style={{ color: it.expiredQty > 0 ? C.danger : it.lots.some((l) => l.status === "Use soon") ? C.warn : C.burgundy }}>
                      <Layers size={11} /> {it.lots.length} batch{it.lots.length === 1 ? "" : "es"} · use by {it.lots[0].expiresOn}
                    </button>
                  )}
                </td>
                <td className="px-5 py-3 f-mono text-xs whitespace-nowrap" style={{ color: C.ink }}>{nairaFmt(it.price)}/{it.unit}</td>
                <td className="px-5 py-3"><StatusPill status={stockStatus(it)} />
                  {it.expiredQty > 0 && <div className="f-body text-[10px] mt-1 whitespace-nowrap" style={{ color: C.danger }}>{qtyFmt(it.expiredQty, it.unit)} expired</div>}</td>
                <td className="px-5 py-3">
                  <div className="flex gap-1 justify-end">
                    {canEdit && <Btn label="Receive or adjust stock" small variant="ghost" icon={PackagePlus} onClick={() => setModal({ type: "adjust", sku: it.sku })} />}
                    {canPrice && <Btn label="Edit product" small variant="ghost" icon={Pencil} onClick={() => setModal({ type: "product", sku: it.sku })} />}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <h3 className="f-display text-base mb-4 flex items-center gap-2" style={{ color: C.ink }}><History size={15} /> Stock Ledger</h3>
          <div className="space-y-3 max-h-[560px] overflow-y-auto pr-1">
            {data.ledger.map((l, i) => (
              <div key={i} className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="f-body text-[11px]" style={{ color: C.muted }}>{l.date}{l.who ? ` · ${l.who}` : ""}</div>
                  <div className="f-body text-xs" style={{ color: C.ink }}>{l.desc}</div>
                </div>
                <span className="f-mono text-sm font-semibold shrink-0" style={{ color: l.delta.startsWith("+") ? C.ok : C.danger }}>{l.delta}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function TransferModal({ inventory, locations, initialSku, onClose, onSubmit }) {
  const stocked = inventory.filter((i) => i.locations.length > 0);
  const [sku, setSku] = useState(initialSku && stocked.some((i) => i.sku === initialSku) ? initialSku : stocked[0]?.sku);
  const item = inventory.find((i) => i.sku === sku);
  const [from, setFrom] = useState(item?.locations[0]?.name);
  const [to, setTo] = useState(locations.find((l) => l !== item?.locations[0]?.name));
  const [qty, setQty] = useState("");
  const [busy, run] = useBusy();

  const pickSku = (s) => {
    const it = inventory.find((i) => i.sku === s);
    setSku(s); setFrom(it.locations[0]?.name); setTo(locations.find((l) => l !== it.locations[0]?.name)); setQty("");
  };
  const available = item?.locations.find((l) => l.name === from)?.qty ?? 0;
  const q = Number(qty);
  const err = qty === "" ? null : !(q > 0) ? "Enter a quantity above zero." : item.unit !== "KG" && !Number.isInteger(q) ? "Whole numbers only." : q > available + 1e-9 ? `Only ${available} ${item.unit} at ${from}.` : null;
  const submit = () => run(async () => { if (await onSubmit({ sku, from, to, qty: q })) onClose(); });

  if (!item) return <Modal title="Transfer Stock" onClose={onClose}><p className="f-body text-sm">There's no stock to move.</p></Modal>;
  return (
    <Modal title="Transfer Stock" onClose={onClose}>
      <div className="space-y-4 mb-5">
        <Field label="Product">
          <Select value={sku} onChange={(e) => pickSku(e.target.value)}>
            {stocked.map((i) => <option key={i.sku} value={i.sku}>{i.name} — {qtyFmt(i.qty, i.unit)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From">
            <Select value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value === to) setTo(locations.find((l) => l !== e.target.value)); }}>
              {item.locations.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.qty})</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>{locations.filter((l) => l !== from).map((l) => <option key={l}>{l}</option>)}</Select>
          </Field>
        </div>
        <Field label={`Quantity (${item.unit})`} error={err} hint={!err ? `${available} ${item.unit} available at ${from}` : null}>
          <div className="flex gap-2">
            <Input mono type="number" min="0" step={item.unit === "KG" ? "0.01" : "1"} value={qty} onChange={(e) => setQty(e.target.value)} placeholder={item.unit === "KG" ? "15.00" : "1"} />
            <Btn variant="ghost" small onClick={() => setQty(String(available))}>All</Btn>
          </div>
        </Field>
      </div>
      <Btn icon={Truck} disabled={!qty || !!err || !to} busy={busy} onClick={submit} full>Confirm Transfer</Btn>
    </Modal>
  );
}

const KINDS = {
  receipt: { label: "Receive stock", hint: "Goods in from a supplier, or opening stock. Posts immediately." },
  wastage: { label: "Write off", hint: "Stock lost or unfit for sale." },
  correction: { label: "Count correction", hint: "Fix the system to match a physical count. Use a negative number to reduce." },
};

function AdjustModal({ inventory, locations, initialSku, onClose, onSubmit, canReceive, canAdjust, direct }) {
  const kinds = Object.keys(KINDS).filter((k) => (k === "receipt" ? canReceive : canAdjust));
  const [sku, setSku] = useState(initialSku || inventory[0]?.sku);
  const [kind, setKind] = useState(kinds[0]);
  const item = inventory.find((i) => i.sku === sku);
  const [location, setLocation] = useState(item?.locations[0]?.name || locations[0]);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const reasons = kind === "wastage" ? WASTAGE_REASONS : kind === "correction" ? CORRECTION_REASONS : [];
  const shelf = item?.shelfLife ?? 5;
  const [lotCode, setLotCode] = useState("");
  const [expiresOn, setExpiresOn] = useState(() => new Date(Date.now() + 3600e3 + shelf * 864e5).toISOString().slice(0, 10));
  const [lotId, setLotId] = useState("");
  const lotsHere = (item?.lots || []).filter((l) => l.location === location);
  const todayStr = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  useEffect(() => { setExpiresOn(new Date(Date.now() + 3600e3 + (item?.shelfLife ?? 5) * 864e5).toISOString().slice(0, 10)); setLotId(""); }, [sku]);

  const available = item?.locations.find((l) => l.name === location)?.qty ?? 0;
  const q = Number(qty);
  const err = qty === "" ? null
    : !q ? "Enter a non-zero amount."
    : kind !== "correction" && q < 0 ? "Use a positive number."
    : item.unit !== "KG" && !Number.isInteger(q) ? "Whole numbers only."
    : (kind === "wastage" ? q : kind === "correction" ? -q : 0) > available + 1e-9 ? `Only ${available} ${item.unit} at ${location}.`
    : null;
  const needsApproval = kind !== "receipt" && !direct;
  const valid = qty && !err && note.trim().length >= (kind === "receipt" ? 2 : 3) && (kind === "receipt" ? expiresOn >= todayStr : reason);
  const submit = () => run(async () => {
    const body = { sku, location, kind, qty: q, note: note.trim(), ...(kind !== "receipt" ? { reason } : { lot: lotCode.trim() || undefined, expiresOn }),
      ...(kind === "wastage" && lotId ? { lotId: Number(lotId) } : {}) };
    if (await onSubmit(body)) onClose();
  });

  return (
    <Modal title={kinds.length === 1 && kinds[0] === "receipt" ? "Receive Stock" : "Receive / Adjust Stock"} onClose={onClose}>
      <div className="space-y-4 mb-5">
        {kinds.length > 1 && (
          <div className={`grid gap-2 grid-cols-${kinds.length}`} style={{ gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))` }}>
            {kinds.map((k) => (
              <button key={k} onClick={() => { setKind(k); setReason(""); }} className="rounded-lg px-2 py-2.5 f-body text-xs font-semibold text-center border transition-all active:scale-95"
                style={{ background: kind === k ? C.burgundy : "#fff", color: kind === k ? "#fff" : C.ink, borderColor: kind === k ? C.burgundy : C.input }}>{KINDS[k].label}</button>
            ))}
          </div>
        )}
        <p className="f-body text-xs" style={{ color: C.muted }}>{KINDS[kind].hint}</p>
        {needsApproval && (
          <div className="rounded-lg px-3 py-2 f-body text-xs" style={{ background: "#F6EEDD", color: C.ink }}>
            This creates a request. Stock changes only when another manager approves it on the Approvals screen.
          </div>
        )}
        <Field label="Product">
          <Select value={sku} onChange={(e) => { setSku(e.target.value); const it = inventory.find((i) => i.sku === e.target.value); setLocation(it.locations[0]?.name || locations[0]); }}>
            {inventory.map((i) => <option key={i.sku} value={i.sku}>{i.name} — {qtyFmt(i.qty, i.unit)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Location" hint={`${available} ${item?.unit} here now`}>
            <Select value={location} onChange={(e) => setLocation(e.target.value)}>{locations.map((l) => <option key={l}>{l}</option>)}</Select>
          </Field>
          <Field label={`Quantity (${item?.unit})`} error={err}>
            <Input mono type="number" step={item?.unit === "KG" ? "0.01" : "1"} value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
        </div>
        {kind === "receipt" && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Supplier batch / lot (optional)"><Input mono value={lotCode} onChange={(e) => setLotCode(e.target.value)} maxLength={40} placeholder="from the label" /></Field>
            <Field label="Use-by date" hint={`Default: ${shelf} days`} error={expiresOn < todayStr ? "Already expired" : null}>
              <Input type="date" min={todayStr} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </Field>
          </div>
        )}
        {kind === "wastage" && lotsHere.length > 0 && (
          <Field label="Batch" hint="Leave on 'oldest first' unless a specific batch is affected">
            <Select value={lotId} onChange={(e) => setLotId(e.target.value)}>
              <option value="">Oldest use-by first</option>
              {lotsHere.map((l) => <option key={l.id} value={l.id}>{l.code} · use by {l.expiresOn} · {l.qty} {item.unit}{l.status === "Expired" ? " · EXPIRED" : ""}</option>)}
            </Select>
          </Field>
        )}
        {kind !== "receipt" && (
          <Field label="Reason">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose a reason…</option>
              {reasons.map((r) => <option key={r}>{r}</option>)}
            </Select>
          </Field>
        )}
        <Field label={kind === "receipt" ? "Supplier / delivery note reference" : "What happened"}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200}
            placeholder={kind === "receipt" ? "e.g. ColdChain delivery note 4471" : kind === "wastage" ? "e.g. Freezer 02 door left open overnight" : "e.g. Saturday stock count"} />
        </Field>
      </div>
      <Btn icon={Check} disabled={!valid} busy={busy} onClick={submit} full>{kind === "receipt" ? "Receive Stock" : needsApproval ? "Submit for Approval" : "Post Adjustment"}</Btn>
    </Modal>
  );
}

function ProductModal({ item, onClose, onSubmit }) {
  const [price, setPrice] = useState(String(item.price));
  const [cost, setCost] = useState(String(item.costPrice));
  const [min, setMin] = useState(String(item.min));
  const [busy, run] = useBusy();
  const valid = [price, cost, min].every((v) => v !== "" && Number(v) >= 0) && Number.isInteger(Number(price)) && Number.isInteger(Number(cost));
  const margin = Number(price) > 0 ? Math.round(((Number(price) - Number(cost)) / Number(price)) * 100) : 0;
  const submit = () => run(async () => {
    const body = {};
    if (Number(price) !== item.price) body.price = Number(price);
    if (Number(cost) !== item.costPrice) body.costPrice = Number(cost);
    if (Number(min) !== item.min) body.min = Number(min);
    if (!Object.keys(body).length) return onClose();
    if (await onSubmit(item.sku, body)) onClose();
  });
  return (
    <Modal title={`Edit ${item.name}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <Field label={`Selling price (₦/${item.unit})`}><Input mono type="number" min="0" step="1" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label={`Cost price (₦/${item.unit})`}><Input mono type="number" min="0" step="1" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
        <Field label={`Minimum stock (${item.unit})`}><Input mono type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="Gross margin"><div className="f-mono text-sm py-2" style={{ color: margin > 0 ? C.ok : C.danger }}>{margin}%</div></Field>
      </div>
      <p className="f-body text-xs mb-5" style={{ color: C.muted }}>Price changes apply to new sales only and are recorded in the audit trail.</p>
      <Btn icon={Check} disabled={!valid} busy={busy} onClick={submit} full>Save Changes</Btn>
    </Modal>
  );
}

/**
 * Enter today's stock for every product on one screen (the first day, or after a full count): each quantity is
 * recorded as a receipt into the chosen location with the same reference. Blank rows are skipped.
 */
function OpeningStockModal({ inventory, locations, onClose, actions }) {
  const [loc, setLoc] = useState(locations.includes("Display Chiller") ? "Display Chiller" : locations[0]);
  const [ref, setRef] = useState(`Opening stock ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Lagos" })}`);
  const [qty, setQty] = useState({});
  const [progress, setProgress] = useState(null);
  const [errors, setErrors] = useState([]);
  const filled = inventory.filter((i) => Number(qty[i.sku]) > 0);
  const bad = inventory.filter((i) => qty[i.sku] && (!(Number(qty[i.sku]) > 0) || (i.unit !== "KG" && !Number.isInteger(Number(qty[i.sku])))));
  const save = async () => {
    setErrors([]);
    const errs = [];
    for (const [n, i] of filled.entries()) {
      setProgress(`Saving ${n + 1} of ${filled.length} — ${i.name}`);
      try { await api("/inventory/adjust", { method: "POST", body: { sku: i.sku, location: loc, kind: "receipt", qty: Number(qty[i.sku]), note: ref.trim() } }); }
      catch (e) { errs.push(`${i.name}: ${e.message}`); }
    }
    setProgress(null);
    await actions.refresh();
    if (errs.length) setErrors(errs);
    else { actions.notify(`Stock recorded for ${filled.length} product${filled.length === 1 ? "" : "s"}`); onClose(); }
  };
  return (
    <Modal title="Opening stock" onClose={progress ? () => {} : onClose} wide>
      <p className="f-body text-sm mb-4" style={{ color: C.muted }}>Count what's in the chiller or cold room and type the amounts. Leave a row blank if there's none. Every amount is recorded as stock received, under one reference.</p>
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <Field label="Where it is"><Select value={loc} onChange={(e) => setLoc(e.target.value)}>{locations.map((l) => <option key={l}>{l}</option>)}</Select></Field>
        <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={200} /></Field>
      </div>
      <div className="rounded-xl border divide-y max-h-[50vh] overflow-y-auto mb-4" style={{ borderColor: C.border }}>
        {inventory.map((i) => (
          <label key={i.sku} className="flex items-center gap-3 px-3 py-2" style={{ borderColor: C.line }}>
            {i.image ? <img src={i.image} alt="" className="w-9 h-9 rounded object-cover shrink-0" style={{ background: C.cream2 }} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="w-9 h-9 shrink-0" />}
            <span className="flex-1 min-w-0">
              <span className="f-body text-sm font-medium block truncate" style={{ color: C.ink }}>{i.name}</span>
              <span className="f-mono text-[11px]" style={{ color: C.muted }}>now {qtyFmt(i.qty, i.unit)}</span>
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className="w-24 block"><Input mono type="number" min="0" step={i.unit === "KG" ? "0.001" : "1"} inputMode="decimal" value={qty[i.sku] ?? ""} aria-label={`${i.name} quantity`}
                onChange={(e) => setQty((q) => ({ ...q, [i.sku]: e.target.value }))} /></span>
              <span className="f-mono text-xs w-9" style={{ color: C.muted }}>{i.unit}</span>
            </span>
          </label>
        ))}
      </div>
      {errors.length > 0 && <div className="f-body text-xs mb-3 rounded-lg px-3 py-2" style={{ background: "#F5E4E2", color: C.danger }}>{errors.map((e) => <div key={e}>{e}</div>)}</div>}
      {progress && <p className="f-body text-xs mb-3" style={{ color: C.muted }}>{progress}</p>}
      <Btn full icon={Check} busy={!!progress} disabled={!filled.length || bad.length > 0 || ref.trim().length < 2} onClick={save}>
        {bad.length ? "Check the highlighted amounts" : `Record stock for ${filled.length} product${filled.length === 1 ? "" : "s"}`}
      </Btn>
    </Modal>
  );
}
