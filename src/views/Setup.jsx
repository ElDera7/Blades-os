import React, { useEffect, useState } from "react";
import { Plus, Pencil, Check, Archive, RotateCcw, Snowflake, Beef, Package, Lock, ShoppingCart, ShieldCheck, Receipt, Download } from "lucide-react";
import { C, nairaFmt, qtyFmt } from "../lib/theme.js";
import { PROCESSING_SKUS } from "../shared/permissions.js";
import { SectionHeader, Btn, StatusPill, Modal, Field, Input, Select, Card, Table, Empty, useBusy } from "../components/ui.jsx";
import { exportScaleCsv } from "../lib/scale.jsx";

const TABS = [["products", "Products", Package], ["locations", "Storage Locations", Snowflake], ["ranches", "Ranches", Beef]];

export function SetupView({ data, actions, permit }) {
  const canProducts = permit("products.edit");
  const showCost = permit("costs.view");
  const [tab, setTab] = useState("products");
  const tabs = [...TABS, ["receipt", "Receipt & Till", Receipt], ...(permit("controls.manage") ? [["controls", "Controls", ShieldCheck]] : [])];
  useEffect(() => { try { localStorage.setItem("bladeos.setupVisited", "1"); } catch {} }, []);
  const [showRetired, setShowRetired] = useState(false);
  const [modal, setModal] = useState(null); // { kind, item? }
  const setup = data.setup;
  const list = (setup[tab] || []).filter((x) => showRetired || x.active);
  const retiredCount = (setup[tab] || []).filter((x) => !x.active).length;
  const categories = [...new Set(setup.products.map((p) => p.category))].sort();

  const toggle = (item) => {
    const active = !item.active;
    if (tab === "products") return actions.updateProduct(item.sku, { active }, active ? `${item.name} restored` : `${item.name} retired`);
    if (tab === "locations") return actions.updateLocation(item.id, { active }, active ? `${item.name} restored` : `${item.name} retired`);
    return actions.updateRanch(item.id, { active }, active ? `${item.name} restored` : `${item.name} retired`);
  };

  return (
    <div>
      {modal?.kind === "product" && <ProductForm item={modal.item} categories={categories} onClose={() => setModal(null)} actions={actions} />}
      {modal?.kind === "place" && <PlaceForm tab={tab} item={modal.item} onClose={() => setModal(null)} actions={actions} />}

      <SectionHeader eyebrow="System" title="Business Setup" action={
        <div className="flex gap-2">
          {tab === "products" && (
            <Btn icon={Download} small variant="ghost" onClick={() => exportScaleCsv(list)}>Export Scale PLUs (TM-A)</Btn>
          )}
          {tab !== "controls" && tab !== "receipt" && (tab !== "products" || canProducts) && (
            <Btn icon={Plus} small onClick={() => setModal({ kind: tab === "products" ? "product" : "place" })}>
              Add {tab === "products" ? "Product" : tab === "locations" ? "Location" : "Ranch"}
            </Btn>
          )}
        </div>
      } />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {tabs.map(([k, l, Icon]) => (
            <button key={k} onClick={() => setTab(k)} className="f-body text-xs font-semibold px-3.5 py-2 rounded-lg shrink-0 inline-flex items-center gap-1.5 transition-all active:scale-95"
              style={{ background: tab === k ? C.charcoal : "#fff", color: tab === k ? "#fff" : C.muted, border: `1px solid ${C.border}` }}>
              <Icon size={13} /> {l}
            </button>
          ))}
        </div>
        {retiredCount > 0 && (
          <label className="flex items-center gap-2 f-body text-xs" style={{ color: C.muted }}>
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired ({retiredCount})
          </label>
        )}
      </div>

      {tab === "products" && (
        <Card pad={false}>
          <Table head={["Product", "Category", "Unit", "Price", ...(showCost ? ["Cost", "Margin"] : []), "Min", "In Stock", ""]} minWidth={showCost ? 900 : 720} empty={list.length === 0 ? "No products." : null}>
            {list.map((p) => {
              const margin = p.price > 0 ? Math.round(((p.price - p.costPrice) / p.price) * 100) : 0;
              const locked = PROCESSING_SKUS.includes(p.sku);
              return (
                <tr key={p.sku} className="border-t" style={{ borderColor: C.rowLine, opacity: p.active ? 1 : 0.55 }}>
                  <td className="px-5 py-3">
                    <div className="f-body text-sm font-medium flex items-center gap-1.5" style={{ color: C.ink }}>
                      {p.image && <img src={p.image} alt="" className="w-7 h-7 rounded object-cover shrink-0" style={{ background: C.cream2 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />}
                      {p.name}{locked && <Lock size={11} style={{ color: C.gold }} title="Receives processing output" />}
                    </div>
                    <div className="f-mono text-[11px]" style={{ color: C.muted }}>{p.sku}</div>
                  </td>
                  <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{p.category}</td>
                  <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{p.unit}</td>
                  <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{nairaFmt(p.price)}</td>
                  {showCost && <td className="px-5 py-3 f-mono text-sm" style={{ color: C.muted }}>{nairaFmt(p.costPrice)}</td>}
                  {showCost && <td className="px-5 py-3 f-mono text-sm font-semibold" style={{ color: margin > 0 ? C.ok : C.danger }}>{margin}%</td>}
                  <td className="px-5 py-3 f-mono text-xs" style={{ color: C.muted }}>{p.min}</td>
                  <td className="px-5 py-3 f-mono text-sm" style={{ color: p.trackStock === false ? C.muted : C.ink }}>{p.trackStock === false ? "Not counted" : qtyFmt(p.qty, p.unit)}</td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1 justify-end">
                      {!p.active && <StatusPill status="Inactive" />}
                      {canProducts && p.active && <Btn label="Edit product" small variant="ghost" icon={Pencil} onClick={() => setModal({ kind: "product", item: p })} />}
                      {canProducts && !locked && <Btn label={p.active ? "Retire product" : "Restore product"} small variant="ghost" icon={p.active ? Archive : RotateCcw} onClick={() => toggle(p)} />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
          <p className="f-body text-xs px-5 py-3 border-t flex items-center gap-1.5" style={{ color: C.muted, borderColor: C.line }}>
            <Lock size={11} style={{ color: C.gold }} /> Processing batches stock these products, so they can be renamed or repriced but not retired.
            A product can be retired once its stock is zero.{!canProducts && " Products and prices are managed by the Owner, Managing Director or Super Admin."}
          </p>
        </Card>
      )}

      {tab === "controls" && <ControlsPanel limits={data.limits} actions={actions} />}
      {tab === "receipt" && <ReceiptPanel profile={data.setup?.profile || {}} actions={actions} />}

      {(tab === "locations" || tab === "ranches") && (
        <Card pad={false}>
          <Table head={["Name", tab === "locations" ? "Products held" : "Animals on ranch", ...(tab === "locations" ? ["Safe range", "POS sells first"] : []), "Status", ""]} minWidth={520} empty={list.length === 0 ? "Nothing here yet." : null}>
            {list.map((x) => {
              const count = tab === "locations" ? x.products : x.animals;
              return (
                <tr key={x.id} className="border-t" style={{ borderColor: C.rowLine, opacity: x.active ? 1 : 0.55 }}>
                  <td className="px-5 py-3 f-body text-sm font-medium" style={{ color: C.ink }}>{x.name}</td>
                  <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{count}</td>
                  {tab === "locations" && <td className="px-5 py-3 f-mono text-xs whitespace-nowrap" style={{ color: x.tempMin == null && x.tempMax == null ? C.danger : C.ink }}>
                    {x.tempMin == null && x.tempMax == null ? "not set" : `${x.tempMin ?? "—"}°C to ${x.tempMax ?? "—"}°C`}</td>}
                  {tab === "locations" && (
                    <td className="px-5 py-3">
                      <label className="inline-flex items-center gap-1.5 f-body text-xs cursor-pointer" style={{ color: x.sellsFirst ? C.burgundy : C.muted }}>
                        <input type="checkbox" checked={x.sellsFirst} disabled={!x.active}
                          onChange={(e) => actions.updateLocation(x.id, { sellsFirst: e.target.checked }, e.target.checked ? `POS will sell from ${x.name} first` : `${x.name} is no longer POS-first`)} />
                        {x.sellsFirst && <ShoppingCart size={12} />}
                      </label>
                    </td>
                  )}
                  <td className="px-5 py-3"><StatusPill status={x.active ? "Active" : "Inactive"} /></td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1 justify-end">
                      {x.active && <Btn label="Edit" small variant="ghost" icon={Pencil} onClick={() => setModal({ kind: "place", item: x })} />}
                      <Btn label={x.active ? "Retire" : "Restore"} small variant="ghost" icon={x.active ? Archive : RotateCcw} onClick={() => toggle(x)} disabled={x.active && count > 0} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
          <p className="f-body text-xs px-5 py-3 border-t" style={{ color: C.muted, borderColor: C.line }}>
            {tab === "locations"
              ? "POS sales take stock from \"POS sells first\" locations (your shop counter) before anywhere else. Retiring a location hides it from transfers and receiving — move its stock out first."
              : "Retiring a ranch hides it when adding animals. Move or process its animals first."} History keeps the original name.
          </p>
        </Card>
      )}
    </div>
  );
}

function ProductForm({ item, categories, onClose, actions }) {
  const isNew = !item;
  const [f, setF] = useState({
    name: item?.name ?? "", sku: item?.sku ?? "", category: item?.category ?? "", unit: item?.unit ?? "KG",
    price: String(item?.price ?? ""), costPrice: String(item?.costPrice ?? ""), min: String(item?.min ?? "0"), shelfLife: String(item?.shelfLife ?? 5),
    barcode: item?.barcode ?? "", plu: String(item?.plu ?? ""), vatRate: String(item?.vatRate ?? 0),
    image: item?.image ?? "", trackStock: item?.trackStock ?? true,
  });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const autoSku = f.name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const int = (v) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0;
  const valid = f.name.trim().length >= 2 && f.category.trim().length >= 2 && int(f.price) && int(f.costPrice) && f.min !== "" && Number(f.min) >= 0
    && (!f.sku || /^[A-Za-z0-9][A-Za-z0-9-]{1,23}$/.test(f.sku)) && int(f.shelfLife) && Number(f.shelfLife) >= 1 && Number(f.shelfLife) <= 730
    && (!f.barcode || /^\d{8,14}$/.test(f.barcode.trim())) && (f.plu === "" || (int(f.plu) && Number(f.plu) >= 1 && Number(f.plu) <= 99999))
    && f.vatRate !== "" && Number(f.vatRate) >= 0 && Number(f.vatRate) <= 100
    && (!f.image.trim() || /^(\/products\/[\w.-]+|https:\/\/\S+)$/.test(f.image.trim()));
  const margin = Number(f.price) > 0 ? Math.round(((Number(f.price) - Number(f.costPrice)) / Number(f.price)) * 100) : 0;

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { name: f.name.trim(), category: f.category.trim(), unit: f.unit, price: Number(f.price), costPrice: Number(f.costPrice), min: Number(f.min), shelfLife: Number(f.shelfLife),
        barcode: f.barcode.trim(), plu: f.plu === "" ? "" : Number(f.plu), vatRate: Number(f.vatRate), image: f.image.trim(), trackStock: f.trackStock };
      const r = isNew
        ? await actions.addProduct({ ...body, ...(f.sku ? { sku: f.sku.toUpperCase() } : {}) })
        : await actions.updateProduct(item.sku, Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== (k === "costPrice" ? item.costPrice : item[k]))), `${body.name} saved`);
      if (r) onClose();
    });
  };

  return (
    <Modal title={isNew ? "Add Product" : `Edit ${item.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><Field label="Name"><Input value={f.name} onChange={set("name")} required maxLength={60} autoFocus /></Field></div>
          <Field label="SKU" hint={isNew ? (f.sku ? "Letters, numbers, dashes" : `Auto: ${autoSku || "—"}`) : "Can't be changed"}>
            <Input mono value={isNew ? f.sku : item.sku} onChange={set("sku")} disabled={!isNew} maxLength={24} placeholder={autoSku} />
          </Field>
          <Field label="Category">
            <Input list="cats" value={f.category} onChange={set("category")} required maxLength={30} />
            <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Sold by" hint={!isNew && item.used ? "Locked — stock has moved" : null}>
            <Select value={f.unit} onChange={set("unit")} disabled={!isNew && item.used}>
              <option value="KG">Weight (KG)</option><option value="Unit">Unit (each)</option><option value="Pack">Pack</option>
            </Select>
          </Field>
          <Field label={`Minimum stock (${f.unit})`}><Input mono type="number" min="0" value={f.min} onChange={set("min")} /></Field>
          <Field label="Shelf life (days)" hint="Default use-by for new stock"><Input mono type="number" min="1" max="730" step="1" value={f.shelfLife} onChange={set("shelfLife")} /></Field>
          <Field label={`Selling price (₦/${f.unit})`}><Input mono type="number" min="0" step="1" value={f.price} onChange={set("price")} required /></Field>
          <Field label={`Cost price (₦/${f.unit})`}><Input mono type="number" min="0" step="1" value={f.costPrice} onChange={set("costPrice")} required /></Field>
          <Field label="Barcode (EAN / UPC)" hint="Scan it into this box" error={f.barcode && !/^\d{8,14}$/.test(f.barcode.trim()) ? "8–14 digits" : null}>
            <Input mono value={f.barcode} onChange={set("barcode")} maxLength={14} inputMode="numeric" placeholder="optional" aria-label="Barcode"
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Tab") { if (e.key === "Enter") e.preventDefault(); } }} />
          </Field>
          <Field label="PLU" hint="Number on scale labels and the till keypad"><Input mono type="number" min="1" max="99999" step="1" value={f.plu} onChange={set("plu")} placeholder={isNew ? "auto" : ""} /></Field>
          <Field label="VAT (%)" hint="0 for exempt basic food; price includes VAT"><Input mono type="number" min="0" max="100" step="0.5" value={f.vatRate} onChange={set("vatRate")} /></Field>
          <div className="col-span-2"><Field label="Photo" hint="/products/<file> (in the app) or an https:// link — shown on the POS tile"
            error={f.image.trim() && !/^(\/products\/[\w.-]+|https:\/\/\S+)$/.test(f.image.trim()) ? "Use /products/<file> or https://…" : null}>
            <div className="flex items-center gap-3">
              {f.image.trim() && <img src={f.image.trim()} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" style={{ background: C.cream2 }} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />}
              <Input value={f.image} onChange={set("image")} maxLength={300} placeholder="/products/beef.png" />
            </div>
          </Field></div>
          <label className="col-span-2 flex items-start gap-2.5 f-body text-sm cursor-pointer" style={{ color: C.ink }}>
            <input type="checkbox" checked={f.trackStock} onChange={(e) => setF((p) => ({ ...p, trackStock: e.target.checked }))} className="mt-0.5 w-4 h-4" style={{ accentColor: C.burgundy }} />
            <span>Count stock for this item<span className="block text-xs" style={{ color: C.muted }}>Untick for services and items you don't count (e.g. sealing) — they can always be sold.</span></span>
          </label>
        </div>
        <div className="f-body text-xs" style={{ color: C.muted }}>
          Gross margin: <span className="f-mono font-semibold" style={{ color: margin > 0 ? C.ok : C.danger }}>{margin}%</span>
          {!isNew && " · Price changes apply to new sales only."}
        </div>
        <Btn type="submit" icon={Check} full busy={busy} disabled={!valid}>{isNew ? "Add Product" : "Save Changes"}</Btn>
      </form>
    </Modal>
  );
}

function PlaceForm({ tab, item, onClose, actions }) {
  const [name, setName] = useState(item?.name ?? "");
  const [tMin, setTMin] = useState(item?.tempMin != null ? String(item.tempMin) : "");
  const [tMax, setTMax] = useState(item?.tempMax != null ? String(item.tempMax) : "");
  const [busy, run] = useBusy();
  const isLoc = tab === "locations";
  const label = isLoc ? "Storage Location" : "Ranch";
  const num = (v) => (v === "" ? null : Number(v));
  const rangeBad = isLoc && tMin !== "" && tMax !== "" && Number(tMin) > Number(tMax);
  const nameChanged = name.trim() !== (item?.name ?? "");
  const tempsChanged = isLoc && (num(tMin) !== (item?.tempMin ?? null) || num(tMax) !== (item?.tempMax ?? null));
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      let r;
      const temps = { tempMin: num(tMin), tempMax: num(tMax) };
      if (isLoc) {
        if (item) r = await actions.updateLocation(item.id, { ...(nameChanged ? { name: name.trim() } : {}), ...(tempsChanged ? temps : {}) }, `${name.trim()} saved`);
        else { r = await actions.addLocation({ name: name.trim() }); if (r && (temps.tempMin != null || temps.tempMax != null)) await actions.updateLocation(r.id, temps, `${name.trim()} safe range set`); }
      } else r = item ? await actions.updateRanch(item.id, { name: name.trim() }, "Ranch renamed") : await actions.addRanch({ name: name.trim() });
      if (r) onClose();
    });
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : `Add ${label}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint={tab === "ranches" ? "e.g. Ranch C — Bwari" : "e.g. Cold Room C"}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={50} autoFocus />
        </Field>
        {isLoc && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Safe minimum (°C)" hint="Freezers −30"><Input mono type="number" step="0.5" value={tMin} onChange={(e) => setTMin(e.target.value)} /></Field>
            <Field label="Safe maximum (°C)" hint="Chillers 4 · Freezers −18" error={rangeBad ? "Below the minimum" : null}><Input mono type="number" step="0.5" value={tMax} onChange={(e) => setTMax(e.target.value)} /></Field>
          </div>
        )}
        <Btn type="submit" icon={Check} full busy={busy} disabled={name.trim().length < 2 || rangeBad || (item && !nameChanged && !tempsChanged)}>{item ? "Save" : `Add ${label}`}</Btn>
      </form>
    </Modal>
  );
}

function ControlsPanel({ limits = {}, actions }) {
  const [f, setF] = useState({ adjustment: String(limits.adjustment ?? 50000), refund: String(limits.refund ?? 50000), tillVariance: String(limits.tillVariance ?? 5000),
    purchase: String(limits.purchase ?? 500000), paymentVariance: String(limits.paymentVariance ?? 5000) });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const valid = Object.values(f).every((v) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0);
  const rows = [
    ["adjustment", "Stock write-offs & corrections", "value at cost"],
    ["refund", "Refunds", "amount refunded"],
    ["tillVariance", "Till cash-up variance", "over or short"],
    ["purchase", "Purchase orders", "order total"],
    ["paymentVariance", "Bank / card reconciliation variance", "statement vs BladeOS"],
  ];
  return (
    <Card>
      <h3 className="f-display text-base mb-1" style={{ color: C.ink }}>Approval limits</h3>
      <p className="f-body text-xs mb-4" style={{ color: C.muted }}>The most an Operations Manager can approve or sign off. Anything larger goes to the Owner or Managing Director, who have no limit.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(() => actions.saveLimits(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)])))); }} className="space-y-3 max-w-lg">
        {rows.map(([k, l, h]) => (
          <div key={k} className="grid grid-cols-2 gap-4 items-end">
            <div><div className="f-body text-sm" style={{ color: C.ink }}>{l}</div><div className="f-body text-[11px]" style={{ color: C.muted }}>{h}</div></div>
            <Field label="Limit (₦)"><Input mono type="number" min="0" step="1000" value={f[k]} onChange={set(k)} /></Field>
          </div>
        ))}
        <Btn type="submit" icon={Check} busy={busy} disabled={!valid}>Save Limits</Btn>
      </form>
    </Card>
  );
}

/** Receipt header (name, address, TIN) and how scale labels are read. */
function ReceiptPanel({ profile, actions }) {
  const [f, setF] = useState({ name: "", tagline: "", address: "", phone: "", email: "", tin: "", receiptFooter: "", scaleLabel: "weight", ...profile });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Card>
      <h3 className="f-display text-base mb-1" style={{ color: C.ink }}>Receipt & till</h3>
      <p className="f-body text-xs mb-4" style={{ color: C.muted }}>Printed at the top and bottom of every receipt. Add your TIN once registered for VAT.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(() => actions.saveBusiness(f)); }} className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
        <Field label="Business name"><Input value={f.name} onChange={set("name")} maxLength={80} required /></Field>
        <Field label="Tagline"><Input value={f.tagline} onChange={set("tagline")} maxLength={80} /></Field>
        <div className="sm:col-span-2"><Field label="Address"><Input value={f.address} onChange={set("address")} maxLength={160} placeholder="Shop address" /></Field></div>
        <Field label="Phone"><Input value={f.phone} onChange={set("phone")} maxLength={40} /></Field>
        <Field label="Email"><Input value={f.email} onChange={set("email")} maxLength={80} /></Field>
        <Field label="TIN / VAT number"><Input mono value={f.tin} onChange={set("tin")} maxLength={30} /></Field>
        <Field label="Scale labels carry" hint="Barcodes starting with 2 printed by a label scale">
          <Select value={f.scaleLabel} onChange={set("scaleLabel")}><option value="weight">Weight (grams)</option><option value="price">Price (naira)</option></Select>
        </Field>
        <div className="sm:col-span-2"><Field label="Receipt footer"><Input value={f.receiptFooter} onChange={set("receiptFooter")} maxLength={200} /></Field></div>
        <div><Btn type="submit" icon={Check} busy={busy} disabled={f.name.trim().length < 2}>Save</Btn></div>
      </form>
    </Card>
  );
}
