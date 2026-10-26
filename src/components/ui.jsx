import React, { useEffect, useState } from "react";
import {
  X, Check, TrendingUp, TrendingDown, ArrowRight, AlertTriangle, Loader2,
  DollarSign, ClipboardList, Activity, Boxes, Scissors, ShoppingCart, Warehouse, Beef, Calendar,
  Users, MessageCircle, Globe, Instagram, Facebook, Snowflake, Package, Truck, ShieldCheck,
} from "lucide-react";
import { C } from "../lib/theme.js";

/** Icons referenced by name in API payloads (reports, notifications, social stats). */
export const ICONS = {
  DollarSign, ClipboardList, Activity, Boxes, Scissors, ShoppingCart, Warehouse, Beef, Calendar, Users,
  MessageCircle, Globe, Instagram, Facebook, TrendingUp, AlertTriangle, Snowflake, Package, Truck, ShieldCheck,
};

const PILL = {
  Healthy: [C.ok, "#E7F0E9"], "Under Observation": [C.warn, "#F6EEDD"],
  Active: [C.ok, "#E7F0E9"], Growing: [C.gold, "#F6EEDD"], "Ready for Processing": [C.burgundy, "#F3E4E6"],
  "Ready for Sale": [C.burgundy, "#F3E4E6"], Processed: [C.muted, "#EDEAE4"], Sold: [C.muted, "#EDEAE4"],
  Delivered: [C.ok, "#E7F0E9"], "Out for Delivery": [C.gold, "#F6EEDD"], Processing: [C.burgundy, "#F3E4E6"],
  Confirmed: [C.gold, "#F6EEDD"], New: [C.muted, "#EDEAE4"], Cancelled: [C.danger, "#F5E4E2"],
  Paid: [C.ok, "#E7F0E9"], Pending: [C.danger, "#F5E4E2"],
  Published: [C.ok, "#E7F0E9"], Approved: [C.gold, "#F6EEDD"], "Pending Approval": [C.danger, "#F5E4E2"],
  Scheduled: [C.burgundy, "#F3E4E6"], Draft: [C.muted, "#EDEAE4"],
  Critical: [C.danger, "#F5E4E2"], Low: [C.warn, "#F6EEDD"],
  Live: [C.ok, "#E7F0E9"], Next: [C.gold, "#F6EEDD"], Planned: [C.muted, "#EDEAE4"],
  Inactive: [C.muted, "#EDEAE4"],
  "Partly Received": [C.gold, "#F6EEDD"], Received: [C.ok, "#E7F0E9"], Closed: [C.muted, "#EDEAE4"], Rejected: [C.danger, "#F5E4E2"],
  Recorded: [C.gold, "#F6EEDD"], Reviewed: [C.ok, "#E7F0E9"], Matched: [C.ok, "#E7F0E9"], Mismatch: [C.danger, "#F5E4E2"],
  "Awaiting invoice": [C.gold, "#F6EEDD"], Succeeded: [C.ok, "#E7F0E9"], Passed: [C.ok, "#E7F0E9"], Failed: [C.danger, "#F5E4E2"],
  Running: [C.gold, "#F6EEDD"], Due: [C.danger, "#F5E4E2"], Done: [C.ok, "#E7F0E9"], Verified: [C.ok, "#E7F0E9"], "To verify": [C.gold, "#F6EEDD"],
};

export function StatusPill({ status }) {
  const [fg, bg] = PILL[status] || [C.muted, "#EDEAE4"];
  return (
    <span className="f-body inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap" style={{ color: fg, background: bg }}>
      {status}
    </span>
  );
}

export function KpiCard({ label, value, sub, icon: Icon, trend, onClick }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`rounded-2xl p-4 sm:p-5 border text-left w-full transition-all duration-150 ${onClick ? "hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 active:shadow-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2" : ""}`}
      style={{ background: "#fff", borderColor: C.border, ...(onClick ? { "--tw-ring-color": C.gold } : {}) }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="f-body text-[11px] sm:text-xs font-semibold tracking-wide uppercase" style={{ color: C.muted }}>{label}</span>
        {Icon && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.cream2 }}>
            <Icon size={15} style={{ color: C.burgundy }} />
          </div>
        )}
      </div>
      <div className="f-mono text-xl sm:text-2xl font-semibold mt-3 truncate" style={{ color: C.ink }}>{value}</div>
      {sub && (
        <div className="flex items-center gap-1 mt-1.5">
          {trend === "up" && <TrendingUp size={12} style={{ color: C.ok }} />}
          {trend === "down" && <TrendingDown size={12} style={{ color: C.danger }} />}
          <span className="f-body text-xs" style={{ color: trend === "up" ? C.ok : trend === "down" ? C.danger : C.muted }}>{sub}</span>
        </div>
      )}
      {onClick && <div className="f-body text-[10px] font-semibold mt-2 flex items-center gap-1" style={{ color: C.gold }}>View <ArrowRight size={10} /></div>}
    </Tag>
  );
}

export function SectionHeader({ eyebrow, title, action }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        {eyebrow && <div className="f-body text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: C.gold }}>{eyebrow}</div>}
        <h2 className="f-display text-2xl" style={{ color: C.ink }}>{title}</h2>
      </div>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}

export function Btn({ children, onClick, variant = "primary", icon: Icon, small, disabled, full, busy, type = "button", label }) {
  const styles = {
    primary: { background: C.burgundy, color: "#fff" },
    gold: { background: C.gold, color: "#fff" },
    ghost: { background: "transparent", color: C.ink, border: `1px solid ${C.input}` },
    dark: { background: C.charcoal, color: "#fff" },
    danger: { background: "transparent", color: C.danger, border: `1px solid ${C.danger}` },
  };
  const off = disabled || busy;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={off}
      aria-label={label}
      title={label}
      className={`f-body inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold whitespace-nowrap
        transition-all duration-150 hover:opacity-90 hover:shadow-sm active:scale-[0.97]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1
        ${small ? "px-2.5 sm:px-3 py-1.5 text-xs" : "px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm"}
        ${full ? "w-full" : ""}
        ${off ? "opacity-40 cursor-not-allowed active:scale-100 hover:shadow-none" : ""}`}
      style={{ ...styles[variant], "--tw-ring-color": C.gold }}
    >
      {busy ? <Loader2 size={small ? 13 : 15} className="shrink-0 animate-spin" /> : Icon && <Icon size={small ? 13 : 15} className="shrink-0" />}
      {children !== undefined && <span className="truncate">{children}</span>}
    </button>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-4" style={{ background: "rgba(28,24,21,0.55)" }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`rounded-2xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[92vh] sm:max-h-[88vh] overflow-y-auto`} style={{ background: "#fff" }}>
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 border-b sticky top-0 bg-white z-10" style={{ borderColor: C.line }}>
          <h3 className="f-display text-base sm:text-lg pr-3 truncate" style={{ color: C.ink }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-stone-100 transition-colors active:scale-95">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

export function Toast({ toast, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, toast.kind === "error" ? 5200 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  const err = toast.kind === "error";
  return (
    <div role="status" className="fixed top-20 right-4 sm:right-6 z-[90] rounded-xl px-4 sm:px-5 py-3 sm:py-3.5 flex items-center gap-3 shadow-2xl max-w-[calc(100vw-2rem)] sm:max-w-md"
      style={{ background: C.charcoal, color: "#fff", animation: "toastIn 0.25s ease-out" }}>
      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ background: err ? C.danger : C.ok }}>
        {err ? <AlertTriangle size={13} color="#fff" /> : <Check size={13} color="#fff" />}
      </div>
      <span className="f-body text-xs sm:text-sm">{toast.message}</span>
    </div>
  );
}

export function Field({ label, children, hint, error }) {
  return (
    <label className="block">
      <div className="f-body text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: C.muted }}>{label}</div>
      {children}
      {(error || hint) && <div className="f-body text-xs mt-1" style={{ color: error ? C.danger : C.muted }}>{error || hint}</div>}
    </label>
  );
}

const inputCls = "w-full text-sm rounded-lg px-3 py-2 border outline-none focus:ring-2 bg-white";
export function Input({ mono, ...props }) {
  return <input {...props} className={`${inputCls} ${mono ? "f-mono" : "f-body"}`} style={{ borderColor: C.input, "--tw-ring-color": C.goldLight }} />;
}
export function Select({ children, ...props }) {
  return <select {...props} className={`${inputCls} f-body`} style={{ borderColor: C.input, "--tw-ring-color": C.goldLight }}>{children}</select>;
}

export function Card({ children, className = "", pad = true }) {
  return <div className={`rounded-2xl border ${pad ? "p-4 sm:p-5" : "overflow-hidden"} ${className}`} style={{ background: "#fff", borderColor: C.border }}>{children}</div>;
}

/**
 * On phones every table turns into a list of cards: each cell shows its column name on the left (set here from
 * `head`), so nothing has to be scrolled sideways. `stack={false}` keeps a real table (e.g. wide matrices).
 */
export function Table({ head, minWidth = 640, children, empty, stack = true }) {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    if (!stack || !ref.current) return;
    for (const tr of ref.current.querySelectorAll("tbody tr")) {
      [...tr.children].forEach((td, i) => { const h = head[i]; td.setAttribute("data-label", typeof h === "string" ? h : ""); });
    }
  });
  return (
    <div className="overflow-x-auto">
      <table ref={ref} className={`w-full ${stack ? "tbl-stack" : ""}`} style={{ minWidth }}>
        <thead>
          <tr className="f-body text-xs uppercase tracking-wide" style={{ color: C.muted }}>
            {head.map((h, i) => <th key={i} className="text-left px-5 py-2.5 font-semibold whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty && <p className="f-body text-sm text-center py-8" style={{ color: C.muted }}>{empty}</p>}
    </div>
  );
}

export function Empty({ children }) {
  return <p className="f-body text-sm" style={{ color: C.muted }}>{children}</p>;
}

/** Keeps a submit button busy while an async action runs. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  };
  return [busy, run];
}
