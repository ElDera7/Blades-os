// Devices on this POS terminal (receipt printer, cash drawer, barcode scanner, scale, customer screen)
// and the customer-facing display itself.
import React, { useEffect, useRef, useState } from "react";
import { Printer, ScanLine, Monitor, Plug, Check, Inbox, Scale as ScaleIcon, Info, Search, Download, FileText } from "lucide-react";
import { C } from "../lib/theme.js";
import { Btn, Modal, Field, Select, Input } from "../components/ui.jsx";
import { ScaleReader, useScale, exportScaleCsv, exportPluTextSheet } from "../lib/scale.jsx";
import {
  loadDevices, saveDevices, serialSupported, usbSupported, choosePrinterPort, pairUsbPrinter, detectPrinter, watchHardware,
  markScannerSeen, scannerSeenAt, clearHelperQueue, printBlocks, testBlocks, openDrawer, openCustomerDisplay, customerDisplay,
} from "../lib/hardware.js";

/** The printer this till will use right now, kept up to date as cables go in and out. */
export function usePrinterStatus({ fresh = false } = {}) {
  const [p, setP] = useState(null);
  const [scanAt, setScanAt] = useState(scannerSeenAt);
  useEffect(() => {
    let live = true, first = fresh;
    const check = () => { detectPrinter({ fresh: first }).then((x) => live && setP(x)).catch(() => {}); first = false; setScanAt(scannerSeenAt()); };
    check();
    const off = watchHardware(check);
    return () => { live = false; off(); };
  }, []);
  return { printer: p, scannerAt: scanAt };
}

/** POS header: printer, scanner and scale at a glance. Tapping opens Devices. */
export function HardwareStatus({ onOpen }) {
  const { printer, scannerAt } = usePrinterStatus();
  const scale = useScale();
  const dot = (ok) => <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: ok ? C.ok : C.gold }} />;
  const stuck = printer?.kind === "helper" && (printer.jobs > 0 || printer.offline);
  const pText = !printer ? "Printer…" : printer.kind === "none" ? "Printer: helper off"
    : stuck ? (printer.offline ? "Printer offline" : `Printer: ${printer.jobs} waiting`)
    : printer.direct ? `Printer: ${printer.kind === "helper" ? "ready" : printer.kind === "usb" ? "USB" : "COM"} ✓` : "Printer: Windows";

  const scaleConnected = scale?.status === "connected";
  const scaleWeight = scale?.reading?.kg != null ? `${scale.reading.kg.toFixed(3)} kg` : null;
  const sText = !scale?.supported ? null : scaleConnected ? `Scale: ${scaleWeight || "ready"} ✓` : "Scale: tap to connect";

  return (
    <button onClick={onOpen} data-hw-status title={printer ? `${printer.name}${printer.direct ? " — connected directly" : " — prints through Windows"}` : ""}
      className="hidden sm:flex items-center gap-3 h-8 px-3 rounded-lg border f-body text-xs hover:bg-stone-50 active:scale-95 transition-all" style={{ borderColor: C.border, color: C.ink }}>
      <span className="flex items-center gap-1.5" data-hw-printer={printer?.kind || ""} data-hw-stuck={stuck ? "1" : ""} style={stuck || printer?.kind === "none" ? { color: C.danger } : undefined}>{dot(!!printer && !stuck && printer.kind !== "none")}<Printer size={13} />{pText}</span>
      <span className="flex items-center gap-1.5" data-hw-scanner={scannerAt ? "seen" : ""}>{dot(!!scannerAt)}<ScanLine size={13} />{scannerAt ? "Scanner ✓" : "Scanner: scan to check"}</span>
      {sText && (
        <span className="flex items-center gap-1.5" style={{ color: scaleConnected ? C.ok : C.muted }}>
          {dot(scaleConnected)}
          <ScaleIcon size={13} />
          {sText}
        </span>
      )}
    </button>
  );
}

const Section = ({ icon: Icon, title, children }) => (
  <section className="rounded-xl p-4 space-y-3" style={{ background: C.cream }}>
    <h4 className="f-body text-sm font-semibold flex items-center gap-2" style={{ color: C.ink }}><Icon size={15} style={{ color: C.burgundy }} />{title}</h4>
    {children}
  </section>
);
const Hint = ({ children }) => <p className="f-body text-[11px] flex gap-1.5" style={{ color: C.muted }}><Info size={12} className="shrink-0 mt-0.5" />{children}</p>;
const Toggle = ({ checked, onChange, label }) => (
  <label className="flex items-center gap-2 f-body text-sm" style={{ color: C.ink }}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
  </label>
);

/** What a scanned code means at this till (barcode, scale label, PLU) — shared with the POS. */
export function describeCode(code, inventory = [], profile = {}) {
  const c = String(code).trim();
  const p = inventory.find((x) => x.barcode && x.barcode === c);
  if (p) return `Product barcode → ${p.name}`;
  if (/^2\d{12}$/.test(c)) {
    const d = c.split("").map(Number);
    const ok = (10 - (d.slice(0, 12).reduce((s, x, i) => s + x * (i % 2 ? 3 : 1), 0) % 10)) % 10 === d[12];
    if (!ok) return "Scale label with a bad check digit — reprint the label";
    const plu = Number(c.slice(2, 7)), v = Number(c.slice(7, 12));
    const q = inventory.find((x) => x.plu === plu);
    return q ? `Scale label → ${q.name}, ${profile.scaleLabel === "price" ? `₦${v.toLocaleString("en-NG")}` : `${(v / 1000).toFixed(3)} KG`}` : `Scale label for PLU ${plu} — no product has that PLU`;
  }
  if (/^\d{1,5}$/.test(c)) { const q = inventory.find((x) => x.plu === Number(c)); return q ? `PLU → ${q.name}` : `No product has PLU ${c}`; }
  if (/^\d{8,14}$/.test(c)) return "A barcode no product has yet — add it in Business Setup → Products";
  return "Not a product code";
}

export function DevicesModal({ inventory, profile, onClose }) {
  const [d, setD] = useState(loadDevices);
  const { printer } = usePrinterStatus({ fresh: true });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const set = (patch) => { const next = { ...d, ...patch }; setD(next); saveDevices(next); };
  const say = (ok, text) => setMsg({ ok, text });
  const run = async (key, fn) => { setBusy(key); setMsg(null); try { await fn(); } finally { setBusy(null); } };

  // Scanner test: how fast the characters came and what ended the code tells us it's a scanner, and how it's set up.
  const [scan, setScan] = useState(null);
  const buf = useRef({ chars: "", times: [] });
  const timer = useRef(null);
  const finish = (suffix) => {
    const { chars, times } = buf.current;
    if (!chars) return;
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const avg = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : 0;
    const scanner = chars.length >= 4 && avg < 40;
    if (scanner) markScannerSeen();
    setScan({ code: chars, suffix, avg: Math.round(avg), scanner, meaning: describeCode(chars, inventory, profile) });
    buf.current = { chars: "", times: [] };
  };
  const onScanKey = (e) => {
    clearTimeout(timer.current);
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); finish(e.key === "Enter" ? "Enter" : "Tab"); return; }
    if (e.key.length !== 1) return;
    e.preventDefault();
    buf.current.chars += e.key; buf.current.times.push(performance.now());
    timer.current = setTimeout(() => finish("none"), 250);
  };

  return (
    <Modal title="Devices on this till" onClose={onClose} wide>
      <div className="space-y-4">
        <p className="f-body text-xs" style={{ color: C.muted }}>Saved on this terminal only. Set it up once per till.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
          <Field label="Till number" hint="On offline receipts (T1-000123)">
            <Input mono value={d.tillNo ?? "1"} maxLength={4} onChange={(e) => set({ tillNo: e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 4) })} aria-label="Till number" />
          </Field>
        </div>

        <Section icon={Printer} title="Receipt printer">
          <div className="rounded-lg p-3 bg-white f-body text-sm flex items-center gap-2" data-printer-found={printer?.kind || ""} style={{ color: C.ink }}>
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: printer?.direct ? C.ok : C.gold }} />
            {!printer ? "Looking for the printer…"
              : printer.kind === "helper" ? <span><b>{printer.name}</b> through the BladeOS printer helper{printer.port ? ` (${printer.port})` : ""} — prints, cuts and opens the drawer with no dialog.{printer.offline ? " Windows says it's offline: check the power and USB cable." : printer.jobs > 0 ? ` ${printer.jobs} receipt${printer.jobs > 1 ? "s are" : " is"} stuck in the queue.` : ""}</span>
              : printer.kind === "none" ? <span><b>The BladeOS printer helper isn't running.</b> Close BladeOS and open it again from the BladeOS POS icon.</span>
              : printer.direct
              ? <span><b>{printer.name}</b> found on {printer.kind === "usb" ? "USB" : "a COM port"} — BladeOS prints, cuts and opens the drawer directly.</span>
              : <span><b>Printing through Windows</b> (the default printer). On a Windows till, get the BladeOS POS icon (account menu → Desktop icon): it fixes the printer and prints without the browser.</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Connected as">
              <Select value={d.printMode} onChange={(e) => set({ printMode: e.target.value })} aria-label="Printer connection">
                <option value="auto">Find automatically (recommended)</option>
                <option value="helper">BladeOS printer helper (Windows till)</option>
                <option value="usb" disabled={!usbSupported()}>USB, direct (ESC/POS)</option>
                <option value="escpos" disabled={!serialSupported()}>COM port (ESC/POS)</option>
                <option value="browser">Windows printer (driver)</option>
              </Select>
            </Field>
            <Field label="Paper"><Select value={d.paper} onChange={(e) => set({ paper: Number(e.target.value) })} aria-label="Paper width"><option value={80}>80 mm</option><option value={58}>58 mm</option></Select></Field>
            <Field label="Copies per sale"><Select value={d.copies} onChange={(e) => set({ copies: Number(e.target.value) })} aria-label="Copies"><option value={1}>1</option><option value={2}>2 (customer + shop)</option></Select></Field>
          </div>
          <Toggle checked={d.autoPrint} onChange={(v) => set({ autoPrint: v })} label="Print the receipt automatically when a sale completes" />
          {d.printMode !== "browser" && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              {(d.printMode === "escpos" || printer?.kind === "serial") && <Field label="COM speed (baud)"><Select value={d.printerBaud} onChange={(e) => set({ printerBaud: Number(e.target.value) })} aria-label="Printer baud">
                {[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>}
              <Toggle checked={d.drawerOnCash} onChange={(v) => set({ drawerOnCash: v })} label="Open drawer on cash" />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {printer?.kind === "helper" && (printer.jobs > 0 || printer.offline) && (
              <Btn small variant="ghost" busy={busy === "clear"} onClick={() => run("clear", async () => {
                try { const r = await clearHelperQueue(); say(true, `Cleared ${r.removed ?? 0} stuck receipt${r.removed === 1 ? "" : "s"}. Check the printer is on and has paper, then print a test page.`); }
                catch { say(false, "Couldn't reach the printer helper."); }
              })}>Clear stuck receipts</Btn>
            )}
            {d.printMode !== "browser" && d.printMode !== "helper" && printer?.kind !== "helper" && (usbSupported() || serialSupported()) && (
              <Btn small variant="ghost" icon={Search} busy={busy === "find"} onClick={() => run("find", async () => {
                // USB first (the browser shows only printers); a printer that isn't on USB is on a COM port.
                if (usbSupported() && d.printMode !== "escpos") {
                  try { const name = await pairUsbPrinter(); say(true, `${name} connected. It reconnects by itself from now on.`); return; }
                  catch (e) { if (e?.name !== "NotFoundError") { say(false, e.message); return; } }
                }
                if (serialSupported()) {
                  try { const info = await choosePrinterPort(); set({ printerPort: info }); say(true, "Printer port saved. It reconnects by itself from now on."); }
                  catch (e) { if (e?.name !== "NotFoundError") say(false, e.message); else say(false, "No printer chosen. Check it's switched on and plugged in, or leave it on Windows printing."); }
                }
              })}>Find printer</Btn>
            )}
            <Btn small icon={Printer} busy={busy === "test"} onClick={() => run("test", async () => {
              const r = await printBlocks(testBlocks(profile), { title: "Printer test", copies: 1 });
              say(r.ok, r.ok ? `Test page sent${r.via === "helper" ? " through the printer helper" : r.via === "usb" ? " over USB" : r.via === "serial" ? " to the COM port" : " to the Windows printer"}.` : r.error);
            })}>Print test page</Btn>
            <Btn small variant="ghost" icon={Inbox} busy={busy === "drawer"} onClick={() => run("drawer", async () => {
              const r = await openDrawer(); say(r.ok, r.ok ? "Drawer kick sent." : r.error);
            })}>Open cash drawer</Btn>
          </div>
          <Hint>Windows till (e.g. Licon with LP100): get the icon from the account menu → Desktop icon and run it once. It repairs the printer's port, clears stuck jobs, installs the BladeOS printer helper and prints a test receipt. Without it, printing goes through Windows and the browser.</Hint>
        </Section>

        <Section icon={ScanLine} title="Barcode scanner">
          <Hint>USB and Bluetooth scanners type like a keyboard — no driver, no setup. BladeOS recognises the scanner the first time anything is scanned at the POS. To check it here, click the box and scan anything.</Hint>
          <input onKeyDown={onScanKey} readOnly aria-label="Scanner test" placeholder="Click here, then scan a barcode"
            className="f-mono w-full text-sm rounded-lg px-3 py-2.5 border outline-none focus:ring-2 bg-white" style={{ borderColor: C.input, "--tw-ring-color": C.goldLight }} />
          {scan && (
            <div className="rounded-lg p-3 f-body text-xs space-y-1 bg-white" data-scan-result>
              <div className="f-mono text-sm font-semibold" style={{ color: C.ink }}>{scan.code}</div>
              <div style={{ color: scan.scanner ? C.ok : C.gold }}>
                {scan.scanner ? `Scanner detected (${scan.avg} ms per character)` : `That looked like typing (${scan.avg} ms per character)`} · ends with {scan.suffix === "none" ? "no Enter" : scan.suffix}
              </div>
              <div style={{ color: C.ink }}>{scan.meaning}</div>
              {scan.suffix === "none" && <div style={{ color: C.muted }}>Works — the till spots the end of the code by the pause. Programming the scanner to send Enter is faster.</div>}
            </div>
          )}
          <Field label="Scanner sends after each code">
            <Select value={d.scannerSuffix} onChange={(e) => set({ scannerSuffix: e.target.value })} aria-label="Scanner suffix">
              <option value="auto">Detect automatically</option><option value="enter">Enter</option><option value="tab">Tab</option><option value="none">Nothing</option>
            </Select>
          </Field>
        </Section>

        <Section icon={ScaleIcon} title="Scale">
          <Hint>Connect a counter scale via USB/COM port for live weights on the POS, or sync PLUs to your barcode-printing scale (TM-A, Rongta, Arab, Malaysia, CAS).</Hint>
          <div className="space-y-3">
            <div className="p-3 bg-white rounded-lg border flex flex-col sm:flex-row sm:items-center justify-between gap-3" style={{ borderColor: C.border }}>
              <div>
                <div className="f-body text-xs font-semibold" style={{ color: C.ink }}>Direct USB / COM Counter Scale</div>
                <div className="f-body text-xs" style={{ color: C.muted }}>Streams live weight directly into the POS screen when weighing meat cuts.</div>
              </div>
              <ScaleReader onWeight={(kg) => say(true, `Scale reads ${kg.toFixed(3)} kg.`)} label="Read weight" />
            </div>

            <div className="p-3 bg-white rounded-lg border space-y-2.5" style={{ borderColor: C.border }}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="f-body text-xs font-semibold" style={{ color: C.ink }}>Electronic Barcode Scale Sync (TM-A / Rongta / Arab / Malaysia)</div>
                  <div className="f-body text-xs" style={{ color: C.muted }}>Sync product PLUs and prices into your scale software so printed sticker labels scan at the POS.</div>
                </div>
                <div className="flex gap-2">
                  <Btn small variant="gold" icon={Download} onClick={() => { exportScaleCsv(inventory); say(true, "Scale PLU CSV exported. Import it into your TM-A scale software."); }}>Download PLU CSV (TM-A)</Btn>
                  <Btn small variant="ghost" icon={FileText} onClick={() => { exportPluTextSheet(inventory); say(true, "PLU Cheat Sheet downloaded."); }}>PLU Cheat Sheet</Btn>
                </div>
              </div>
              <div className="rounded p-2 text-[11px] space-y-1 font-mono" style={{ background: C.cream2, color: C.ink }}>
                <p className="font-semibold text-[11px]">How to sync with your scale software (tmaEN3.0 / Arab2.0.2):</p>
                <p>1. Click <b>Download PLU CSV</b> above.</p>
                <p>2. Open <b>tmaEN3.0.exe</b> on this computer.</p>
                <p>3. Go to <b>PLU Management</b> &rarr; <b>Import</b> &rarr; choose the downloaded CSV file.</p>
                <p>4. Click <b>Download to Scale</b> (via IP or COM). Your scale is now in sync with BladeOS!</p>
              </div>
            </div>
          </div>
        </Section>

        <Section icon={Monitor} title="Customer screen">
          <Hint>Shows the customer each item, the total and their change. On a two-screen terminal it opens on the second screen (allow “window placement” when asked); otherwise drag the window across and press F11.</Hint>
          <Btn small icon={Monitor} onClick={async () => { const ok = await openCustomerDisplay(); say(ok, ok ? "Customer screen opened." : "Allow pop-ups for BladeOS, then try again."); }}>Open customer screen</Btn>
        </Section>

        {msg && <p role="status" className="f-body text-sm" style={{ color: msg.ok ? C.ok : C.danger }}>{msg.ok && <Check size={14} className="inline mr-1" />}{msg.text}</p>}
      </div>
    </Modal>
  );
}

/* ============================================================ customer-facing display */
const naira = (v) => "₦" + Math.round(v || 0).toLocaleString("en-NG");
export function CustomerDisplay() {
  const [s, setS] = useState({ type: "idle" });
  const [profile, setProfile] = useState({});
  const doneTimer = useRef(null);
  useEffect(() => {
    document.title = "Customer display";
    const off = customerDisplay.listen((m) => {
      if (!m || !m.type || m.type === "hello") return;
      if (m.profile) setProfile(m.profile);
      // Keep "Thank you / your change" up until the next customer's first item (or 15 s), even after the till clears.
      const emptyTicket = m.type === "ticket" && !(m.lines || []).length;
      setS((prev) => (prev.type === "done" && emptyTicket ? prev : m));
      if (m.type === "done") { clearTimeout(doneTimer.current); doneTimer.current = setTimeout(() => setS({ type: "idle" }), 15000); }
      else if (!emptyTicket) clearTimeout(doneTimer.current);
    });
    customerDisplay.send({ type: "hello" });
    return off;
  }, []);
  const lines = s.lines || [];
  return (
    <div className="min-h-screen flex flex-col f-body select-none" style={{ background: C.charcoal, color: C.cream, cursor: "none" }} data-customer-display>
      <header className="px-8 py-5 flex items-center justify-between border-b" style={{ borderColor: C.charcoal3 }}>
        <div>
          <div className="f-display text-3xl" style={{ color: C.cream }}>{profile.name || "Blades & Butchers"}</div>
          {profile.tagline && <div className="text-sm uppercase tracking-widest" style={{ color: C.goldLight }}>{profile.tagline}</div>}
        </div>
        {s.customer && <div className="text-lg" style={{ color: C.mutedLight }}>Welcome, {s.customer}</div>}
      </header>

      {s.type === "idle" || (s.type === "ticket" && !lines.length) ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <div className="f-display text-5xl mb-4">Welcome</div>
          <div className="text-xl" style={{ color: C.mutedLight }}>Fresh from our ranch to your table.</div>
        </div>
      ) : s.type === "done" ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8" data-cd-done>
          <div className="text-xl uppercase tracking-widest mb-2" style={{ color: C.goldLight }}>{s.change ? "Your change" : "Paid"}</div>
          <div className="f-mono text-7xl font-bold mb-6" style={{ color: "#fff" }}>{naira(s.change || s.total)}</div>
          <div className="f-display text-3xl">Thank you!</div>
          {profile.receiptFooter && <div className="text-lg mt-2" style={{ color: C.mutedLight }}>{profile.receiptFooter}</div>}
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-5 min-h-0">
          <div className="col-span-3 overflow-hidden px-8 py-4">
            {lines.slice(-9).map((l, i) => (
              <div key={i} className="flex items-baseline justify-between gap-4 py-2.5 border-b" style={{ borderColor: C.charcoal3 }}>
                <div className="min-w-0">
                  <div className="text-xl truncate">{l.name}</div>
                  <div className="f-mono text-sm" style={{ color: C.mutedLight }}>{l.qty} × {naira(l.price)}{l.discount ? ` · −${naira(l.discount)}` : ""}</div>
                </div>
                <div className="f-mono text-xl shrink-0">{naira(l.total)}</div>
              </div>
            ))}
            {lines.length > 9 && <div className="text-sm pt-2" style={{ color: C.mutedLight }}>+ {lines.length - 9} more above</div>}
          </div>
          <div className="col-span-2 flex flex-col justify-center px-8 py-6 space-y-3" style={{ background: C.charcoal2 }}>
            <div className="flex justify-between text-lg"><span style={{ color: C.mutedLight }}>Subtotal</span><span className="f-mono">{naira(s.gross)}</span></div>
            {s.discount > 0 && <div className="flex justify-between text-lg"><span style={{ color: C.goldLight }}>You save</span><span className="f-mono" style={{ color: C.goldLight }}>−{naira(s.discount)}</span></div>}
            {s.tax > 0 && <div className="flex justify-between text-sm"><span style={{ color: C.mutedLight }}>VAT included</span><span className="f-mono">{naira(s.tax)}</span></div>}
            <div className="pt-3 border-t" style={{ borderColor: C.charcoal3 }}>
              <div className="text-sm uppercase tracking-widest" style={{ color: C.goldLight }}>{s.type === "pay" ? (s.paid ? "Left to pay" : "Amount to pay") : "Total"}</div>
              <div className="f-mono text-6xl font-bold" style={{ color: "#fff" }} data-cd-total>{naira(s.type === "pay" ? s.due : s.total)}</div>
              {s.type === "pay" && s.paid > 0 && <div className="text-sm mt-1" style={{ color: C.mutedLight }}>Paid so far {naira(s.paid)}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
