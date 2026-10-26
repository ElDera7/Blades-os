// Counter POS: scan or search → ticket → discounts (manager PIN) → tender (split, change) → receipt.
// Keyboard: F2 search · F4 / F12 pay · F8 hold · F9 discount · Esc close. A USB barcode scanner works anywhere on the screen.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, ScanLine, X, Plus, Minus, Trash2, PauseCircle, PlayCircle, Percent, UserPlus, Printer, Check, ShoppingCart,
  Banknote, CreditCard, Landmark, Delete, ShieldCheck, Receipt, Ban, FileText, Clock, Settings2, Monitor,
} from "lucide-react";
import { C, nairaFmt, qtyFmt } from "../lib/theme.js";
import { QUICK_CASH } from "../shared/permissions.js";
import { SectionHeader, Btn, Modal, Field, Input, Select, Empty, useBusy } from "../components/ui.jsx";
import { ScaleReader, useScale } from "../lib/scale.jsx";
import { TillBar, AddCustomerModal } from "./Sales.jsx";
import { DevicesModal, HardwareStatus } from "./Devices.jsx";
import { printBlocks, receiptBlocks, reportBlocks, loadDevices, customerDisplay, openCustomerDisplay, markScannerSeen } from "../lib/hardware.js";

const AREAS = ["Wuse II", "Garki", "Maitama", "Gwarinpa", "Jabi", "Asokoro", "Life Camp", "Utako", "Kubwa", "Lokogoma"];
const VOID_REASONS = ["Customer changed mind", "Wrong items keyed", "Price query", "Customer couldn't pay", "Training"];
const round3 = (n) => Math.round(n * 1000) / 1000;
const newRef = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const discAmt = (d, base) => (!d || !d.value ? 0 : Math.min(base, d.type === "pct" ? Math.round((base * Math.min(d.value, 100)) / 100) : Math.round(d.value)));

/** Same arithmetic as the server: line discounts, then the ticket discount spread across lines, VAT inside the price. */
export function priceTicket(cart, ticketDiscount, vatOf = () => 0) {
  const lines = cart.map((l) => { const gross = Math.round(l.qty * l.price); return { ...l, gross, disc: discAmt(l.discount, gross) }; });
  const gross = lines.reduce((s, l) => s + l.gross, 0);
  const afterLines = lines.reduce((s, l) => s + l.gross - l.disc, 0);
  const tDisc = discAmt(ticketDiscount, afterLines);
  if (tDisc > 0) {
    let left = tDisc;
    lines.forEach((l, i) => {
      const share = i === lines.length - 1 ? left : Math.min(left, Math.round((tDisc * (l.gross - l.disc)) / afterLines));
      l.disc += share; left -= share;
    });
  }
  let tax = 0;
  for (const l of lines) {
    l.total = l.gross - l.disc;
    const v = vatOf(l.sku);
    l.tax = v ? Math.round((l.total * v) / (100 + v)) : 0;
    tax += l.tax;
  }
  const discount = lines.reduce((s, l) => s + l.disc, 0);
  return { lines, gross, discount, total: gross - discount, tax, pct: gross ? (discount / gross) * 100 : 0, lineDiscounts: afterLines !== gross };
}

const eanOk = (code) => {
  if (!/^\d{13}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const sum = d.slice(0, 12).reduce((s, x, i) => s + x * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
};

/* ============================================================ the screen */
export function POSView({ data, actions, permit }) {
  const inventory = data.inventory || [];
  const customers = data.customers || [];
  const pos = data.pos || { held: [], profile: {}, discountReasons: [], myDiscountPct: 0 };
  const bySku = useMemo(() => Object.fromEntries(inventory.map((p) => [p.sku, p])), [inventory]);
  const tillOpen = true; // no opening step: the first sale opens the till
  const canReceive = permit("stock.receive");
  // Nothing counted has stock yet (a new install, before deliveries are recorded): say so plainly.
  const noStock = inventory.some((p) => p.trackStock !== false) && inventory.filter((p) => p.trackStock !== false).every((p) => (p.sellable ?? p.qty) <= 0);

  const [cart, setCart] = useState([]);
  const [ticketDiscount, setTicketDiscount] = useState(null);
  const [discountReason, setDiscountReason] = useState("");
  const [approval, setApproval] = useState(null);           // { token, maxPct, approver }
  const [customerId, setCustomerId] = useState("");
  const [fulfilment, setFulfilment] = useState("Walk-in");
  const [area, setArea] = useState("");
  const [clientRef, setClientRef] = useState(newRef);
  const [cat, setCat] = useState("All");
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(null);             // product awaiting a weight / quantity
  const [modal, setModal] = useState(null);                 // "pay" | "discount" | "approve" | "held" | "hold" | "clear" | "customer" | { line }
  const [scanMsg, setScanMsg] = useState(null);
  const searchRef = useRef(null);
  const startPayRef = useRef(() => {});

  const priced = priceTicket(cart, ticketDiscount, (sku) => bySku[sku]?.vatRate || 0);
  const customer = customers.find((c) => String(c.id) === String(customerId));
  const inCart = (sku, exceptKey) => cart.filter((c) => c.sku === sku && c.key !== exceptKey).reduce((s, c) => s + c.qty, 0);
  // Items that aren't stock-counted (e.g. a sealing service) can always be sold.
  const availableOf = (p, exceptKey) => (p.trackStock === false ? 99999 : Math.max(0, round3((p.sellable ?? p.qty) - inCart(p.sku, exceptKey))));
  const needsApproval = priced.discount > 0 && priced.pct > pos.myDiscountPct + 1e-9 && (!approval || priced.pct > approval.maxPct + 1e-9);

  useEffect(() => { if (customer && customer.area !== "—") setArea(customer.area); }, [customerId]);
  useEffect(() => { if (!scanMsg) return; const t = setTimeout(() => setScanMsg(null), 2600); return () => clearTimeout(t); }, [scanMsg]);

  // Scanners that send nothing after the code: a burst of fast keystrokes followed by a pause is a scan.
  const [devices, setDevices] = useState(loadDevices);
  useEffect(() => { const h = (e) => setDevices(e.detail); window.addEventListener("bladeos-devices", h); return () => window.removeEventListener("bladeos-devices", h); }, []);
  const burst = useRef({ last: 0, fast: 0, timer: null });
  const onSearchChange = (v) => {
    setSearch(v);
    const now = performance.now(), b = burst.current;
    b.fast = now - b.last < 40 ? b.fast + 1 : 0;
    b.last = now;
    clearTimeout(b.timer);
    if (devices.scannerSuffix === "none" || devices.scannerSuffix === "auto") {
      if (b.fast >= 5 && /^\d{6,14}$/.test(v.trim())) b.timer = setTimeout(() => { burst.current.fast = 0; markScannerSeen(); handleCodeRef.current(v); }, 120);
    }
  };
  const handleCodeRef = useRef(() => {});

  // Customer screen: mirror the ticket.
  useEffect(() => {
    if (modal === "pay") return;
    customerDisplay.send({ type: "ticket", profile: pos.profile, customer: customer?.name,
      lines: priced.lines.map((l) => ({ name: l.name, qty: qtyFmt(l.qty, l.unit), price: l.price, discount: l.disc, total: l.total })),
      gross: priced.gross, discount: priced.discount, tax: priced.tax, total: priced.total });
  }, [cart, ticketDiscount, customerId, modal]);
  useEffect(() => customerDisplay.listen((m) => {
    if (m?.type === "hello") customerDisplay.send({ type: "ticket", profile: pos.profile, customer: customer?.name,
      lines: priced.lines.map((l) => ({ name: l.name, qty: qtyFmt(l.qty, l.unit), price: l.price, discount: l.disc, total: l.total })),
      gross: priced.gross, discount: priced.discount, tax: priced.tax, total: priced.total });
  }), [cart, ticketDiscount, customerId]);

  const reset = () => {
    setCart([]); setTicketDiscount(null); setDiscountReason(""); setApproval(null); setCustomerId(""); setFulfilment("Walk-in"); setArea("");
    setClientRef(newRef()); setPicking(null); setSearch("");
  };

  const addLine = useCallback((p, qty, scale = false) => {
    const avail = availableOf(p);
    if (qty > avail + 1e-9) { setScanMsg({ bad: true, text: `Only ${qtyFmt(avail, p.unit)} of ${p.name} available.` }); return false; }
    setCart((prev) => {
      // Weighed items stay separate lines (each weighing is its own pack); counted items merge.
      const i = p.unit !== "KG" ? prev.findIndex((c) => c.sku === p.sku && !c.discount) : -1;
      if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], qty: n[i].qty + qty }; return n; }
      return [...prev, { key: newRef(), sku: p.sku, name: p.name, unit: p.unit, price: p.price, qty: round3(qty), scale }];
    });
    setScanMsg({ text: `${p.name} · ${qtyFmt(qty, p.unit)} added` });
    return true;
  }, [cart, inventory]);

  /** A scanned or typed code: product barcode, scale label (EAN-13 starting 2), or PLU. */
  const handleCode = (raw) => {
    const code = String(raw).trim();
    if (!code) return;
    const exact = inventory.find((p) => p.barcode && p.barcode === code);
    if (exact) { exact.unit === "KG" ? setPicking(exact) : addLine(exact, 1); setSearch(""); return; }
    if (/^2\d{12}$/.test(code)) {
      if (!eanOk(code)) { setScanMsg({ bad: true, text: "That label didn't scan cleanly — scan it again." }); setSearch(""); return; }
      const plu = Number(code.slice(2, 7)), value = Number(code.slice(7, 12));
      const p = inventory.find((x) => x.plu === plu);
      if (!p) { setScanMsg({ bad: true, text: `No product has PLU ${plu}.` }); setSearch(""); return; }
      const qty = pos.profile.scaleLabel === "price" ? round3(value / p.price) : round3(value / 1000);
      if (!(qty > 0)) { setScanMsg({ bad: true, text: "That label has no weight." }); setSearch(""); return; }
      addLine(p, qty, true); setSearch(""); return;
    }
    if (/^\d{1,5}$/.test(code)) {
      const p = inventory.find((x) => x.plu === Number(code));
      if (p) { p.unit === "KG" ? setPicking(p) : addLine(p, 1); setSearch(""); return; }
    }
    const hits = inventory.filter((p) => p.name.toLowerCase().includes(code.toLowerCase()));
    if (hits.length === 1) { hits[0].unit === "KG" ? setPicking(hits[0]) : addLine(hits[0], 1); setSearch(""); return; }
    if (!hits.length) setScanMsg({ bad: true, text: `Nothing matches “${code}”.` });
  };

  handleCodeRef.current = handleCode;
  // An app update waits while a ticket is open (applied between customers).
  useEffect(() => { window.__bladeosBusy = cart.length > 0 || modal === "pay"; return () => { window.__bladeosBusy = false; }; }, [cart, modal]);
  // Keyboard: shortcuts, and a barcode scanner typing while focus is elsewhere lands in the search box.
  useEffect(() => {
    if (!tillOpen) return;
    const onKey = (e) => {
      if (modal) return;
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); return; }
      if ((e.key === "F4" || e.key === "F12") && cart.length) { e.preventDefault(); startPayRef.current(); return; }
      if (e.key === "F8" && cart.length) { e.preventDefault(); setModal("hold"); return; }
      if (e.key === "F9" && cart.length) { e.preventDefault(); setModal("discount"); return; }
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
      if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setSearch((s) => s + e.key);
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, cart, tillOpen]);

  const cats = ["All", ...new Set(inventory.map((i) => i.cat))];
  const q = search.trim().toLowerCase();
  const shown = inventory.filter((p) => (cat === "All" || p.cat === cat) &&
    (!q || p.name.toLowerCase().includes(q) || String(p.plu ?? "") === q || (p.barcode || "").startsWith(q) || p.sku.toLowerCase().includes(q)));

  const recall = async (h) => {
    if (cart.length) { setScanMsg({ bad: true, text: "Hold or clear the current ticket first." }); return; }
    const r = await actions.recallTicket(h.id);
    if (!r) return;
    const items = r.cart.items.map((i) => { const p = bySku[i.sku]; return p ? { key: newRef(), sku: p.sku, name: p.name, unit: p.unit, price: p.price, qty: i.qty, scale: !!i.scale, discount: i.discount } : null; }).filter(Boolean);
    setCart(items); setTicketDiscount(r.cart.discount ?? null); setDiscountReason(r.cart.discountReason ?? "");
    setCustomerId(r.customerId ? String(r.customerId) : ""); setClientRef(newRef()); setModal(null);
    if (items.length < r.cart.items.length) setScanMsg({ bad: true, text: "Some items on that ticket are no longer for sale." });
  };

  const startPay = () => {
    if (needsApproval) { setModal("approve"); return; }
    if (priced.discount > 0 && !discountReason) { setModal("discount"); return; }
    setModal("pay");
  };
  const deliveryInvalid = fulfilment === "Delivery" && (!customer || !area.trim());
  startPayRef.current = () => { if (!deliveryInvalid) startPay(); };   // same checks for the F4 key as for the Pay button

  return (
    <div>
      <SectionHeader eyebrow="Point of Sale" title="POS Terminal" action={
        <div className="flex gap-1.5">
          <HardwareStatus onOpen={() => setModal("devices")} />
          <Btn small variant="ghost" icon={Monitor} onClick={() => openCustomerDisplay()}>Customer screen</Btn>
          <Btn small variant="ghost" icon={Settings2} onClick={() => setModal("devices")}>Devices</Btn>
          <TillBar till={data.tills?.mine} actions={actions} label="till" canX={permit("till.review")} />
        </div>} />
      {tillOpen && (
        <div className="flex flex-col lg:grid lg:grid-cols-5 gap-4 lg:h-[calc(100vh-215px)] pb-20 lg:pb-0">
          {/* ---------------- products */}
          <div className="lg:col-span-3 flex flex-col rounded-2xl border overflow-hidden lg:h-full" style={{ background: "#fff", borderColor: C.border }}>
            <form onSubmit={(e) => { e.preventDefault(); if (burst.current.fast >= 4) markScannerSeen(); handleCode(search); }} className="p-3 border-b flex gap-2" style={{ borderColor: C.line }}>
              <div className="relative flex-1">
                <ScanLine size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: C.muted }} />
                <input ref={searchRef} value={search} onChange={(e) => onSearchChange(e.target.value)} aria-label="Scan or search"
                  onKeyDown={(e) => { if (e.key === "Tab" && search.trim() && devices.scannerSuffix !== "enter") { e.preventDefault(); clearTimeout(burst.current.timer); if (burst.current.fast >= 4) markScannerSeen(); handleCode(search); } }}
                  placeholder="Scan barcode, type PLU or name (F2)" autoComplete="off" inputMode="search"
                  className="f-body w-full text-sm rounded-lg pl-9 pr-8 py-2.5 border outline-none focus:ring-2" style={{ borderColor: C.input, "--tw-ring-color": C.goldLight }} />
                {search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-1"><X size={14} style={{ color: C.muted }} /></button>}
              </div>
            </form>
            {noStock && (
              <div className="f-body text-xs px-4 py-2 flex flex-wrap items-center justify-between gap-2" style={{ background: "#F6EEDD", color: C.ink }} data-no-stock>
                <span>No stock has been recorded yet, so meat items can't be sold. {canReceive ? "Enter today's stock once and every item opens up." : "Ask a manager to record today's stock."}</span>
                {canReceive && <Btn small onClick={() => { window.location.hash = "#inventory"; }}>Enter opening stock</Btn>}
              </div>
            )}
            {scanMsg && <div role="status" className="f-body text-xs px-4 py-1.5" style={{ background: scanMsg.bad ? "#F5E4E2" : "#E7F0E9", color: scanMsg.bad ? C.danger : C.ok }}>{scanMsg.text}</div>}
            <div className="flex gap-1.5 px-3 py-2 border-b overflow-x-auto" style={{ borderColor: C.line }}>
              {cats.map((c) => (
                <button key={c} onClick={() => setCat(c)} className="f-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 active:scale-95"
                  style={{ background: cat === c ? C.burgundy : C.cream, color: cat === c ? "#fff" : C.muted }}>{c}</button>
              ))}
            </div>
            <div className="p-3 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 auto-rows-max gap-2.5 lg:overflow-y-auto lg:flex-1 lg:min-h-0 content-start">
              {shown.map((p) => {
                const avail = availableOf(p);
                const out = avail <= 0;
                return (
                  <button key={p.sku} aria-disabled={out || undefined} data-out={out || undefined}
                    onClick={() => (out
                      ? setScanMsg({ bad: true, text: `${p.name} is out of stock.${canReceive ? " Record a delivery in Inventory → Receive Stock." : " Ask a manager to record the delivery."}` })
                      : p.unit === "KG" ? setPicking(p) : addLine(p, 1))}
                    className={`rounded-xl p-3 text-left border transition-all min-h-[92px] flex flex-col ${out ? "cursor-not-allowed" : "hover:shadow-md active:scale-[0.97]"}`}
                    style={{ background: picking?.sku === p.sku ? "#F3E4E6" : out ? "#FBF9F5" : C.cream, borderColor: picking?.sku === p.sku ? C.burgundy : C.border }}>
                    {p.image && <ProductPhoto src={p.image} out={out} />}
                    <div className="flex items-start justify-between gap-1.5 mb-1">
                      <span className="f-body text-sm font-semibold leading-tight" style={{ color: out ? C.muted : C.ink }}>{p.name}</span>
                      {p.plu ? <span className="f-mono text-[10px] shrink-0 px-1 rounded" style={{ color: C.muted, background: "#fff" }}>{p.plu}</span> : null}
                    </div>
                    <div className="f-mono text-[11px] mb-auto" style={{ color: out ? C.danger : C.muted }}>{out ? "Out of stock" : p.trackStock === false ? "Always available" : qtyFmt(avail, p.unit)}</div>
                    <div className="f-mono text-sm font-semibold mt-1.5" style={{ color: C.burgundy }}>{nairaFmt(p.price)}<span className="text-[10px] font-normal" style={{ color: C.muted }}>/{p.unit}</span></div>
                  </button>
                );
              })}
              {!shown.length && <div className="col-span-full py-8 text-center"><Empty>No products match.</Empty></div>}
            </div>
          </div>

          {/* ---------------- ticket */}
          <div className="lg:col-span-2 rounded-2xl border flex flex-col lg:h-full" style={{ background: "#fff", borderColor: C.border }}>
            <div className="px-4 py-3 border-b space-y-2" style={{ borderColor: C.line }}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="f-display text-base" style={{ color: C.ink }}>Ticket{cart.length ? ` · ${cart.length} line${cart.length === 1 ? "" : "s"}` : ""}</h3>
                <div className="flex gap-1.5">
                  <Btn small variant="ghost" icon={PlayCircle} onClick={() => setModal("held")}>Held{pos.held.length ? ` (${pos.held.length})` : ""}</Btn>
                  {permit("customers.edit") && <Btn small variant="ghost" icon={UserPlus} label="Add customer" onClick={() => setModal("customer")} />}
                </div>
              </div>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Customer">
                <option value="">Walk-in customer</option>
                {[...customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone !== "—" ? ` · ${c.phone}` : ""}</option>)}
              </Select>
            </div>

            <div className="lg:flex-1 overflow-y-auto max-h-80 lg:max-h-none">
              {!cart.length && <div className="text-center px-6 py-10"><ShoppingCart size={26} style={{ color: C.mutedLight, margin: "0 auto 8px" }} /><p className="f-body text-sm" style={{ color: C.muted }}>Scan an item or tap a product.</p></div>}
              {priced.lines.map((l) => (
                <button key={l.key} onClick={() => setModal({ line: l.key })} aria-label={`Edit ${l.name}`}
                  className="w-full text-left px-4 py-2.5 border-b flex items-start justify-between gap-3 hover:bg-stone-50" style={{ borderColor: C.rowLine }}>
                  <div className="min-w-0">
                    <div className="f-body text-sm font-medium truncate" style={{ color: C.ink }}>{l.name}</div>
                    <div className="f-mono text-[11px]" style={{ color: C.muted }}>
                      {qtyFmt(l.qty, l.unit)} × {nairaFmt(l.price)}{l.scale ? " · weighed" : ""}
                    </div>
                    {l.disc > 0 && <div className="f-mono text-[11px]" style={{ color: C.gold }}>discount −{nairaFmt(l.disc)}</div>}
                  </div>
                  <span className="f-mono text-sm font-semibold shrink-0" style={{ color: C.ink }}>{nairaFmt(l.total)}</span>
                </button>
              ))}
            </div>

            <div className="border-t p-4 space-y-2.5" style={{ borderColor: C.line }}>
              <div className="space-y-1 f-body text-sm">
                <Row label="Subtotal" value={nairaFmt(priced.gross)} />
                {priced.discount > 0 && <Row label={`Discount${discountReason ? ` · ${discountReason}` : ""}`} value={`−${nairaFmt(priced.discount)}`} tone={C.gold} />}
                {priced.tax > 0 && <Row label="VAT included" value={nairaFmt(priced.tax)} muted />}
              </div>
              <div className="flex items-baseline justify-between pt-1 border-t" style={{ borderColor: C.line }}>
                <span className="f-body text-sm font-semibold" style={{ color: C.ink }}>Total</span>
                <span className="f-mono text-2xl font-bold" style={{ color: C.burgundy }} data-total>{nairaFmt(priced.total)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {["Walk-in", "Delivery"].map((f) => (
                  <button key={f} onClick={() => setFulfilment(f)} className="rounded-lg py-1.5 f-body text-xs font-semibold border active:scale-95"
                    style={{ background: fulfilment === f ? C.charcoal : "#fff", color: fulfilment === f ? "#fff" : C.ink, borderColor: fulfilment === f ? C.charcoal : C.input }}>{f}</button>
                ))}
              </div>
              {fulfilment === "Delivery" && (
                <Field label="Delivery area" error={!customer ? "Pick a customer for delivery." : null}>
                  <Input list="pos-areas" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Garki" maxLength={60} />
                  <datalist id="pos-areas">{AREAS.map((a) => <option key={a} value={a} />)}</datalist>
                </Field>
              )}
              <div className="grid grid-cols-3 gap-2">
                <Btn small variant="ghost" icon={PauseCircle} disabled={!cart.length} onClick={() => setModal("hold")}>Hold</Btn>
                <Btn small variant="ghost" icon={Percent} disabled={!cart.length} onClick={() => setModal("discount")}>Discount</Btn>
                <Btn small variant="danger" icon={Ban} disabled={!cart.length} onClick={() => setModal("clear")}>Clear</Btn>
              </div>
              <div className="hidden lg:block">
                <PayButton total={priced.total} disabled={!cart.length || deliveryInvalid} onClick={startPay} />
              </div>
              <p className="hidden lg:block f-body text-[10px] text-center" style={{ color: C.muted }}>F2 search · F4 pay · F8 hold · F9 discount</p>
            </div>
          </div>

          {/* phone: sticky pay bar */}
          <div className="lg:hidden fixed bottom-0 inset-x-0 p-3 z-40 border-t" style={{ background: "#fff", borderColor: C.border }}>
            <PayButton total={priced.total} lines={cart.length} disabled={!cart.length || deliveryInvalid} onClick={startPay} />
          </div>
        </div>
      )}

      {picking && <WeighModal product={picking} available={availableOf(picking)} onClose={() => setPicking(null)}
        onAdd={(qty, scale) => { if (addLine(picking, qty, scale)) setPicking(null); }} />}
      {modal?.line && (() => {
        const l = cart.find((c) => c.key === modal.line);
        if (!l) return null;
        return <LineModal line={l} product={bySku[l.sku]} available={availableOf(bySku[l.sku] || l, l.key)} reasons={pos.discountReasons} reason={discountReason}
          onClose={() => setModal(null)}
          onSave={(next, reason) => { setCart((c) => c.map((x) => (x.key === l.key ? { ...x, ...next } : x))); if (reason) setDiscountReason(reason); setModal(null); }}
          onRemove={() => { setCart((c) => c.filter((x) => x.key !== l.key)); setModal(null); }} />;
      })()}
      {modal === "discount" && <DiscountModal priced={priced} current={ticketDiscount} reason={discountReason} reasons={pos.discountReasons}
        cartForPct={(d) => priceTicket(cart, d).pct} myPct={pos.myDiscountPct} approval={approval} actions={actions} onClose={() => setModal(null)}
        onApply={(d, reason, appr) => { setTicketDiscount(d); setDiscountReason(d || cart.some((c) => c.discount) ? reason : ""); if (appr) setApproval(appr); setModal(null); }} />}
      {modal === "approve" && <ApprovalModal pct={priced.pct} reasons={pos.discountReasons} reason={discountReason} actions={actions} onClose={() => setModal(null)}
        onApproved={(appr, reason) => { setApproval(appr); setDiscountReason(reason); setModal("pay"); }} />}
      {modal === "pay" && <TenderModal total={priced.total} priced={priced} customer={customer} profile={pos.profile} user={data.user}
        onClose={() => setModal(null)} onDone={reset}
        submit={(tender) => actions.sell({
          clientRef, customerId: customer ? customer.id : null, fulfilment, ...(fulfilment === "Delivery" ? { area: area.trim() } : {}),
          items: cart.map((c) => ({ sku: c.sku, qty: c.qty, scale: !!c.scale, ...(c.discount ? { discount: c.discount } : {}) })),
          ...(ticketDiscount ? { discount: ticketDiscount } : {}), ...(priced.discount ? { discountReason } : {}),
          ...(approval ? { overrideToken: approval.token } : {}), ...tender,
        })} />}
      {modal === "hold" && <HoldModal onClose={() => setModal(null)} onHold={async (label) => {
        const r = await actions.holdTicket({ label, customerId: customer?.id ?? null, total: priced.total,
          cart: { items: cart.map((c) => ({ sku: c.sku, qty: c.qty, scale: !!c.scale, ...(c.discount ? { discount: c.discount } : {}) })), ...(ticketDiscount ? { discount: ticketDiscount } : {}), ...(discountReason ? { discountReason } : {}) } });
        if (r) { reset(); setModal(null); }
      }} />}
      {modal === "held" && <HeldModal held={pos.held} onClose={() => setModal(null)} onRecall={recall} />}
      {modal === "clear" && <ClearModal lines={cart.length} total={priced.total} onClose={() => setModal(null)}
        onClear={async (reason) => { await actions.voidTicket({ lines: cart.length, value: priced.total, reason }); reset(); setModal(null); }} />}
      {modal === "devices" && <DevicesModal inventory={inventory} profile={pos.profile} onClose={() => setModal(null)} />}
      {modal === "customer" && <AddCustomerModal onClose={() => setModal(null)} onSave={actions.addCustomer} onCreated={(c) => setCustomerId(String(c.id))} />}
    </div>
  );
}

const Row = ({ label, value, tone, muted }) => (
  <div className="flex justify-between gap-3"><span className="truncate" style={{ color: muted ? C.muted : C.ink }}>{label}</span><span className="f-mono shrink-0" style={{ color: tone || (muted ? C.muted : C.ink) }}>{value}</span></div>
);
const PayButton = ({ total, lines, disabled, onClick }) => (
  <button onClick={onClick} disabled={disabled} className="w-full rounded-xl py-3.5 f-body font-semibold text-base flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-40"
    style={{ background: C.ok, color: "#fff" }}>
    <Banknote size={18} /> Pay {nairaFmt(total)}{lines != null && lines > 0 ? <span className="text-xs font-normal opacity-80">· {lines} line{lines === 1 ? "" : "s"}</span> : null}
  </button>
);

/* ============================================================ weigh / quantity */
function WeighModal({ product, available, onClose, onAdd }) {
  const scale = useScale();
  const [qty, setQty] = useState("");
  const [fromScale, setFromScale] = useState(false);
  const q = Number(qty);
  const err = qty === "" ? null : !(q > 0) ? "Enter a weight above zero." : q > available + 1e-9 ? `Only ${available} KG available.` : null;

  // Auto-populate weight from live scale if connected with a valid weight
  useEffect(() => {
    if (scale?.reading?.kg != null && scale.reading.kg > 0 && !scale.reading.overload) {
      setQty(String(scale.reading.kg));
      setFromScale(true);
    }
  }, [scale?.reading?.kg]);

  return (
    <Modal title={`${product.name} — ${nairaFmt(product.price)}/KG`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (!err && q > 0) onAdd(round3(q), fromScale); }} className="space-y-3">
        <div className="f-body text-[10px] uppercase tracking-wide flex items-center justify-between" style={{ color: C.muted }}>
          <span>Weight (KG)</span>
          {fromScale && <span className="font-semibold" style={{ color: C.ok }}>✓ LIVE SCALE SYNC</span>}
        </div>
        <input autoFocus type="number" step="0.001" min="0" value={qty} onChange={(e) => { setQty(e.target.value); setFromScale(false); }} aria-label="Weight"
          placeholder="1.250" className="f-mono text-3xl font-semibold w-full rounded-lg px-3 py-2 border outline-none focus:ring-2" style={{ borderColor: err ? C.danger : C.input }} />
        <div className="f-body text-xs" style={{ color: err ? C.danger : C.muted }}>{err || `${available} KG available`}{fromScale && !err ? " · from scale" : ""}</div>
        <ScaleReader max={available} onWeight={(kg) => { setQty(String(kg)); setFromScale(true); }} />
        <div className="flex items-center justify-between pt-2">
          <span className="f-mono text-2xl font-semibold" style={{ color: C.burgundy }}>{nairaFmt((q || 0) * product.price)}</span>
          <Btn type="submit" icon={Plus} disabled={qty === "" || !!err}>Add to ticket</Btn>
        </div>
      </form>
    </Modal>
  );
}

/* ============================================================ line edit */
function LineModal({ line, product, available, reasons, reason: curReason, onClose, onSave, onRemove }) {
  const [qty, setQty] = useState(String(line.qty));
  const [dType, setDType] = useState(line.discount?.type ?? "pct");
  const [dVal, setDVal] = useState(line.discount ? String(line.discount.value) : "");
  const [reason, setReason] = useState(curReason || "");
  const q = Number(qty), dv = Number(dVal || 0);
  const kg = line.unit === "KG";
  const max = round3(available);
  const err = !(q > 0) ? "Above zero." : !kg && !Number.isInteger(q) ? "Whole numbers." : q > max + 1e-9 ? `Only ${max} available.` : null;
  const dErr = dVal === "" ? null : !(dv >= 0) ? "Not valid." : dType === "pct" && dv > 100 ? "At most 100%." : null;
  const gross = Math.round((q || 0) * line.price);
  const disc = discAmt(dv ? { type: dType, value: dv } : null, gross);
  const needReason = disc > 0 && !reason;
  return (
    <Modal title={line.name} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!err && !dErr && !needReason) onSave({ qty: round3(q), scale: line.scale && q === line.qty, discount: disc ? { type: dType, value: dv } : undefined }, disc ? reason : null); }}>
        <Field label={kg ? "Weight (KG)" : `Quantity (${line.unit})`} error={err}>
          <div className="flex gap-2">
            {!kg && <Btn label="Decrease quantity" variant="ghost" icon={Minus} onClick={() => setQty(String(Math.max(1, q - 1)))} />}
            <Input mono type="number" step={kg ? "0.001" : "1"} min="0" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Line quantity" />
            {!kg && <Btn label="Increase quantity" variant="ghost" icon={Plus} onClick={() => setQty(String(q + 1))} />}
          </div>
        </Field>
        <div>
          <div className="f-body text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: C.muted }}>Line discount</div>
          <div className="flex gap-2">
            <Select value={dType} onChange={(e) => setDType(e.target.value)} aria-label="Discount type"><option value="pct">%</option><option value="amount">₦</option></Select>
            <Input mono type="number" min="0" step={dType === "pct" ? "0.5" : "1"} value={dVal} onChange={(e) => setDVal(e.target.value)} placeholder="0" aria-label="Line discount" />
          </div>
          {dErr && <div className="f-body text-xs mt-1" style={{ color: C.danger }}>{dErr}</div>}
        </div>
        {disc > 0 && <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Discount reason"><option value="">Pick a reason…</option>{reasons.map((r) => <option key={r}>{r}</option>)}</Select></Field>}
        <div className="flex justify-between f-mono text-sm"><span style={{ color: C.muted }}>{nairaFmt(gross)}{disc ? ` − ${nairaFmt(disc)}` : ""}</span><span className="font-semibold" style={{ color: C.burgundy }}>{nairaFmt(gross - disc)}</span></div>
        <div className="flex gap-2">
          <Btn type="submit" icon={Check} disabled={!!err || !!dErr || needReason}>Update line</Btn>
          <Btn variant="danger" icon={Trash2} onClick={onRemove}>Remove</Btn>
        </div>
      </form>
    </Modal>
  );
}

/* ============================================================ discounts + manager approval */
function DiscountModal({ priced, current, reason: curReason, reasons, cartForPct, myPct, approval, actions, onClose, onApply }) {
  const [type, setType] = useState(current?.type ?? "pct");
  const [value, setValue] = useState(current ? String(current.value) : "");
  const [reason, setReason] = useState(curReason || "");
  const [mgr, setMgr] = useState({ email: "", pin: "" });
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  const v = Number(value || 0);
  const d = v > 0 ? { type, value: v } : null;
  const pct = cartForPct(d);
  const amount = Math.round((priced.gross * pct) / 100);
  const hasLineDisc = priced.lineDiscounts;
  const over = pct > myPct + 1e-9 && (!approval || pct > approval.maxPct + 1e-9);
  const bad = type === "pct" && v > 100;
  const valid = !bad && (pct === 0 || reason) && (!over || (/^\S+@\S+$/.test(mgr.email) && /^\d{4,6}$/.test(mgr.pin)));
  const apply = () => run(async () => {
    setError(null);
    let appr = null;
    if (over) {
      appr = await actions.posAuthorize({ email: mgr.email.trim(), pin: mgr.pin, pct });
      if (!appr || appr.error) { setError(appr?.error || "Not approved."); return; }
    }
    onApply(d, reason, appr);
  });
  return (
    <Modal title="Ticket discount" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) apply(); }}>
        <div className="grid grid-cols-2 gap-2">
          {[["pct", "Percent %"], ["amount", "Amount ₦"]].map(([k, l]) => (
            <button type="button" key={k} onClick={() => setType(k)} className="rounded-lg py-2 f-body text-xs font-semibold border"
              style={{ background: type === k ? C.charcoal : "#fff", color: type === k ? "#fff" : C.ink, borderColor: type === k ? C.charcoal : C.input }}>{l}</button>
          ))}
        </div>
        <Field label={type === "pct" ? "Discount (%)" : "Discount (₦)"} error={bad ? "At most 100%." : null}>
          <Input mono type="number" min="0" step={type === "pct" ? "0.5" : "50"} value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label="Ticket discount" />
        </Field>
        {(pct > 0 || hasLineDisc) && (
          <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Discount reason"><option value="">Pick a reason…</option>{reasons.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        )}
        <div className="rounded-xl p-3 f-body text-sm" style={{ background: C.cream }}>
          <Row label="Ticket before discounts" value={nairaFmt(priced.gross)} />
          <Row label={`Total discount (${pct.toFixed(1)}%)`} value={`−${nairaFmt(amount)}`} tone={C.gold} />
          <Row label="New total" value={nairaFmt(priced.gross - amount)} />
        </div>
        {over && (
          <div className="rounded-xl p-3 space-y-3" style={{ background: "#F6EEDD" }}>
            <p className="f-body text-xs flex items-start gap-1.5" style={{ color: C.ink }}><ShieldCheck size={14} style={{ color: C.gold, flexShrink: 0 }} />
              {myPct ? `Above your ${myPct}% limit` : "Discounts need a manager"} — a manager enters their email and till PIN.</p>
            <div className="grid grid-cols-2 gap-2">
              <Input type="email" value={mgr.email} onChange={(e) => setMgr({ ...mgr, email: e.target.value })} placeholder="Manager's email" aria-label="Manager email" autoComplete="off" />
              <Input mono type="password" inputMode="numeric" maxLength={6} value={mgr.pin} onChange={(e) => setMgr({ ...mgr, pin: e.target.value.replace(/\D/g, "") })} placeholder="PIN" aria-label="Manager PIN" autoComplete="off" />
            </div>
          </div>
        )}
        {error && <p className="f-body text-xs" style={{ color: C.danger }}>{error}</p>}
        <div className="flex gap-2">
          <Btn type="submit" icon={over ? ShieldCheck : Check} busy={busy} disabled={!valid}>{over ? "Approve & apply" : "Apply"}</Btn>
          {current && <Btn variant="ghost" onClick={() => onApply(null, hasLineDisc ? reason : "", null)}>Remove discount</Btn>}
        </div>
      </form>
    </Modal>
  );
}

function ApprovalModal({ pct, reasons, reason: cur, actions, onClose, onApproved }) {
  const [mgr, setMgr] = useState({ email: "", pin: "" });
  const [reason, setReason] = useState(cur || "");
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  const valid = reason && /^\S+@\S+$/.test(mgr.email) && /^\d{4,6}$/.test(mgr.pin);
  return (
    <Modal title="Manager approval" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) run(async () => {
        const a = await actions.posAuthorize({ email: mgr.email.trim(), pin: mgr.pin, pct });
        if (!a || a.error) setError(a?.error || "Not approved."); else onApproved(a, reason);
      }); }}>
        <p className="f-body text-sm" style={{ color: C.ink }}>This ticket has {pct.toFixed(1)}% off. A manager approves it with their till PIN.</p>
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Discount reason"><option value="">Pick a reason…</option>{reasons.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Input type="email" value={mgr.email} onChange={(e) => setMgr({ ...mgr, email: e.target.value })} placeholder="Manager's email" aria-label="Manager email" autoComplete="off" />
          <Input mono type="password" inputMode="numeric" maxLength={6} value={mgr.pin} onChange={(e) => setMgr({ ...mgr, pin: e.target.value.replace(/\D/g, "") })} placeholder="PIN" aria-label="Manager PIN" autoComplete="off" />
        </div>
        {error && <p className="f-body text-xs" style={{ color: C.danger }}>{error}</p>}
        <Btn type="submit" icon={ShieldCheck} full busy={busy} disabled={!valid}>Approve</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ tender */
const METHOD_ICON = { Cash: Banknote, Transfer: Landmark, "POS Card": CreditCard };
function quickNotes(due) {
  const out = new Set([due]);
  for (const step of [500, 1000, 5000, 10000]) { const up = Math.ceil(due / step) * step; if (up > due) out.add(up); }
  for (const n of QUICK_CASH) if (n > due) out.add(n);
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

function TenderModal({ total, priced, customer, profile, user, submit, onClose, onDone }) {
  const [tenders, setTenders] = useState([]);
  const [method, setMethod] = useState("Cash");
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [done, setDone] = useState(null);
  const [busy, run] = useBusy();
  const paid = tenders.reduce((s, t) => s + t.amount, 0);
  const remaining = total - paid;
  const a = amount === "" ? (method === "Cash" ? NaN : remaining) : Number(amount);
  const isCash = method === "Cash";
  const applied = isCash ? Math.min(a, remaining) : a;
  const change = isCash && a > remaining ? a - remaining : 0;
  const err = amount === "" && isCash ? null : !(Number.isInteger(a) && a > 0) ? "Whole naira above zero." : !isCash && a > remaining ? `Only ${nairaFmt(remaining)} left to pay.` : null;
  const finishes = !err && (applied >= remaining);

  const [printState, setPrintState] = useState(null);
  const makeReceipt = (dn) => ({ code: dn.code, at: dn.at, cashier: user.name, customer: customer?.name ?? "Walk-in customer",
    lines: priced.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price, discount: l.disc, total: l.total, vat: l.tax > 0 })),
    gross: priced.gross, discount: priced.discount, tax: priced.tax, total: dn.total, tenders: dn.tenders, change: dn.change, later: dn.later });
  const doPrint = async (dn) => {
    setPrintState("Printing…");
    const r = await printReceipt(profile, makeReceipt(dn));
    setPrintState(r.ok ? "Receipt printed" : `Printer: ${r.error}`);
  };
  useEffect(() => {
    if (!done) return;
    customerDisplay.send({ type: "done", profile, total: done.total, change: done.change });
    if (loadDevices().autoPrint && !done.duplicate) doPrint(done);
  }, [done]);
  useEffect(() => {
    if (!done) customerDisplay.send({ type: "pay", profile, due: remaining, paid, total, customer: customer?.name,
      lines: priced.lines.map((l) => ({ name: l.name, qty: qtyFmt(l.qty, l.unit), price: l.price, discount: l.disc, total: l.total })),
      gross: priced.gross, discount: priced.discount, tax: priced.tax });
  }, [remaining, done]);
  const complete = (list) => run(async () => {
    const r = await submit({ payments: list.map((t) => ({ method: t.method, amount: t.amount, ...(t.tendered ? { tendered: t.tendered } : {}), ...(t.ref ? { ref: t.ref } : {}) })) });
    if (r) setDone({ ...r, tenders: list, at: new Date() });
  });
  const add = () => {
    if (err || !(applied > 0)) return;
    const t = { method, amount: applied, ...(isCash ? { tendered: a } : {}), ...(!isCash && ref.trim() ? { ref: ref.trim() } : {}) };
    const list = [...tenders, t];
    setAmount(""); setRef("");
    if (applied >= remaining) complete(list); else { setTenders(list); }
  };
  const payLater = () => run(async () => {
    const r = await submit({ payLater: true });
    if (r) setDone({ ...r, tenders: [], at: new Date(), later: true });
  });
  const key = (k) => setAmount((s) => (k === "back" ? s.slice(0, -1) : k === "clear" ? "" : (s + k).replace(/^0+(?=\d)/, "").slice(0, 10)));

  useEffect(() => {
    const onKey = (e) => { if (done && e.key === "Enter") { e.preventDefault(); onDone(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done]);

  if (done) {
    return (
      <Modal title={`Sale ${done.code}`} onClose={() => { onDone(); onClose(); }}>
        <div className="text-center mb-5">
          <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ background: "#E7F0E9" }}><Check size={22} style={{ color: C.ok }} /></div>
          {done.change > 0 ? (<>
            <div className="f-body text-xs uppercase tracking-wide" style={{ color: C.muted }}>Change due</div>
            <div className="f-mono text-4xl font-bold" style={{ color: C.ok }} data-change>{nairaFmt(done.change)}</div>
          </>) : <div className="f-mono text-2xl font-semibold" style={{ color: C.ink }}>{done.later ? "Saved — payment pending" : `${nairaFmt(done.total)} paid`}</div>}
          {done.duplicate && <p className="f-body text-xs mt-2" style={{ color: C.gold }}>This ticket had already gone through — nothing was charged twice.</p>}
          {printState && <p className="f-body text-xs mt-2" data-print-state style={{ color: /^Printer:/.test(printState) ? C.danger : C.muted }}>{printState}</p>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="ghost" icon={Printer} onClick={() => doPrint(done)}>{printState === "Receipt printed" ? "Print again" : "Print receipt"}</Btn>
          <Btn icon={Plus} onClick={() => { onDone(); onClose(); }}>New sale (Enter)</Btn>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Take payment" onClose={busy ? () => {} : onClose} wide>
      <div className="grid sm:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={{ background: C.charcoal }}>
            <div className="f-body text-[11px] uppercase tracking-widest" style={{ color: C.goldLight }}>{paid ? "Left to pay" : "Amount due"}</div>
            <div className="f-mono text-3xl font-bold" style={{ color: "#fff" }} data-due>{nairaFmt(remaining)}</div>
            {paid > 0 && <div className="f-body text-xs mt-1" style={{ color: C.mutedLight }}>of {nairaFmt(total)}</div>}
          </div>
          {tenders.map((t, i) => (
            <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 f-body text-sm" style={{ background: C.cream }}>
              <span style={{ color: C.ink }}>{t.method}{t.ref ? ` · ${t.ref}` : ""}</span>
              <span className="flex items-center gap-2"><span className="f-mono">{nairaFmt(t.amount)}</span>
                <button aria-label="Remove payment" onClick={() => setTenders((ts) => ts.filter((_, j) => j !== i))}><X size={13} style={{ color: C.muted }} /></button></span>
            </div>
          ))}
          <div className="grid grid-cols-3 gap-2">
            {["Cash", "Transfer", "POS Card"].map((m) => {
              const Icon = METHOD_ICON[m];
              return (
                <button key={m} onClick={() => { setMethod(m); setAmount(""); }} aria-pressed={method === m}
                  className="rounded-xl py-2.5 f-body text-xs font-semibold border flex flex-col items-center gap-1 active:scale-95"
                  style={{ background: method === m ? C.burgundy : "#fff", color: method === m ? "#fff" : C.ink, borderColor: method === m ? C.burgundy : C.input }}>
                  <Icon size={16} />{m === "POS Card" ? "Card" : m}
                </button>
              );
            })}
          </div>
          {isCash && (
            <div className="flex flex-wrap gap-1.5">
              {quickNotes(remaining).map((n) => (
                <button key={n} onClick={() => setAmount(String(n))} className="f-mono text-xs font-semibold px-2.5 py-1.5 rounded-lg border"
                  style={{ borderColor: C.input, background: Number(amount) === n ? C.cream2 : "#fff", color: C.ink }}>{n === remaining ? "Exact" : nairaFmt(n)}</button>
              ))}
            </div>
          )}
          {!isCash && <Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} aria-label="Payment reference"
            placeholder={method === "Transfer" ? "Sender name / bank (for the bank check)" : "Terminal slip number"} />}
          {customer && !tenders.length && <Btn small variant="ghost" icon={Clock} busy={busy} onClick={payLater}>Pay later (on {customer.name.split(" ")[0]}'s account)</Btn>}
        </div>
        <div className="space-y-3">
          <Field label={isCash ? "Cash received (₦)" : `${method} amount (₦)`} error={err}>
            <Input mono type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Tender amount"
              placeholder={isCash ? "" : String(remaining)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} autoFocus />
          </Field>
          {change > 0 && !err && <div className="rounded-lg px-3 py-2 flex justify-between f-body text-sm" style={{ background: "#E7F0E9" }}><span>Change</span><span className="f-mono font-bold" style={{ color: C.ok }}>{nairaFmt(change)}</span></div>}
          <div className="grid grid-cols-3 gap-1.5">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"].map((k) => (
              <button key={k} onClick={() => key(k)} aria-label={k === "back" ? "Backspace" : k}
                className="f-mono text-lg font-semibold py-2.5 rounded-lg border active:scale-95 flex items-center justify-center" style={{ borderColor: C.input, background: "#fff", color: C.ink }}>
                {k === "back" ? <Delete size={18} /> : k}
              </button>
            ))}
          </div>
          <Btn variant={finishes ? "gold" : "primary"} icon={finishes ? Check : Plus} full busy={busy} disabled={!!err || !(applied > 0)} onClick={add}>
            {finishes ? `Complete sale${change ? ` · change ${nairaFmt(change)}` : ""}` : Number.isFinite(applied) ? `Add ${method} ${nairaFmt(applied)}` : "Enter cash received"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================ hold / recall / clear */
function HoldModal({ onClose, onHold }) {
  const [label, setLabel] = useState("");
  const [busy, run] = useBusy();
  return (
    <Modal title="Hold ticket" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(() => onHold(label.trim())); }}>
        <p className="f-body text-sm" style={{ color: C.muted }}>Park this ticket to serve someone else. Any till can recall it. Stock isn't reserved.</p>
        <Field label="Name it (optional)"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Mrs Okafor — fetching cash" autoFocus /></Field>
        <Btn type="submit" icon={PauseCircle} full busy={busy}>Hold ticket</Btn>
      </form>
    </Modal>
  );
}
function HeldModal({ held, onClose, onRecall }) {
  return (
    <Modal title="Held tickets" onClose={onClose}>
      {!held.length && <Empty>No tickets on hold.</Empty>}
      <div className="space-y-2">
        {held.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5" style={{ background: C.cream }}>
            <div className="min-w-0">
              <div className="f-body text-sm font-semibold truncate" style={{ color: C.ink }}>{h.label}</div>
              <div className="f-body text-xs" style={{ color: C.muted }}>{h.lines} line{h.lines === 1 ? "" : "s"} · {nairaFmt(h.total)}{h.customer ? ` · ${h.customer}` : ""} · {h.who}, {h.at}</div>
            </div>
            <Btn small icon={PlayCircle} onClick={() => onRecall(h)}>Recall</Btn>
          </div>
        ))}
      </div>
    </Modal>
  );
}
function ClearModal({ lines, total, onClose, onClear }) {
  const [reason, setReason] = useState("");
  const [busy, run] = useBusy();
  return (
    <Modal title="Clear ticket" onClose={onClose}>
      <div className="space-y-4">
        <p className="f-body text-sm" style={{ color: C.ink }}>Remove all {lines} line{lines === 1 ? "" : "s"} ({nairaFmt(total)})? Cleared tickets show on the till report.</p>
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Clear reason"><option value="">Pick a reason…</option>{VOID_REASONS.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <Btn variant="danger" icon={Ban} full busy={busy} disabled={!reason} onClick={() => run(() => onClear(reason))}>Clear ticket</Btn>
      </div>
    </Modal>
  );
}

/* ============================================================ receipt (80 mm) */
export async function printReceipt(profile, r, { copy = false } = {}) {
  // Cash sales open the drawer (ESC/POS mode); reprints never do.
  return printBlocks(receiptBlocks(profile, r, { copy }), { title: r.code, cash: !copy && (r.tenders || []).some((t) => t.method === "Cash"), copies: copy ? 1 : undefined });
}

/* ============================================================ X / Z report */
export function TillReportModal({ code, actions, onClose }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { actions.tillReport(code).then(setR).catch((e) => setError(e.message)); }, [code]);
  const [printMsg, setPrintMsg] = useState(null);
  const print = async () => { setPrintMsg("Printing…"); const p = await printBlocks(reportBlocks(r), { title: `${r.type} report ${r.code}`, copies: 1 }); setPrintMsg(p.ok ? "Sent to the printer" : p.error); };
  return (
    <Modal title={r ? `${r.type} report — ${r.code}` : "Till report"} onClose={onClose}>
      {error && <p className="f-body text-sm" style={{ color: C.danger }}>{error}</p>}
      {!r && !error && <Empty>Loading…</Empty>}
      {r && (
        <div className="space-y-3 f-body text-sm">
          <p className="text-xs" style={{ color: C.muted }}>{r.type === "X" ? "Mid-shift read — the till stays open." : "End of shift."} {r.cashier} · opened {r.openedAt}{r.closedAt ? ` · closed ${r.closedAt}` : ""}</p>
          <div className="rounded-xl p-3 space-y-1" style={{ background: C.cream }}>
            <Row label={`Sales (${r.sales.count})`} value={nairaFmt(r.sales.gross)} />
            <Row label="Discounts" value={`−${nairaFmt(r.sales.discounts)}`} tone={C.gold} />
            <Row label="Net sales" value={nairaFmt(r.sales.net)} />
            <Row label="VAT included" value={nairaFmt(r.sales.tax)} muted />
          </div>
          <div className="rounded-xl p-3 space-y-1" style={{ background: C.cream }}>
            {r.tenders.map((t) => <Row key={t.method} label={`${t.method} (${t.orders})`} value={nairaFmt(t.amount)} />)}
            {r.refunds.map((t) => <Row key={t.method} label={`Refunds — ${t.method}`} value={`−${nairaFmt(t.amount)}`} tone={C.danger} />)}
            <Row label="Cleared tickets" value={`${r.voided.tickets} · ${nairaFmt(r.voided.value)}`} muted />
          </div>
          {r.cash && (
            <div className="rounded-xl p-3 space-y-1" style={{ background: C.cream }}>
              <Row label="Float" value={nairaFmt(r.cash.float)} />
              <Row label="Cash taken" value={nairaFmt(r.cash.cashIn)} />
              <Row label="Cash refunds" value={`−${nairaFmt(r.cash.cashOut)}`} />
              <Row label="Expected in drawer" value={nairaFmt(r.cash.expected)} />
              {r.cash.counted != null && <Row label="Counted · variance" value={`${nairaFmt(r.cash.counted)} · ${nairaFmt(r.cash.variance)}`} tone={r.cash.variance ? C.danger : C.ok} />}
            </div>
          )}
          {r.discountsByReason.length > 0 && <p className="text-xs" style={{ color: C.muted }}>Discounts: {r.discountsByReason.map((d) => `${d.reason} ${nairaFmt(d.amount)} (${d.n})`).join(" · ")}</p>}
          <Btn icon={Printer} full onClick={print}>Print {r.type} report</Btn>
          {printMsg && <p className="text-xs text-center" style={{ color: C.muted }}>{printMsg}</p>}
        </div>
      )}
    </Modal>
  );
}

/** A product's photo on its POS tile; hidden if the file is missing, so the tile still works. */
function ProductPhoto({ src, out }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <div className="-mx-3 -mt-3 mb-2 h-24 relative shrink-0 rounded-t-xl overflow-hidden" style={{ width: "calc(100% + 1.5rem)", background: C.cream2 }}>
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setOk(false)} className="w-full h-full object-cover"
        style={out ? { filter: "grayscale(0.6)", opacity: 0.75 } : undefined} />
      {out && <span className="absolute left-2 top-2 f-body text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: C.danger, color: "#fff" }}>Out of stock</span>}
    </div>
  );
}
