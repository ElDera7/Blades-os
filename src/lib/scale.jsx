// Digital scale over USB / RS-232 using the Web Serial API (Chrome or Edge on a desktop, over HTTPS).
// Most retail and bench scales stream their reading as text, e.g.
//   "ST,GS,+  1.250kg"   (A&D, CAS, many OEM scales — ST = stable, US = moving, OL = overload)
//   "   1.250 kg"        (plain continuous output)
//   "1250 g" · "2.75 lb"
// Some only answer when asked ("W", "P" or "S" + CR LF) — set the poll command in Scale settings.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Scale as ScaleIcon, Settings2, Plug, Unplug } from "lucide-react";
import { C } from "./theme.js";
import { Btn, Modal, Field, Select, Input } from "../components/ui.jsx";
import { rememberPort, forgetRole, portFor } from "./hardware.js";

const KEY = "bladeos.scale";
const DEFAULTS = { baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1, poll: "", unit: "kg" };
const TO_KG = { kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237, oz: 0.028349523125 };

export const scaleSupported = () => typeof navigator !== "undefined" && "serial" in navigator && typeof window !== "undefined" && window.isSecureContext !== false;

function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: settings last this session only */ }
}

/**
 * Parse one line from a scale. Returns null for lines without a weight,
 * { overload: true } on overload, or { kg, stable } where stable is true / false / null (scale didn't say).
 */
export function parseScaleLine(line, defaultUnit = "kg") {
  const t = String(line).replace(/[\x00-\x08\x0e-\x1f]/g, "").trim();
  if (!t) return null;
  if (/\bOL\b|overload|-{4,}|\bERR/i.test(t)) return { overload: true };
  const m = [...t.matchAll(/([-+]?)\s*(\d+(?:[.,]\d+)?)\s*,?\s*(kg|g|lbs?|oz)?(?![a-z])/gi)];
  if (!m.length) return null;
  // Prefer the number that carries a unit; otherwise the last number on the line (the weight comes after flags/IDs).
  const hit = m.find((x) => x[3]) || m[m.length - 1];
  const unit = (hit[3] || defaultUnit).toLowerCase();
  const value = Number(hit[2].replace(",", ".")) * (hit[1] === "-" ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  const stable = /\bUS\b|\bM\b|motion|\?/i.test(t) ? false : /\bST\b|\bS\b|stable/i.test(t) ? true : null;
  return { kg: Math.round(value * TO_KG[unit] * 1000) / 1000, stable };
}

const ScaleCtx = createContext(null);
export const useScale = () => useContext(ScaleCtx);

export function ScaleProvider({ children }) {
  const [settings, setSettingsState] = useState(loadSettings);
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(null); // { kg, stable, at } | { overload: true }
  const portRef = useRef(null), readerRef = useRef(null), pollRef = useRef(null), recent = useRef([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const stop = useCallback(async () => {
    clearInterval(pollRef.current);
    try { await readerRef.current?.cancel(); } catch { /* already closed */ }
    try { readerRef.current?.releaseLock(); } catch { /* ignore */ }
    readerRef.current = null;
    try { await portRef.current?.close(); } catch { /* ignore */ }
  }, []);

  const start = useCallback(async (port) => {
    const s = settingsRef.current;
    setStatus("connecting"); setError(null);
    try {
      await port.open({ baudRate: Number(s.baudRate), dataBits: Number(s.dataBits), parity: s.parity, stopBits: Number(s.stopBits) });
    } catch (e) {
      // Already open (e.g. after a hot reload) is fine; anything else is a real failure.
      if (!/already open/i.test(e?.message || "")) { setStatus("error"); setError(e?.message || "Couldn't open the scale's port."); return; }
    }
    portRef.current = port;
    setStatus("connected");
    if (s.poll) {
      const cmd = new TextEncoder().encode(s.poll.replace(/\\r/g, "\r").replace(/\\n/g, "\n") + (/\\r|\\n/.test(s.poll) ? "" : "\r\n"));
      pollRef.current = setInterval(async () => {
        try { const w = port.writable.getWriter(); await w.write(cmd); w.releaseLock(); } catch { /* port went away */ }
      }, 400);
    }
    const decoder = new TextDecoder();
    let buf = "", finished = false, errors = 0;
    // Web Serial: read() returning done means the port was closed or cancelled — stop. A thrown error (framing,
    // buffer overrun) is usually recoverable: port.readable is replaced and we carry on with a fresh reader.
    while (port.readable && !finished && errors < 5) {
      const reader = port.readable.getReader();
      readerRef.current = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { finished = true; break; }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split(/[\r\n]+/);
          buf = parts.pop();
          if (buf.length > 200) buf = "";
          for (const line of parts) {
            const r = parseScaleLine(line, settingsRef.current.unit);
            if (!r) continue;
            if (r.overload) { setReading({ overload: true, at: Date.now() }); continue; }
            // Scales that don't flag stability: treat 3 identical readings in a row as stable.
            recent.current = [...recent.current.slice(-2), r.kg];
            const stable = r.stable ?? (recent.current.length === 3 && recent.current.every((x) => x === r.kg));
            setReading({ kg: r.kg, stable, at: Date.now() });
          }
        }
      } catch (e) {
        errors++;
        setError(e?.message || "Lost the scale connection.");
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    }
    clearInterval(pollRef.current);
    if (portRef.current === port) { setStatus((st) => (st === "connected" ? "idle" : st)); }
  }, []);

  /** Must be called from a click: the browser asks which USB / serial device is the scale. */
  const connect = useCallback(async () => {
    if (!scaleSupported()) { setStatus("error"); setError("This browser can't talk to a scale — use Chrome or Edge on a computer."); return; }
    try {
      const port = await navigator.serial.requestPort();
      rememberPort("scale", port);
      await stop();
      start(port);
    } catch (e) {
      if (e?.name !== "NotFoundError") { setStatus("error"); setError(e?.message || "Couldn't connect to the scale."); }
    }
  }, [start, stop]);

  const disconnect = useCallback(async () => {
    const port = portRef.current;
    portRef.current = null;
    await stop();
    setStatus("idle"); setReading(null);
    forgetRole("scale");
  }, [stop]);

  const setSettings = useCallback(async (next) => {
    saveSettings(next); setSettingsState(next); settingsRef.current = next;
    const port = portRef.current;
    if (port) { await stop(); start(port); } // reopen with the new line settings
  }, [start, stop]);

  // Reconnect automatically to a scale this browser was allowed to use before.
  useEffect(() => {
    if (!scaleSupported()) return;
    let cancelled = false;
    // Only the port recorded as the scale — never the receipt printer's.
    portFor("scale").then((p) => { if (!cancelled && p && !portRef.current) start(p); }).catch(() => {});
    const onDisconnect = (e) => { if (e.target === portRef.current) { portRef.current = null; stop(); setStatus("idle"); setReading(null); } };
    navigator.serial.addEventListener?.("disconnect", onDisconnect);
    return () => { cancelled = true; navigator.serial.removeEventListener?.("disconnect", onDisconnect); stop(); };
  }, [start, stop]);

  const fresh = reading && Date.now() - reading.at < 3000 ? reading : null;
  return (
    <ScaleCtx.Provider value={{ supported: scaleSupported(), status, error, reading: fresh, settings, connect, disconnect, setSettings }}>
      {children}
    </ScaleCtx.Provider>
  );
}

/** Live reading + "Use weight" for a KG item. onWeight(kg) receives a stable, positive weight. */
export function ScaleReader({ onWeight, max, label = "Use weight" }) {
  const s = useScale();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  if (!s || !s.supported) return null;
  const r = s.reading;
  const usable = r && !r.overload && r.stable && r.kg > 0 && (max == null || r.kg <= max + 1e-9);
  return (
    <div className="flex flex-wrap items-center gap-2 mt-2" data-scale>
      {settingsOpen && <ScaleSettings onClose={() => setSettingsOpen(false)} />}
      {s.status !== "connected" ? (
        <Btn small variant="ghost" icon={Plug} busy={s.status === "connecting"} onClick={s.connect}>Connect scale</Btn>
      ) : (
        <>
          <span className="f-mono text-sm font-semibold inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: "#fff", border: `1px solid ${C.input}`, color: C.ink }}>
            <ScaleIcon size={13} style={{ color: C.muted }} />
            {!r ? "waiting…" : r.overload ? "OVERLOAD" : `${r.kg.toFixed(3)} kg`}
            {r && !r.overload && <span className="w-2 h-2 rounded-full" title={r.stable ? "stable" : "settling"} style={{ background: r.stable ? C.ok : C.gold }} />}
          </span>
          <Btn small variant="gold" icon={ScaleIcon} disabled={!usable} onClick={() => onWeight(r.kg)}>{label}</Btn>
          {r && !r.overload && !r.stable && <span className="f-body text-[11px]" style={{ color: C.muted }}>settling…</span>}
          {usable === false && r && max != null && r.kg > max && <span className="f-body text-[11px]" style={{ color: C.danger }}>more than is available</span>}
        </>
      )}
      <button type="button" aria-label="Scale settings" onClick={() => setSettingsOpen(true)} className="p-1.5 rounded-lg hover:bg-stone-100"><Settings2 size={14} style={{ color: C.muted }} /></button>
      {s.status === "error" && s.error && <span className="f-body text-[11px] w-full" style={{ color: C.danger }}>{s.error}</span>}
    </div>
  );
}

function ScaleSettings({ onClose }) {
  const s = useScale();
  const [f, setF] = useState(s.settings);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Modal title="Scale settings" onClose={onClose}>
      <div className="space-y-4">
        <p className="f-body text-xs" style={{ color: C.muted }}>Match these to the scale's communication settings (in its manual, usually under “RS-232” or “COM”). Saved on this computer only.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Baud rate"><Select value={f.baudRate} onChange={set("baudRate")}>{[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>
          <Field label="Parity"><Select value={f.parity} onChange={set("parity")}><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></Select></Field>
          <Field label="Data bits"><Select value={f.dataBits} onChange={set("dataBits")}><option value={8}>8</option><option value={7}>7</option></Select></Field>
          <Field label="Stop bits"><Select value={f.stopBits} onChange={set("stopBits")}><option value={1}>1</option><option value={2}>2</option></Select></Field>
          <Field label="Weight unit if not sent"><Select value={f.unit} onChange={set("unit")}><option value="kg">kg</option><option value="g">g</option><option value="lb">lb</option></Select></Field>
          <Field label="Ask for weight" hint="Only if the scale stays silent"><Input value={f.poll} onChange={set("poll")} placeholder="e.g. W or P" maxLength={10} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn icon={Plug} onClick={async () => { await s.setSettings(f); onClose(); }}>Save</Btn>
          {s.status === "connected" && <Btn variant="ghost" icon={Unplug} onClick={async () => { await s.disconnect(); onClose(); }}>Disconnect scale</Btn>}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Export active products with PLUs formatted for electronic label scales:
 * TM-A (tmaEN3.0), Rongta RLS1000/1100, Arab, Malaysia, CAS, Aclas.
 */
export function exportScaleCsv(products = []) {
  const active = products.filter((p) => p.active !== false && p.plu);
  active.sort((a, b) => Number(a.plu) - Number(b.plu));
  const headers = ["LFCode", "Code", "Name", "UnitPrice", "Unit", "BarcodeType", "Department"];
  const rows = active.map((p) => [
    p.plu,
    p.sku || p.barcode || p.plu,
    `"${(p.name || "").replace(/"/g, '""')}"`,
    p.price || 0,
    p.unit === "KG" ? "kg" : "pcs",
    2, // EAN-13 starting with 2
    1, // Fresh Meat
  ]);
  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bladeos-scale-plus-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Export a readable plain-text cheat sheet of all PLUs for staff on the counter. */
export function exportPluTextSheet(products = []) {
  const active = products.filter((p) => p.active !== false && p.plu);
  active.sort((a, b) => Number(a.plu) - Number(b.plu));
  const lines = [
    "BLADEOS — SCALE PLU COUNTER CHEAT SHEET",
    "==========================================",
    "",
    "PLU    | Product Name                  | Unit | Price (NGN)",
    "-----------------------------------------------------------",
    ...active.map((p) => `${String(p.plu).padEnd(6)} | ${(p.name || "").padEnd(29)} | ${(p.unit || "").padEnd(4)} | ${(p.price || 0).toLocaleString("en-NG")}`),
    "",
    "Tip: Type the PLU directly on the scale keypad or POS search box."
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bladeos-plu-cheatsheet.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
