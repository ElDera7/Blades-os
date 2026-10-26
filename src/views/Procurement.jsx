import React, { useState } from "react";
import { Plus, Pencil, Check, Archive, RotateCcw, Phone, FileText, Banknote, ChevronDown, ChevronUp } from "lucide-react";
import { C, nairaFmt } from "../lib/theme.js";
import { KpiCard, SectionHeader, Btn, StatusPill, Modal, Field, Input, Card, Empty, ICONS, useBusy } from "../components/ui.jsx";

const TYPES = ["Livestock Supplier", "Abattoir Supplier", "Frozen Food Supplier", "Packaging Supplier", "Feed & Vet Supplies", "Logistics", "Other"];
const todayIso = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);

export function ProcurementView({ data, actions, permit }) {
  const all = data.suppliers || [];
  const [showRetired, setShowRetired] = useState(false);
  const [modal, setModal] = useState(null); // { kind: "supplier"|"invoice"|"payment", supplier? }
  const [open, setOpen] = useState(null);
  const canEdit = permit("procurement.edit");
  const canPay = permit("payables.pay");
  const suppliers = all.filter((s) => showRetired || s.active);
  const owed = all.reduce((s, x) => s + Math.max(0, x.balance), 0);
  const ytd = all.reduce((s, x) => s + x.invoicedYtd, 0);
  const retired = all.filter((s) => !s.active).length;

  return (
    <div>
      {modal?.kind === "supplier" && <SupplierForm item={modal.supplier} onClose={() => setModal(null)} actions={actions} />}
      {(modal?.kind === "invoice" || modal?.kind === "payment") && <EntryForm kind={modal.kind} supplier={modal.supplier} onClose={() => setModal(null)} actions={actions} />}

      <SectionHeader eyebrow="Procurement" title="Suppliers & Payables" action={canEdit && <Btn icon={Plus} small onClick={() => setModal({ kind: "supplier" })}>Add Supplier</Btn>} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6">
        <KpiCard label="Active Suppliers" value={all.filter((s) => s.active).length} icon={ICONS.Package} />
        <KpiCard label="Outstanding" value={nairaFmt(owed)} trend={owed > 0 ? "down" : null} sub={owed > 0 ? "owed to suppliers" : "all settled"} icon={ICONS.DollarSign} />
        <KpiCard label="Invoiced This Year" value={nairaFmt(ytd)} icon={ICONS.ClipboardList} />
      </div>

      {retired > 0 && (
        <label className="flex items-center gap-2 f-body text-xs mb-3" style={{ color: C.muted }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired ({retired})
        </label>
      )}
      {suppliers.length === 0 && <Card><Empty>No suppliers yet.{canEdit && " Add your livestock, abattoir, frozen food and packaging suppliers to track what you owe them."}</Empty></Card>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {suppliers.map((s) => (
          <Card key={s.id} className={s.active ? "" : "opacity-60"}>
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="min-w-0">
                <div className="f-body text-sm font-semibold truncate" style={{ color: C.ink }}>{s.name}</div>
                <div className="f-body text-xs" style={{ color: C.muted }}>{s.type}{s.contactName ? ` · ${s.contactName}` : ""}</div>
                {s.phone && <a href={`tel:${s.phone.replace(/\s/g, "")}`} className="f-body text-xs inline-flex items-center gap-1 mt-0.5 hover:underline" style={{ color: C.burgundy }}><Phone size={11} />{s.phone}</a>}
              </div>
              {s.active ? <StatusPill status={s.balance > 0 ? "Pending" : "Paid"} /> : <StatusPill status="Inactive" />}
            </div>
            <div className="grid grid-cols-3 gap-2 f-mono text-sm mb-3">
              <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Invoiced YTD</div><div className="font-semibold truncate" style={{ color: C.ink }}>{nairaFmt(s.invoicedYtd)}</div></div>
              <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Paid YTD</div><div className="font-semibold truncate" style={{ color: C.ink }}>{nairaFmt(s.paidYtd)}</div></div>
              <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Balance</div><div className="font-semibold truncate" style={{ color: s.balance > 0 ? C.danger : C.ok }}>{nairaFmt(s.balance)}</div></div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {s.active && canEdit && <Btn small variant="ghost" icon={FileText} onClick={() => setModal({ kind: "invoice", supplier: s })}>Invoice</Btn>}
              {s.active && canPay && s.balance > 0 && <Btn small variant="gold" icon={Banknote} onClick={() => setModal({ kind: "payment", supplier: s })}>Pay</Btn>}
              {s.active && canEdit && <Btn label="Edit supplier" small variant="ghost" icon={Pencil} onClick={() => setModal({ kind: "supplier", supplier: s })} />}
              {canEdit && (s.active
                ? <Btn label="Archive supplier" small variant="ghost" icon={Archive} disabled={s.balance > 0} onClick={() => actions.updateSupplier(s.id, { active: false }, `${s.name} retired`)} />
                : <Btn small variant="ghost" icon={RotateCcw} onClick={() => actions.updateSupplier(s.id, { active: true }, `${s.name} restored`)}>Restore</Btn>)}
              {s.entries.length > 0 && (
                <Btn small variant="ghost" icon={open === s.id ? ChevronUp : ChevronDown} onClick={() => setOpen(open === s.id ? null : s.id)}>History</Btn>
              )}
            </div>
            {open === s.id && (
              <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: C.line }}>
                {s.entries.map((e) => (
                  <div key={e.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="f-body text-xs" style={{ color: C.ink }}>{e.kind === "invoice" ? "Invoice" : "Payment"}{e.reference ? ` · ${e.reference}` : ""}</div>
                      <div className="f-body text-[11px]" style={{ color: C.muted }}>{e.date}{e.who ? ` · ${e.who}` : ""}{e.note ? ` · ${e.note}` : ""}</div>
                    </div>
                    <span className="f-mono text-sm font-semibold shrink-0" style={{ color: e.kind === "invoice" ? C.danger : C.ok }}>{e.kind === "invoice" ? "+" : "−"}{nairaFmt(e.amount)}</span>
                  </div>
                ))}
                <p className="f-body text-[10px]" style={{ color: C.muted }}>Latest 10 entries</p>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function SupplierForm({ item, onClose, actions }) {
  const [f, setF] = useState({ name: item?.name ?? "", type: item?.type ?? TYPES[0], contactName: item?.contactName ?? "", phone: item?.phone ?? "" });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const phoneBad = f.phone && !/^[+\d][\d\s-]{6,19}$/.test(f.phone.trim());
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { name: f.name.trim(), type: f.type.trim(), contactName: f.contactName.trim(), phone: f.phone.trim() };
      const r = item ? await actions.updateSupplier(item.id, body, `${body.name} saved`) : await actions.addSupplier(body);
      if (r) onClose();
    });
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : "Add Supplier"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Supplier name"><Input value={f.name} onChange={set("name")} required minLength={2} maxLength={80} autoFocus /></Field>
        <Field label="Type">
          <Input list="sup-types" value={f.type} onChange={set("type")} required maxLength={40} />
          <datalist id="sup-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Contact person"><Input value={f.contactName} onChange={set("contactName")} maxLength={60} /></Field>
          <Field label="Phone" error={phoneBad ? "Check the number" : null}><Input type="tel" value={f.phone} onChange={set("phone")} /></Field>
        </div>
        <Btn type="submit" icon={Check} full busy={busy} disabled={f.name.trim().length < 2 || f.type.trim().length < 2 || phoneBad}>{item ? "Save Changes" : "Add Supplier"}</Btn>
      </form>
    </Modal>
  );
}

function EntryForm({ kind, supplier, onClose, actions }) {
  const pay = kind === "payment";
  const [amount, setAmount] = useState(pay ? String(supplier.balance) : "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayIso());
  const [busy, run] = useBusy();
  const a = Number(amount);
  const err = amount === "" ? null : !(Number.isInteger(a) && a > 0) ? "Whole Naira above zero." : pay && a > supplier.balance ? `Only ${nairaFmt(supplier.balance)} is owed.` : null;
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await actions.supplierEntry(supplier.id, { kind, amount: a, reference: reference.trim(), note: note.trim(), date }, `${pay ? "Payment to" : "Invoice from"} ${supplier.name} recorded`);
      if (r) onClose();
    });
  };
  return (
    <Modal title={`${pay ? "Pay" : "Record invoice —"} ${supplier.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {pay && <p className="f-body text-sm" style={{ color: C.muted }}>Outstanding: <span className="f-mono font-semibold" style={{ color: C.danger }}>{nairaFmt(supplier.balance)}</span></p>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount (₦)" error={err}><Input mono type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus /></Field>
          <Field label="Date"><Input type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        <Field label={pay ? "Reference (transfer / cheque no.)" : "Invoice number"}><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></Field>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={pay ? "" : "e.g. 4 cattle, 12 goats"} /></Field>
        <Btn type="submit" variant={pay ? "gold" : "primary"} icon={pay ? Banknote : FileText} full busy={busy} disabled={!amount || !!err}>{pay ? "Record Payment" : "Record Invoice"}</Btn>
      </form>
    </Modal>
  );
}
