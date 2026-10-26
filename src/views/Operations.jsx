import React, { useEffect, useState } from "react";
import { Thermometer, ClipboardList, Plus, Check, Search, Download, Loader2, AlertTriangle, History, Layers, Ban } from "lucide-react";
import { C, qtyFmt, exportCsv } from "../lib/theme.js";
import { Btn, StatusPill, Modal, Field, Input, Select, Card, Empty, useBusy } from "../components/ui.jsx";

const todayIso = (d = 0) => new Date(Date.now() + 3600e3 + d * 864e5).toISOString().slice(0, 10);
const lotPill = (s) => (s === "Expired" ? "Critical" : s === "Use soon" ? "Low" : "Healthy");

/* ============================================================ cold chain */
export function ColdChainCard({ data, actions, permit }) {
  const locs = (data.coldChain || []).filter((l) => l.monitored);
  const [logging, setLogging] = useState(null);
  const [history, setHistory] = useState(null);
  const canLog = permit("temps.record");
  return (
    <Card>
      {logging && <LogTempModal locations={locs} initial={logging} onClose={() => setLogging(null)} onSave={actions.logTemp} />}
      {history && (
        <Modal title={`${history.name} — last 7 days`} onClose={() => setHistory(null)}>
          {history.history.length === 0 ? <Empty>No readings yet.</Empty> : (
            <div className="space-y-2">
              {history.history.map((h, i) => (
                <div key={i} className="flex items-start justify-between gap-2 rounded-lg px-3 py-2" style={{ background: h.inRange ? C.cream : "#F5E4E2" }}>
                  <div className="min-w-0">
                    <div className="f-body text-xs" style={{ color: C.ink }}>{h.at} · {h.who}</div>
                    {h.action && <div className="f-body text-[11px]" style={{ color: C.danger }}>Action: {h.action}</div>}
                    {h.note && <div className="f-body text-[11px]" style={{ color: C.muted }}>{h.note}</div>}
                  </div>
                  <span className="f-mono text-sm font-semibold shrink-0" style={{ color: h.inRange ? C.ok : C.danger }}>{h.reading}°C</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="f-display text-base flex items-center gap-2" style={{ color: C.ink }}><Thermometer size={15} /> Cold Chain</h3>
        {canLog && locs.length > 0 && <Btn small icon={Plus} onClick={() => setLogging(locs[0].name)}>Log Reading</Btn>}
      </div>
      {locs.length === 0 && <Empty>No locations have a safe temperature range set (Business Setup → Storage Locations).</Empty>}
      <div className="space-y-2">
        {locs.map((l) => {
          const bad = l.last && !l.last.inRange;
          return (
            <div key={l.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: bad ? "#F5E4E2" : C.cream }}>
              <button onClick={() => setHistory(l)} className="min-w-0 text-left">
                <div className="f-body text-sm font-medium" style={{ color: C.ink }}>{l.name}</div>
                <div className="f-body text-[11px]" style={{ color: l.overdue ? C.danger : C.muted }}>
                  Safe {l.min}°C to {l.max}°C · {l.last ? `${l.last.at}` : "no reading yet"}{l.overdue ? " · check overdue" : ""}
                </div>
              </button>
              <div className="flex items-center gap-2 shrink-0">
                {l.last && <span className="f-mono text-sm font-semibold" style={{ color: bad ? C.danger : C.ok }}>{l.last.reading}°C</span>}
                {canLog && <button onClick={() => setLogging(l.name)} aria-label={`Log ${l.name}`} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white"><Plus size={13} style={{ color: C.muted }} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="f-body text-[11px] mt-3" style={{ color: C.muted }}>Record each cold room and freezer at least twice a day. A reading outside the safe range needs the corrective action taken.</p>
    </Card>
  );
}

function LogTempModal({ locations, initial, onClose, onSave }) {
  const [location, setLocation] = useState(initial);
  const [reading, setReading] = useState("");
  const [action, setAction] = useState("");
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const loc = locations.find((l) => l.name === location);
  const r = Number(reading);
  const out = reading !== "" && loc && ((loc.min != null && r < loc.min) || (loc.max != null && r > loc.max));
  const valid = reading !== "" && Number.isFinite(r) && (!out || action.trim().length >= 3);
  const submit = (e) => { e.preventDefault(); run(async () => { if (await onSave({ location, reading: r, note: note.trim() || undefined, action: action.trim() || undefined })) onClose(); }); };
  return (
    <Modal title="Log Temperature" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Location"><Select value={location} onChange={(e) => setLocation(e.target.value)}>{locations.map((l) => <option key={l.id}>{l.name}</option>)}</Select></Field>
          <Field label="Reading (°C)" hint={loc ? `Safe ${loc.min}°C to ${loc.max}°C` : null} error={out ? "Outside the safe range" : null}>
            <Input mono type="number" step="0.1" value={reading} onChange={(e) => setReading(e.target.value)} autoFocus />
          </Field>
        </div>
        {out && (
          <Field label="Corrective action taken (required)">
            <Input value={action} onChange={(e) => setAction(e.target.value)} maxLength={200} placeholder="e.g. Door was open; closed, re-checked in 30 min, stock moved" />
          </Field>
        )}
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
        <Btn type="submit" icon={Check} full busy={busy} disabled={!valid}>Save Reading</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ stock counts */
export function CountsCard({ data, actions, permit }) {
  const counts = data.counts || [];
  const [scheduling, setScheduling] = useState(false);
  const [counting, setCounting] = useState(null);
  const [detail, setDetail] = useState(null);
  const canSchedule = permit("counts.schedule"), canCount = permit("counts.perform");
  return (
    <Card>
      {scheduling && <ScheduleCountModal locations={data.meta.locations} counts={counts} onClose={() => setScheduling(false)} onSave={actions.scheduleCount} />}
      {counting && <CountModal code={counting} actions={actions} onClose={() => setCounting(null)} />}
      {detail && (
        <Modal title={`${detail.code} — ${detail.location}`} onClose={() => setDetail(null)}>
          <p className="f-body text-xs mb-3" style={{ color: C.muted }}>Counted by {detail.submittedBy} · {detail.submittedAt} · {detail.lines} lines</p>
          {detail.detail?.length ? (
            <div className="space-y-1.5">
              {detail.detail.map((d, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: C.cream }}>
                  <div className="f-body text-sm" style={{ color: C.ink }}>{d.product}<div className="f-mono text-[11px]" style={{ color: C.muted }}>system {d.expected} · counted {d.counted} · {d.adjustment}</div></div>
                  <span className="f-mono text-sm font-semibold" style={{ color: C.danger }}>{d.counted - d.expected > 0 ? "+" : ""}{Math.round((d.counted - d.expected) * 1000) / 1000} {d.unit}</span>
                </div>
              ))}
            </div>
          ) : <Empty>Everything matched.</Empty>}
        </Modal>
      )}
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="f-display text-base flex items-center gap-2" style={{ color: C.ink }}><ClipboardList size={15} /> Stock Counts</h3>
        {canSchedule && <Btn small icon={Plus} onClick={() => setScheduling(true)}>Schedule Count</Btn>}
      </div>
      {counts.length === 0 && <Empty>No counts in the last 30 days.{canSchedule ? " Schedule one per location every week." : ""}</Empty>}
      <div className="space-y-2">
        {counts.map((c) => (
          <div key={c.code} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: c.overdue ? "#F5E4E2" : C.cream }}>
            <div className="min-w-0">
              <div className="f-body text-sm font-medium" style={{ color: C.ink }}>{c.location} <span className="f-mono text-[11px]" style={{ color: C.muted }}>{c.code}</span></div>
              <div className="f-body text-[11px]" style={{ color: c.overdue ? C.danger : C.muted }}>
                {c.status === "Open" ? `Due ${c.dueOn}${c.overdue ? " — overdue" : ""}` : c.status === "Submitted" ? `Counted ${c.submittedAt} · ${c.variances} difference${c.variances === 1 ? "" : "s"}` : "Cancelled"}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              {c.status === "Open" && canCount && <Btn small onClick={() => setCounting(c.code)}>Count</Btn>}
              {c.status === "Open" && canSchedule && <Btn label="Cancel count" small variant="ghost" icon={Ban} onClick={() => actions.cancelCount(c.code)} />}
              {c.status === "Submitted" && c.detail && <Btn small variant="ghost" onClick={() => setDetail(c)}>View</Btn>}
              {c.status !== "Open" && !c.detail && <StatusPill status={c.status === "Submitted" ? "Published" : "Inactive"} />}
            </div>
          </div>
        ))}
      </div>
      <p className="f-body text-[11px] mt-3" style={{ color: C.muted }}>Counts are blind: the counter never sees the system figure. Differences become correction requests for a manager to approve.</p>
    </Card>
  );
}

function ScheduleCountModal({ locations, counts, onClose, onSave }) {
  const open = new Set(counts.filter((c) => c.status === "Open").map((c) => c.location));
  const free = locations.filter((l) => !open.has(l));
  const [location, setLocation] = useState(free[0]);
  const [dueOn, setDueOn] = useState(todayIso());
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const submit = (e) => { e.preventDefault(); run(async () => { if (await onSave({ location, dueOn, note: note.trim() || undefined })) onClose(); }); };
  return (
    <Modal title="Schedule Stock Count" onClose={onClose}>
      {free.length === 0 ? <Empty>Every location already has an open count.</Empty> : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Location"><Select value={location} onChange={(e) => setLocation(e.target.value)}>{free.map((l) => <option key={l}>{l}</option>)}</Select></Field>
            <Field label="Due"><Input type="date" min={todayIso()} value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
          </div>
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Before Sallah stock-up" /></Field>
          <Btn type="submit" icon={Check} full busy={busy} disabled={!location || !dueOn}>Schedule</Btn>
        </form>
      )}
    </Modal>
  );
}

function CountModal({ code, actions, onClose }) {
  const [sheet, setSheet] = useState(null);
  const [vals, setVals] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  useEffect(() => { actions.getCount(code).then(setSheet).catch((e) => setError(e.message)); }, [code]);
  const rows = sheet ? sheet.products.filter((p) => showAll || p.required || vals[p.sku] !== undefined) : [];
  const missing = sheet ? sheet.products.filter((p) => p.required && (vals[p.sku] === undefined || vals[p.sku] === "")) : [];
  const bad = sheet ? sheet.products.filter((p) => vals[p.sku] !== undefined && vals[p.sku] !== "" && (Number(vals[p.sku]) < 0 || (p.unit !== "KG" && !Number.isInteger(Number(vals[p.sku]))))) : [];
  const submit = () => run(async () => {
    const lines = Object.entries(vals).filter(([, v]) => v !== "").map(([sku, v]) => ({ sku, counted: Number(v) }));
    if (await actions.submitCount(code, lines)) onClose();
  });
  return (
    <Modal title={`Count ${code}${sheet ? ` — ${sheet.location}` : ""}`} onClose={onClose}>
      {error && <p className="f-body text-sm" style={{ color: C.danger }}>{error}</p>}
      {!sheet && !error && <div className="flex items-center gap-2 f-body text-sm" style={{ color: C.muted }}><Loader2 size={14} className="animate-spin" /> Loading…</div>}
      {sheet && (<>
        <p className="f-body text-xs mb-3" style={{ color: C.muted }}>Weigh or count what is physically here. Products marked • are recorded at this location and must be counted (enter 0 if none).</p>
        <div className="space-y-2 mb-3 max-h-[50vh] overflow-y-auto pr-1">
          {rows.map((p) => (
            <div key={p.sku} className="flex items-center justify-between gap-3">
              <span className="f-body text-sm" style={{ color: C.ink }}>{p.required && <span style={{ color: C.burgundy }}>• </span>}{p.name}</span>
              <div className="w-32 shrink-0"><Input mono type="number" min="0" step={p.unit === "KG" ? "0.01" : "1"} value={vals[p.sku] ?? ""} placeholder={p.unit}
                onChange={(e) => setVals((v) => ({ ...v, [p.sku]: e.target.value }))} /></div>
            </div>
          ))}
        </div>
        {!showAll && <button onClick={() => setShowAll(true)} className="f-body text-xs mb-4 hover:underline" style={{ color: C.burgundy }}>Found something else here? Show all products</button>}
        {missing.length > 0 && <p className="f-body text-xs mb-2" style={{ color: C.muted }}>Still to count: {missing.map((m) => m.name).join(", ")}</p>}
        <Btn icon={Check} full busy={busy} disabled={missing.length > 0 || bad.length > 0} onClick={submit}>Submit Count</Btn>
      </>)}
    </Modal>
  );
}

/* ============================================================ batches & trace */
export function BatchesModal({ item, permit, onTrace, onClose }) {
  return (
    <Modal title={`${item.name} — batches`} onClose={onClose}>
      {item.lots.length === 0 ? <Empty>No stock.</Empty> : (
        <div className="space-y-2">
          {item.lots.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: l.status === "Expired" ? "#F5E4E2" : C.cream }}>
              <div className="min-w-0">
                <div className="f-mono text-sm font-semibold" style={{ color: C.ink }}>{l.code}</div>
                <div className="f-body text-[11px]" style={{ color: C.muted }}>{l.location} · use by {l.expiresOn}{l.daysLeft >= 0 ? ` (${l.daysLeft} day${l.daysLeft === 1 ? "" : "s"})` : ""}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="f-mono text-sm" style={{ color: C.ink }}>{qtyFmt(l.qty, item.unit)}</span>
                <StatusPill status={lotPill(l.status)} />
                {permit("trace.view") && <Btn label="Trace batch" small variant="ghost" icon={Search} onClick={() => onTrace(l.code)} />}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="f-body text-[11px] mt-3" style={{ color: C.muted }}>Sales take the earliest use-by date first. Expired batches can't be sold — write them off.</p>
    </Modal>
  );
}

export function TraceModal({ lot, actions, onClose }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState(lot || "");
  const load = (code) => { setT(null); setError(null); actions.trace(code).then(setT).catch((e) => setError(e.message)); };
  useEffect(() => { if (lot) load(lot); }, [lot]);
  const exportRecall = () => exportCsv(`recall-${t.lot}.csv`, t.sales.map((s) => ({ order: s.order, date: s.date, customer: s.customer, phone: s.phone ?? "", product: s.product, qty: s.qty, unit: s.unit, channel: s.channel })));
  return (
    <Modal title="Batch Trace" onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) load(q.trim()); }} className="flex gap-2 mb-4">
        <Input mono value={q} onChange={(e) => setQ(e.target.value)} placeholder="Batch code, e.g. PB-2026-0081" />
        <Btn type="submit" icon={Search}>Trace</Btn>
      </form>
      {error && <p className="f-body text-sm" style={{ color: C.danger }}>{error}</p>}
      {!t && !error && lot && <div className="flex items-center gap-2 f-body text-sm" style={{ color: C.muted }}><Loader2 size={14} className="animate-spin" /> Tracing…</div>}
      {t && (<>
        {t.batch && (
          <div className="rounded-xl p-3 mb-4 f-body text-xs" style={{ background: C.cream, color: C.ink }}>
            <b>{t.batch.code}</b> · processed {t.batch.processed} · {t.batch.species} {t.batch.animal} ({t.batch.breed}) from {t.batch.ranch} · {t.batch.yield}% yield
          </div>
        )}
        <div className="f-body text-[10px] uppercase tracking-wide mb-2 flex items-center gap-1.5" style={{ color: C.muted }}><Layers size={11} /> Still in stock</div>
        <div className="space-y-1 mb-4">
          {t.holdings.filter((h) => h.qty > 0).length === 0 && <Empty>None left.</Empty>}
          {t.holdings.filter((h) => h.qty > 0).map((h, i) => (
            <div key={i} className="flex justify-between f-body text-sm" style={{ color: C.ink }}><span>{h.product} · {h.location} · use by {h.expiresOn}</span><span className="f-mono">{qtyFmt(h.qty, h.unit)}</span></div>
          ))}
        </div>
        <div className="flex items-center justify-between mb-2">
          <div className="f-body text-[10px] uppercase tracking-wide flex items-center gap-1.5" style={{ color: C.muted }}><History size={11} /> Sold to ({t.sales.length})</div>
          {t.sales.length > 0 && <Btn small variant="ghost" icon={Download} onClick={exportRecall}>Recall list (CSV)</Btn>}
        </div>
        {t.sales.length === 0 ? <Empty>Nothing from this batch has been sold.</Empty> : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {t.sales.map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: C.cream }}>
                <div className="min-w-0">
                  <div className="f-body text-sm" style={{ color: C.ink }}>{s.customer}{s.phone ? ` · ${s.phone}` : ""}</div>
                  <div className="f-mono text-[11px]" style={{ color: C.muted }}>{s.order} · {s.date} · {s.product}</div>
                </div>
                <span className="f-mono text-sm shrink-0" style={{ color: C.ink }}>{qtyFmt(s.qty, s.unit)}</span>
              </div>
            ))}
          </div>
        )}
        {t.sales.some((s) => s.customer === "Walk-in customer") && (
          <p className="f-body text-[11px] mt-3 flex items-center gap-1" style={{ color: C.warn }}><AlertTriangle size={11} /> Walk-in sales have no contact details — use an in-store notice for those.</p>
        )}
      </>)}
    </Modal>
  );
}
