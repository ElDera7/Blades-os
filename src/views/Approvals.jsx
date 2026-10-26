import React, { useEffect, useState } from "react";
import { Check, X, Undo2, ClipboardCheck, PackageX, ReceiptText, Info, Wallet } from "lucide-react";
import { C, nairaFmt } from "../lib/theme.js";
import { TillReportModal } from "./POS.jsx";
import { KpiCard, SectionHeader, Btn, StatusPill, Modal, Field, Input, Card, Empty, useBusy } from "../components/ui.jsx";

/** Approvals inbox: stock write-offs / count corrections and refunds (maker-checker). */
export function ApprovalsView({ data, actions, permit = () => false }) {
  const a = data.approvals || { adjustments: [], refunds: [] };
  const limits = data.limits || {};
  const isExec = permit("stock.adjust.direct"); // Owner / MD: no approval limit
  const overLimit = (x) => !isExec && (x.type === "adjustments" ? x.value != null && x.value > limits.adjustment : x.amount > limits.refund);
  const [signing, setSigning] = useState(null);
  const [reportCode, setReportCode] = useState(null);
  const [rejecting, setRejecting] = useState(null); // { kind, code }
  const [busyCode, setBusyCode] = useState(null);
  const [tab, setTab] = useState("pending");
  useEffect(() => { actions.refresh?.(); }, []); // always show the latest requests when opened

  const items = [
    ...a.adjustments.map((x) => ({ ...x, type: "adjustments" })),
    ...a.refunds.map((x) => ({ ...x, type: "refunds" })),
  ].map((x) => {
    const allowed = (x.type === "adjustments" ? a.canApproveStock : a.canApproveRefunds) && !x.mine;
    const above = allowed && overLimit(x);
    return { ...x, canDecide: allowed && !above, aboveLimit: above ? (x.type === "adjustments" ? limits.adjustment : limits.refund) : null };
  });
  const cashups = (data.tills?.review || []).filter((t) => t.status !== "Open");
  const openTills = (data.tills?.review || []).filter((t) => t.status === "Open");
  const cashupsWaiting = cashups.filter((t) => t.status === "Closed" && !t.mine);
  const pending = items.filter((x) => x.status === "Pending");
  const forMe = [...pending.filter((x) => x.canDecide), ...cashupsWaiting];
  const mine = pending.filter((x) => x.mine);
  const history = items.filter((x) => x.status !== "Pending");
  const isApprover = a.canApproveStock || a.canApproveRefunds || permit("till.review");

  const decide = async (x, decision, note) => {
    setBusyCode(x.code);
    const ok = await actions.decide(x.type, x.code, decision, note);
    setBusyCode(null);
    return ok;
  };

  const list = tab === "pending" ? pending : history;
  return (
    <div>
      {signing && <SignOffModal till={signing} limit={limits.tillVariance} isExec={isExec} onClose={() => setSigning(null)}
        onSign={async (note) => { if (await actions.reviewTill(signing.code, note)) setSigning(null); }} />}
      {reportCode && <TillReportModal code={reportCode} actions={actions} onClose={() => setReportCode(null)} />}
      {rejecting && <RejectModal item={rejecting} onClose={() => setRejecting(null)} onReject={async (note) => { if (await decide(rejecting, "reject", note)) setRejecting(null); }} />}
      <SectionHeader eyebrow="Controls" title="Approvals" />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-5">
        {isApprover && <KpiCard label="Waiting for you" value={forMe.length} trend={forMe.length ? "down" : null} sub={forMe.length ? "to approve or reject" : "all clear"} icon={ClipboardCheck} />}
        <KpiCard label="Your open requests" value={mine.length} sub="awaiting another manager" icon={Undo2} />
        <KpiCard label="Decided (30 days)" value={history.length} icon={Check} />
      </div>

      <div className="rounded-xl px-4 py-3 mb-5 flex gap-2.5 items-start" style={{ background: C.cream }}>
        <Info size={15} style={{ color: C.gold, flexShrink: 0, marginTop: 2 }} />
        <p className="f-body text-xs" style={{ color: C.ink }}>
          Write-offs, stock corrections and refunds change nothing until a manager approves them, and nobody can approve their own request.
          Returned meat is written off — it only goes back on sale if it never left the counter.
        </p>
      </div>

      <div className="flex gap-1.5 mb-4">
        {[["pending", `Pending (${pending.length})`], ...(permit("till.review") ? [["cash", `Cash-ups (${cashupsWaiting.length})`]] : []), ["history", "Recent decisions"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="f-body text-xs font-semibold px-3.5 py-2 rounded-lg transition-all active:scale-95"
            style={{ background: tab === k ? C.charcoal : "#fff", color: tab === k ? "#fff" : C.muted, border: `1px solid ${C.border}` }}>{l}</button>
        ))}
      </div>

      {tab === "cash" && (<>
        {openTills.length > 0 && <p className="f-body text-xs mb-3" style={{ color: C.muted }}>Open now: {openTills.map((t) => `${t.cashier} (${t.code}, since ${t.openedAt})`).join(" · ")}</p>}
        {cashups.length === 0 && <Card><Empty>No cash-ups in the last 14 days.</Empty></Card>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {cashups.map((t) => <CashupCard key={t.code} t={t} onReport={setReportCode} onSign={() => setSigning(t)} />)}
        </div>
      </>)}
      {tab !== "cash" && list.length === 0 && <Card><Empty>{tab === "pending" ? "Nothing waiting." : "No decisions in the last 30 days."}</Empty></Card>}
      {tab !== "cash" && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {list.map((x) => <RequestCard key={x.code} x={x} busy={busyCode === x.code}
          onApprove={() => decide(x, "approve")} onReject={() => setRejecting(x)} onCancel={() => decide(x, "cancel")} />)}
      </div>}
    </div>
  );
}

function RequestCard({ x, busy, onApprove, onReject, onCancel }) {
  const isAdj = x.type === "adjustments";
  const Icon = isAdj ? PackageX : ReceiptText;
  const title = isAdj
    ? `${x.kind === "wastage" ? "Write-off" : "Count correction"}: ${x.kind === "wastage" ? "−" : x.qty > 0 ? "+" : "−"}${Math.abs(x.qty)} ${x.unit} ${x.product}`
    : `Refund ${nairaFmt(x.amount)} on ${x.order}`;
  return (
    <Card>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.cream2 }}><Icon size={15} style={{ color: C.burgundy }} /></div>
          <div className="min-w-0">
            <div className="f-body text-sm font-semibold" style={{ color: C.ink }}>{title}</div>
            <div className="f-mono text-[11px]" style={{ color: C.muted }}>{x.code} · {x.requester}{x.mine ? " (you)" : ""} · {x.requestedAt}</div>
          </div>
        </div>
        <StatusPill status={x.status === "Approved" ? "Paid" : x.status === "Rejected" ? "Cancelled" : x.status === "Cancelled" ? "Inactive" : "Pending"} />
      </div>
      <div className="f-body text-xs space-y-1 mb-3" style={{ color: C.ink }}>
        {isAdj ? (<>
          <div><span style={{ color: C.muted }}>Where:</span> {x.location}</div>
          <div><span style={{ color: C.muted }}>Reason:</span> {x.reason}{x.note ? ` — ${x.note}` : ""}</div>
          {x.value != null && <div><span style={{ color: C.muted }}>Value at cost:</span> <span className="f-mono">{nairaFmt(x.value)}</span></div>}
        </>) : (<>
          <div><span style={{ color: C.muted }}>Customer:</span> {x.customer}</div>
          <div><span style={{ color: C.muted }}>Items:</span> {x.items}</div>
          <div><span style={{ color: C.muted }}>Reason:</span> {x.reason}{x.note ? ` — ${x.note}` : ""}</div>
          <div><span style={{ color: C.muted }}>Pay back by:</span> {x.method} · <span style={{ color: x.restock ? C.ok : C.danger }}>{x.restock ? "goods go back into stock" : "goods written off"}</span></div>
        </>)}
        {x.status !== "Pending" && (
          <div className="pt-1" style={{ color: C.muted }}>
            {x.status} by {x.decider ?? x.requester}{x.decidedAt ? ` · ${x.decidedAt}` : ""}{x.decisionNote ? ` — "${x.decisionNote}"` : ""}
          </div>
        )}
      </div>
      {x.status === "Pending" && (
        <div className="flex flex-wrap gap-2">
          {x.canDecide && <Btn small icon={Check} busy={busy} onClick={onApprove}>Approve</Btn>}
          {x.canDecide && <Btn small variant="danger" icon={X} onClick={onReject}>Reject</Btn>}
          {x.mine && <Btn small variant="ghost" icon={Undo2} busy={busy} onClick={onCancel}>Withdraw</Btn>}
          {x.mine && <span className="f-body text-[11px] self-center" style={{ color: C.muted }}>Needs another manager to approve.</span>}
          {x.aboveLimit != null && <span className="f-body text-[11px] self-center" style={{ color: C.danger }}>Above your {nairaFmt(x.aboveLimit)} limit — needs the Owner or MD.</span>}
        </div>
      )}
    </Card>
  );
}

function RejectModal({ item, onClose, onReject }) {
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  return (
    <Modal title={`Reject ${item.code}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); run(() => onReject(note.trim())); }} className="space-y-4">
        <Field label="Reason (shown to the requester)"><Input value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={200} autoFocus placeholder="e.g. Recount the cold room first" /></Field>
        <Btn type="submit" variant="danger" icon={X} full busy={busy} disabled={note.trim().length < 3}>Reject Request</Btn>
      </form>
    </Modal>
  );
}

function CashupCard({ t, onSign, onReport }) {
  const v = t.variance;
  return (
    <Card>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.cream2 }}><Wallet size={15} style={{ color: C.burgundy }} /></div>
          <div className="min-w-0">
            <div className="f-body text-sm font-semibold" style={{ color: C.ink }}>Cash-up {t.code} — {t.cashier}{t.mine ? " (you)" : ""}</div>
            <div className="f-mono text-[11px]" style={{ color: C.muted }}>{t.openedAt} → {t.closedAt}</div>
          </div>
        </div>
        <StatusPill status={t.status === "Reviewed" ? "Paid" : "Pending"} />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 f-body text-xs mb-3" style={{ color: C.ink }}>
        <div><span style={{ color: C.muted }}>Float:</span> <span className="f-mono">{nairaFmt(t.float)}</span></div>
        <div><span style={{ color: C.muted }}>Cash taken:</span> <span className="f-mono">{nairaFmt(t.cashIn)}</span></div>
        <div><span style={{ color: C.muted }}>Cash refunds:</span> <span className="f-mono">−{nairaFmt(t.cashOut)}</span></div>
        <div><span style={{ color: C.muted }}>Expected:</span> <span className="f-mono">{nairaFmt(t.expected)}</span></div>
        <div><span style={{ color: C.muted }}>Counted:</span> <span className="f-mono">{nairaFmt(t.counted)}</span></div>
        <div><span style={{ color: C.muted }}>Variance:</span> <span className="f-mono font-semibold" style={{ color: v === 0 ? C.ok : C.danger }}>{v === 0 ? "balanced" : `${v > 0 ? "+" : "−"}${nairaFmt(Math.abs(v))} ${v > 0 ? "over" : "short"}`}</span></div>
      </div>
      {t.byMethod.length > 0 && <div className="f-body text-[11px] mb-2" style={{ color: C.muted }}>Takings: {t.byMethod.map((m) => `${m.method} ${nairaFmt(m.amount)} (${m.orders})`).join(" · ")}</div>}
      {t.closeNote && <div className="f-body text-[11px] mb-2" style={{ color: C.muted }}>Cashier's note: "{t.closeNote}"</div>}
      {t.status === "Reviewed" && <div className="f-body text-[11px]" style={{ color: C.muted }}>Signed off by {t.reviewer} · {t.reviewedAt}{t.reviewNote ? ` — "${t.reviewNote}"` : ""}</div>}
      <div className="flex gap-1.5">
        {onReport && <Btn small variant="ghost" icon={ReceiptText} onClick={() => onReport(t.code)}>Report</Btn>}
        {t.status === "Closed" && !t.mine && <Btn small icon={Check} onClick={onSign}>Sign Off</Btn>}
      </div>
      {t.status === "Closed" && t.mine && <span className="f-body text-[11px]" style={{ color: C.muted }}>Your cash-up — another manager signs it off.</span>}
    </Card>
  );
}

function SignOffModal({ till, limit, isExec, onClose, onSign }) {
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const needsNote = till.variance !== 0;
  const tooBig = !isExec && Math.abs(till.variance) > limit;
  return (
    <Modal title={`Sign off ${till.code}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); run(() => onSign(note.trim())); }} className="space-y-4">
        <p className="f-body text-sm" style={{ color: C.ink }}>
          {till.variance === 0 ? "This till balanced exactly." : `This till is ${nairaFmt(Math.abs(till.variance))} ${till.variance > 0 ? "over" : "short"}.`}
        </p>
        {tooBig && <p className="f-body text-xs" style={{ color: C.danger }}>The variance is above the {nairaFmt(limit)} limit — only the Owner or MD can sign it off.</p>}
        <Field label={needsNote ? "Explanation (required)" : "Note (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={needsNote ? "e.g. Change given wrongly, discussed with cashier" : ""} /></Field>
        <Btn type="submit" icon={Check} full busy={busy} disabled={tooBig || (needsNote && note.trim().length < 3)}>Sign Off Cash-up</Btn>
      </form>
    </Modal>
  );
}
