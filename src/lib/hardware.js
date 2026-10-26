// Counter hardware for a Windows POS terminal (e.g. Licon all-in-one + Licon LP100 80 mm thermal printer,
// cash drawer on the printer's RJ11 port, USB barcode scanner, optional scale).
//
// Receipt printer — found automatically ("auto", the default). At print time BladeOS uses the first that works:
//   0. Helper       the BladeOS print helper on a Windows till (installed by the Desktop-icon setup, listens on
//                   127.0.0.1 only). BladeOS sends ESC/POS; the helper hands it RAW to the Windows printer queue.
//                   Works whatever driver Windows has, cuts, prints the QR code, kicks the drawer, no dialog.
//   1. USB direct   an ESC/POS printer on USB (WebUSB, printer class 7) — auto-cut, QR code, drawer kick.
//   2. COM port     an ESC/POS printer on a COM / virtual-COM port (Web Serial: USB-serial, RS-232, Bluetooth SPP).
//   3. Windows      the Windows default printer through its driver (prints through a hidden frame; silent with the
//                   BladeOS till icon, which starts the browser with --kiosk-printing). The driver opens the drawer.
// A printer the browser was allowed to use once (one tap on "Find printer") reconnects by itself whenever it's
// plugged in. On Windows, when the Licon driver owns the USB port, direct USB is refused and step 3 takes over.
//
// Barcode scanner — USB/Bluetooth scanners type like a keyboard. A burst of fast keystrokes is a scan, so the
// scanner is detected the first time anything is scanned; no setup.
// Settings are per terminal (this browser), not per user.
import QRCode from "qrcode";

const KEY = "bladeos.devices";
export const DEFAULT_DEVICES = {
  v: 2,
  printMode: "auto",             // "auto" | "helper" | "usb" | "escpos" (COM port) | "browser" (Windows driver)
  paper: 80,                     // 80 | 58 (mm)
  autoPrint: true,               // print a receipt when a sale completes
  copies: 1,
  drawerOnCash: true,            // ESC/POS mode: open the drawer for cash sales and cash refunds
  printerBaud: 9600,
  printerPort: null,             // { usbVendorId, usbProductId } of the chosen COM port
  scannerSuffix: "auto",         // "auto" | "enter" | "tab" | "none" — what the scanner sends after the code
  tillNo: "1",                   // this till's number, printed on receipts made offline (T1-000123)
};
export function loadDevices() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY)) || {};
    // Tills set up before auto-detection had "browser" as the default: move them to automatic.
    if (!saved.v && saved.printMode === "browser") saved.printMode = "auto";
    return { ...DEFAULT_DEVICES, ...saved, v: 2 };
  } catch { return { ...DEFAULT_DEVICES }; }
}
export function saveDevices(d) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* private window: lasts this session */ }
  window.dispatchEvent(new CustomEvent("bladeos-devices", { detail: d }));
}

/* ======================================================================= serial ports by role */
// Remember which physical port is which, so the printer and the scale never grab each other's port.
const ROLE_KEY = "bladeos.ports";
const portInfo = (p) => { try { const i = p.getInfo(); return { usbVendorId: i.usbVendorId ?? null, usbProductId: i.usbProductId ?? null }; } catch { return {}; } };
const same = (a, b) => a && b && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
function roles() { try { return JSON.parse(localStorage.getItem(ROLE_KEY)) || {}; } catch { return {}; } }
export function rememberPort(role, port) {
  const r = roles(); r[role] = portInfo(port);
  try { localStorage.setItem(ROLE_KEY, JSON.stringify(r)); } catch { /* ignore */ }
}
export function forgetRole(role) {
  const r = roles(); delete r[role];
  try { localStorage.setItem(ROLE_KEY, JSON.stringify(r)); } catch { /* ignore */ }
}
/** A previously allowed port for this role — never one that belongs to another role. */
export async function portFor(role) {
  if (!("serial" in navigator)) return null;
  const ports = await navigator.serial.getPorts();
  const r = roles();
  const mine = ports.find((p) => same(portInfo(p), r[role]));
  if (mine) return mine;
  if (r[role]) return null;
  // Nothing recorded for this role yet (older install): take a port no other role has claimed.
  const others = Object.entries(r).filter(([k]) => k !== role).map(([, v]) => v);
  return ports.find((p) => !others.some((o) => same(portInfo(p), o))) ?? null;
}

/* ======================================================================= receipt layout */
// One layout, two renderers (HTML for the browser path, ESC/POS for serial printers).
// Blocks: {t:"title"|"center"|"text"|"row"|"total"|"rule"|"qr"|"badge", ...}
const n = (v) => "₦" + Math.round(v || 0).toLocaleString("en-NG");
const qtyTxt = (q, unit) => (unit === "KG" ? `${Number(q).toLocaleString("en-NG", { maximumFractionDigits: 3 })} KG` : `${Number(q).toLocaleString("en-NG")} ${unit}`);

export function receiptBlocks(profile = {}, r, { copy = false } = {}) {
  const when = (r.at instanceof Date ? r.at : new Date(r.at)).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const b = [{ t: "title", text: profile.name || "Blades & Butchers" }];
  if (profile.tagline) b.push({ t: "center", text: profile.tagline });
  if (profile.address) b.push({ t: "center", text: profile.address });
  if (profile.phone) b.push({ t: "center", text: `Tel ${profile.phone}` });
  if (profile.tin) b.push({ t: "center", text: `TIN ${profile.tin}` });
  if (copy) b.push({ t: "badge", text: "COPY - REPRINT" });
  b.push({ t: "rule" },
    { t: "row", left: "Receipt", right: r.code }, { t: "row", left: "Date", right: when },
    { t: "row", left: "Served by", right: r.cashier || "" }, { t: "row", left: "Customer", right: r.customer || "Walk-in" }, { t: "rule" });
  for (const l of r.lines) {
    b.push({ t: "row", left: `${l.name}${l.vat ? " *" : ""}`, right: n(l.total), bold: true });
    b.push({ t: "text", text: `  ${qtyTxt(l.qty, l.unit)} x ${n(l.price)}` });
    if (l.discount) b.push({ t: "text", text: `  Discount -${n(l.discount)}` });
  }
  b.push({ t: "rule" }, { t: "row", left: "Subtotal", right: n(r.gross) });
  if (r.discount) b.push({ t: "row", left: "Discount", right: `-${n(r.discount)}` });
  b.push({ t: "total", left: "TOTAL", right: n(r.total) });
  if (r.tax) b.push({ t: "row", left: "VAT included (*)", right: n(r.tax) });
  b.push({ t: "rule" });
  if (r.later) b.push({ t: "row", left: "PAYMENT PENDING", right: "", bold: true });
  for (const t of r.tenders || []) b.push({ t: "row", left: `${t.method}${t.tendered && t.tendered !== t.amount ? " tendered" : ""}${t.ref ? ` (${t.ref})` : ""}`, right: n(t.tendered || t.amount) });
  if (r.change) b.push({ t: "total", left: "CHANGE", right: n(r.change) });
  b.push({ t: "qr", data: r.code }, { t: "center", text: profile.receiptFooter || "Thank you!" }, { t: "center", text: "Keep this receipt for refunds." });
  return b;
}

export function reportBlocks(r) {
  const b = [{ t: "title", text: `${r.type} REPORT` },
    { t: "row", left: "Till", right: r.code }, { t: "row", left: "Cashier", right: r.cashier }, { t: "row", left: "Opened", right: r.openedAt }];
  if (r.closedAt) b.push({ t: "row", left: "Closed", right: r.closedAt });
  b.push({ t: "row", left: "Printed", right: r.printedAt }, { t: "rule" },
    { t: "row", left: "Sales", right: String(r.sales.count) }, { t: "row", left: "Gross", right: n(r.sales.gross) },
    { t: "row", left: "Discounts", right: `-${n(r.sales.discounts)}` }, { t: "total", left: "Net sales", right: n(r.sales.net) },
    { t: "row", left: "VAT included", right: n(r.sales.tax) }, { t: "rule" }, { t: "text", text: "Tenders", bold: true });
  for (const t of r.tenders) b.push({ t: "row", left: `${t.method} (${t.orders})`, right: n(t.amount) });
  b.push({ t: "text", text: "Refunds", bold: true });
  if (!r.refunds.length) b.push({ t: "text", text: "  None" });
  for (const t of r.refunds) b.push({ t: "row", left: t.method, right: `-${n(t.amount)}` });
  for (const d of r.discountsByReason || []) b.push({ t: "row", left: `Disc: ${d.reason} (${d.n})`, right: n(d.amount) });
  b.push({ t: "row", left: "Cleared tickets", right: `${r.voided.tickets} (${n(r.voided.value)})` });
  if (r.cash) {
    b.push({ t: "rule" }, { t: "row", left: "Float", right: n(r.cash.float) }, { t: "row", left: "Cash taken", right: n(r.cash.cashIn) },
      { t: "row", left: "Cash refunds", right: `-${n(r.cash.cashOut)}` }, { t: "total", left: "Expected in drawer", right: n(r.cash.expected) });
    if (r.cash.counted != null) b.push({ t: "row", left: "Counted", right: n(r.cash.counted) }, { t: "row", left: "Variance", right: n(r.cash.variance) });
  }
  return b;
}

export function testBlocks(profile = {}) {
  return [{ t: "title", text: profile.name || "Blades & Butchers" }, { t: "center", text: "PRINTER TEST" }, { t: "rule" },
    { t: "row", left: "Left text", right: "Right text" }, { t: "row", left: "Naira sign", right: "₦12,345" },
    { t: "total", left: "BIG TOTAL", right: "₦99,999" }, { t: "rule" }, { t: "qr", data: "BLADEOS-TEST" },
    { t: "center", text: "If this prints cleanly, receipts are ready." }];
}

/* ---------------------------------------------------------------- HTML renderer */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export async function blocksToHtml(blocks, { paper = 80, title = "Receipt" } = {}) {
  const width = paper === 58 ? 48 : 72;
  const parts = [];
  for (const k of blocks) {
    if (k.t === "title") parts.push(`<h1>${esc(k.text)}</h1>`);
    else if (k.t === "center") parts.push(`<p class="c">${esc(k.text)}</p>`);
    else if (k.t === "badge") parts.push(`<div class="badge">${esc(k.text)}</div>`);
    else if (k.t === "text") parts.push(`<div class="${k.bold ? "b" : ""}">${esc(k.text).replace(/^ {2}/, "&nbsp;&nbsp;")}</div>`);
    else if (k.t === "row") parts.push(`<div class="row${k.bold ? " b" : ""}"><span>${esc(k.left)}</span><span>${esc(k.right)}</span></div>`);
    else if (k.t === "total") parts.push(`<div class="row t"><span>${esc(k.left)}</span><span>${esc(k.right)}</span></div>`);
    else if (k.t === "rule") parts.push(`<div class="hr"></div>`);
    else if (k.t === "qr") {
      try { parts.push(`<img alt="" width="90" height="90" src="data:image/svg+xml;utf8,${encodeURIComponent(await QRCode.toString(k.data, { type: "svg", margin: 0 }))}">`); } catch { /* skip */ }
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{size:${paper}mm auto;margin:0}*{box-sizing:border-box}
    body{font-family:ui-monospace,Menlo,Consolas,"Courier New",monospace;font-size:${paper === 58 ? 10.5 : 12}px;width:${width}mm;margin:0 auto;padding:4px 2px 10px;color:#000}
    h1{font-size:${paper === 58 ? 14 : 16}px;text-align:center;margin:2px 0}.c{text-align:center;margin:1px 0}.b{font-weight:bold}
    .row{display:flex;justify-content:space-between;gap:6px}.row span:last-child{text-align:right;white-space:nowrap}
    .t{font-size:${paper === 58 ? 13 : 15}px;font-weight:bold;margin:3px 0}.hr{border-top:1px dashed #000;margin:5px 0}
    .badge{font-weight:bold;text-align:center;border:1px solid #000;padding:2px;margin:4px 0}img{display:block;margin:6px auto}
  </style></head><body>${parts.join("")}</body></html>`;
}

/** Print HTML through a hidden frame (no pop-up blockers; silent with --kiosk-printing). */
export function printHtml(html) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(f);
    // Hand the keyboard straight back to the till: otherwise Enter (next sale) and the barcode scanner's keystrokes
    // would go to the hidden receipt frame until it's removed.
    let finished = false;
    const done = () => { if (finished) return; finished = true; try { window.focus(); document.activeElement?.blur?.(); } catch { /* */ } setTimeout(() => { f.remove(); resolve(true); }, 300); };
    const d = f.contentWindow.document;
    d.open(); d.write(html); d.close();
    const go = () => {
      try {
        f.contentWindow.addEventListener("afterprint", done, { once: true });
        f.contentWindow.addEventListener("keydown", (e) => window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, bubbles: true })));
        f.contentWindow.focus();
        f.contentWindow.print();
        window.focus();   // print() returns once the job is sent (or straight away with silent kiosk printing)
      } catch { /* test environments */ }
      setTimeout(done, 1500); // some browsers never fire afterprint
    };
    const imgs = [...d.images];
    if (!imgs.length) setTimeout(go, 50);
    else {
      // Wait for the QR image, but never hold up the receipt for it.
      let started = false; const once = () => { if (!started) { started = true; setTimeout(go, 50); } };
      Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))).then(once);
      setTimeout(once, 800);
    }
  });
}

/* ---------------------------------------------------------------- ESC/POS renderer */
const ESC = 0x1b, GS = 0x1d;
/** Thermal printers' built-in fonts are 8-bit; spell the naira and fancy punctuation out. */
export const toPrinterText = (s) => String(s ?? "").replace(/₦/g, "N").replace(/[−–—]/g, "-").replace(/×/g, "x").replace(/·/g, "-")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/°/g, " deg").normalize("NFKD").replace(/[^\x20-\x7E]/g, "");

export function blocksToEscPos(blocks, { paper = 80, drawer = false } = {}) {
  const cols = paper === 58 ? 32 : 48;
  const out = [];
  const bytes = (...a) => out.push(...a);
  const txt = (s) => { for (const ch of toPrinterText(s)) out.push(ch.charCodeAt(0)); };
  const line = (s = "") => { txt(s); bytes(0x0a); };
  const wrap = (s, w) => { const words = toPrinterText(s).split(" "); const lines = []; let cur = "";
    for (const wd of words) { if ((cur + (cur ? " " : "") + wd).length > w) { if (cur) lines.push(cur); cur = wd.slice(0, w); } else cur += (cur ? " " : "") + wd; }
    if (cur) lines.push(cur); return lines.length ? lines : [""]; };
  const row = (l, r, w = cols) => {
    const R = toPrinterText(r).slice(0, w);
    if (R.length > w - 8) { wrap(l, w).forEach((x) => line(x)); line(" ".repeat(w - R.length) + R); return; } // long value: own line, right-aligned
    const L = wrap(l, w - R.length - 1);
    L.forEach((x, i) => line(i === L.length - 1 ? x + " ".repeat(Math.max(1, w - x.length - R.length)) + R : x));
  };
  bytes(ESC, 0x40, ESC, 0x74, 0x00);                         // init, code page 437
  if (drawer) bytes(ESC, 0x70, 0x00, 0x19, 0xfa);              // kick drawer pin 2 first, so it opens while printing
  for (const k of blocks) {
    if (k.t === "title") { bytes(ESC, 0x61, 1, GS, 0x21, 0x11, ESC, 0x45, 1); wrap(k.text, cols / 2).forEach((x) => line(x)); bytes(GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x61, 0); }
    else if (k.t === "center" || k.t === "badge") { bytes(ESC, 0x61, 1); if (k.t === "badge") bytes(ESC, 0x45, 1); wrap(k.text, cols).forEach((x) => line(x)); bytes(ESC, 0x45, 0, ESC, 0x61, 0); }
    else if (k.t === "text") {
      const indent = (/^ */.exec(k.text) || [""])[0];
      if (k.bold) bytes(ESC, 0x45, 1); wrap(k.text.trim(), cols - indent.length).forEach((x) => line(indent + x)); if (k.bold) bytes(ESC, 0x45, 0);
    }
    else if (k.t === "row") { if (k.bold) bytes(ESC, 0x45, 1); row(k.left, k.right); if (k.bold) bytes(ESC, 0x45, 0); }
    else if (k.t === "total") { bytes(ESC, 0x45, 1, GS, 0x21, 0x01); row(k.left, k.right); bytes(GS, 0x21, 0x00, ESC, 0x45, 0); }
    else if (k.t === "rule") line("-".repeat(cols));
    else if (k.t === "qr") {
      const d = [...toPrinterText(k.data)].map((c) => c.charCodeAt(0)); const len = d.length + 3;
      bytes(ESC, 0x61, 1,
        GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0,             // model 2
        GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, paper === 58 ? 5 : 6, // module size
        GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31,                // error correction M
        GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...d,
        GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, 0x0a, ESC, 0x61, 0);
    }
  }
  bytes(ESC, 0x64, 4, GS, 0x56, 0x42, 0x00);                    // feed and partial cut
  return new Uint8Array(out);
}
export const drawerKick = () => new Uint8Array([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);

/* ---------------------------------------------------------------- ESC/POS over Web Serial */
export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;
export async function choosePrinterPort() {
  const port = await navigator.serial.requestPort();
  rememberPort("printer", port);
  window.dispatchEvent(new Event("bladeos-hardware"));
  return portInfo(port);
}
async function writeSerial(bytes, baud) {
  const port = await portFor("printer");
  if (!port) throw new Error("No receipt printer port chosen — open Devices and pick the printer's COM port.");
  let opened = false;
  try {
    if (!port.writable) { await port.open({ baudRate: Number(baud) || 9600 }); opened = true; }
    const w = port.writable.getWriter();
    try { for (let i = 0; i < bytes.length; i += 1024) await w.write(bytes.slice(i, i + 1024)); } finally { w.releaseLock(); }
  } finally {
    if (opened) await port.close().catch(() => {});
  }
}

/* ---------------------------------------------------------------- ESC/POS through the BladeOS print helper */
export const HELPER_URL = "http://127.0.0.1:17777";
let helperCache = { at: 0, status: null };
const withTimeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
/** The helper's view of the printer: { ok, printer, port, jobs, offline } or null when there's no helper. */
export async function helperStatus({ fresh = false } = {}) {
  if (typeof fetch === "undefined") return null;
  if (!fresh && Date.now() - helperCache.at < 8000) return helperCache.status;
  let status = null;
  try {
    const r = await fetch(HELPER_URL + "/status", { signal: withTimeout(1200), cache: "no-store" });
    if (r.ok) status = await r.json();
  } catch { /* no helper on this computer */ }
  helperCache = { at: Date.now(), status };
  return status;
}
async function writeHelper(bytes) {
  let r;
  try {
    r = await fetch(HELPER_URL + "/print", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes, signal: withTimeout(10000) });
  } catch {
    helperCache = { at: 0, status: null };
    throw new Error("The BladeOS printer helper isn't running on this till — restart the till from the BladeOS POS icon.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || "The printer refused the receipt.");
  helperCache.at = 0;   // re-check the queue on the next status read
  return j;
}
/** Remove receipts stuck in the Windows queue (they never print once the printer is back, and block the rest). */
export async function clearHelperQueue() {
  const r = await fetch(HELPER_URL + "/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: withTimeout(8000) });
  const j = await r.json().catch(() => ({}));
  helperCache.at = 0;
  window.dispatchEvent(new Event("bladeos-hardware"));
  return j;
}

/* ---------------------------------------------------------------- ESC/POS over WebUSB */
export const usbSupported = () => typeof navigator !== "undefined" && "usb" in navigator;
const USB_KEY = "bladeos.usbPrinter";
const usbSaved = () => { try { return JSON.parse(localStorage.getItem(USB_KEY)); } catch { return null; } };
const isPrinterDevice = (d) => (d.deviceClass === 7) || (d.configurations || []).some((c) => c.interfaces.some((i) => i.alternates.some((a) => a.interfaceClass === 7)));
const usbName = (d) => [d.manufacturerName, d.productName].filter(Boolean).join(" ").trim() || "USB receipt printer";
let usbBlocked = false;    // Windows' own printer driver holds the port: print through Windows instead (this session)
let usbOut = null;         // { dev, ep } once opened

/** The allowed USB printer that is plugged in now (no prompt). */
export async function usbPrinter() {
  if (!usbSupported()) return null;
  const want = usbSaved();
  const devs = await navigator.usb.getDevices().catch(() => []);
  return devs.find((d) => want && d.vendorId === want.vendorId && d.productId === want.productId) || devs.find(isPrinterDevice) || null;
}
/** One tap, once per till: the browser lists only printers. Afterwards it reconnects on its own. */
export async function pairUsbPrinter() {
  // No class filter: many 80 mm printers (Licon, Xprinter-type) don't report the USB printer class.
  const dev = await navigator.usb.requestDevice({ filters: [] });
  try { localStorage.setItem(USB_KEY, JSON.stringify({ vendorId: dev.vendorId, productId: dev.productId, name: usbName(dev) })); } catch { /* ignore */ }
  usbBlocked = false; usbOut = null;
  window.dispatchEvent(new Event("bladeos-hardware"));
  return usbName(dev);
}
async function openUsb(dev) {
  if (usbOut?.dev === dev && dev.opened) return usbOut.ep;
  if (!dev.opened) await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);
  let pick = null;
  for (const i of dev.configuration.interfaces) {
    for (const a of i.alternates) {
      const ep = a.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (ep && (!pick || a.interfaceClass === 7)) pick = { i, a, ep };
    }
  }
  if (!pick) { usbOut = null; throw new Error("That USB device isn't a printer — tap Find printer and choose the receipt printer (e.g. LP100, POS-80, Printer)."); }
  if (!pick.i.claimed) await dev.claimInterface(pick.i.interfaceNumber);
  if (pick.i.alternates.length > 1) await dev.selectAlternateInterface(pick.i.interfaceNumber, pick.a.alternateSetting).catch(() => {});
  usbOut = { dev, ep: pick.ep.endpointNumber };
  return usbOut.ep;
}
async function writeUsb(bytes) {
  const dev = await usbPrinter();
  if (!dev) throw new Error("The USB receipt printer isn't connected — check the cable and power.");
  try {
    const ep = await openUsb(dev);
    for (let i = 0; i < bytes.length; i += 4096) await dev.transferOut(ep, bytes.slice(i, i + 4096));
  } catch (e) {
    usbOut = null;
    // Windows: the printer's driver owns the port. Not an error at the till — Windows prints instead.
    if (e?.name === "SecurityError" || e?.name === "NetworkError" || /access denied|claim/i.test(e?.message || "")) usbBlocked = true;
    throw e;
  }
}

/* ---------------------------------------------------------------- which printer, right now */
/**
 * What this till will print on: { kind: "usb" | "serial" | "windows", name, direct }.
 * Never prompts. Used by the POS status and by printBlocks in automatic mode.
 */
export async function detectPrinter({ fresh = false } = {}) {
  const d = loadDevices();
  const mode = d.printMode;
  if (mode === "auto" || mode === "helper") {
    const h = await helperStatus({ fresh });
    if (h?.ok) return { kind: "helper", name: h.printer || "Receipt printer", direct: true, jobs: h.jobs || 0, offline: !!h.offline, port: h.port };
    if (mode === "helper") return { kind: "none", name: "BladeOS printer helper not running", direct: false };
  }
  if ((mode === "auto" || mode === "usb") && !usbBlocked) {
    const dev = await usbPrinter().catch(() => null);
    if (dev) return { kind: "usb", name: usbSaved()?.name || usbName(dev), direct: true };
  }
  if ((mode === "auto" || mode === "escpos") && serialSupported()) {
    const r = roles();
    // Automatic mode only uses a port that was chosen as the printer (never the scale's).
    const port = (mode === "escpos" || r.printer) ? await portFor("printer").catch(() => null) : null;
    if (port) return { kind: "serial", name: "Receipt printer (COM port)", direct: true };
  }
  return { kind: "windows", name: usbBlocked ? "Windows printer (driver)" : "Windows default printer", direct: false, usbBlocked };
}

/** Calls back whenever a printer is plugged in or out, so the till's status updates by itself. */
export function watchHardware(cb) {
  const h = () => { usbOut = null; cb(); };
  const poll = setInterval(() => { if (document.visibilityState === "visible") cb(); }, 20000);   // helper queue / plugged in later
  const offs = [];
  for (const api of [usbSupported() && navigator.usb, serialSupported() && navigator.serial].filter(Boolean)) {
    try { api.addEventListener("connect", h); api.addEventListener("disconnect", h); offs.push(() => { api.removeEventListener("connect", h); api.removeEventListener("disconnect", h); }); } catch { /* ignore */ }
  }
  const ev = () => cb();
  window.addEventListener("bladeos-hardware", ev);
  window.addEventListener("bladeos-devices", ev);
  return () => { clearInterval(poll); offs.forEach((f) => f()); window.removeEventListener("bladeos-hardware", ev); window.removeEventListener("bladeos-devices", ev); };
}

/* ---------------------------------------------------------------- barcode scanner */
const SCAN_KEY = "bladeos.scannerSeen";
/** A scan was recognised (fast keystrokes): the scanner is connected. */
export function markScannerSeen() {
  try { localStorage.setItem(SCAN_KEY, String(Date.now())); } catch { /* ignore */ }
  window.dispatchEvent(new Event("bladeos-hardware"));
}
export const scannerSeenAt = () => { try { return Number(localStorage.getItem(SCAN_KEY)) || null; } catch { return null; } };

/* ---------------------------------------------------------------- one entry point for every printout */
/**
 * print(blocks, { title, cash, copies }) — prints on this terminal's receipt printer, found automatically
 * (or the way Devices says). Returns { ok, via, error? }. `cash` opens the drawer (direct printers; in Windows
 * mode the printer driver does it).
 */
export async function printBlocks(blocks, { title = "Receipt", cash = false, copies } = {}) {
  const d = loadDevices();
  const times = Math.max(1, Math.min(3, copies ?? d.copies ?? 1));
  const esc = (i) => blocksToEscPos(blocks, { paper: d.paper, drawer: cash && d.drawerOnCash && i === 0 });
  const viaWindows = async () => {
    const html = await blocksToHtml(blocks, { paper: d.paper, title });
    for (let i = 0; i < times; i++) await printHtml(html);
    return { ok: true, via: "windows" };
  };
  try {
    const p = await detectPrinter();
    if (p.kind === "none") throw new Error("The BladeOS printer helper isn't running — restart the till from the BladeOS POS icon, or set Devices → Connected as → Find automatically.");
    if (p.kind === "helper") {
      try { for (let i = 0; i < times; i++) await writeHelper(await esc(i)); window.dispatchEvent(new Event("bladeos-hardware")); return { ok: true, via: "helper" }; }
      catch (e) { if (d.printMode === "helper") throw e; /* helper went away: fall through to the browser */ }
    }
    if (p.kind === "usb") {
      try { for (let i = 0; i < times; i++) await writeUsb(await esc(i)); window.dispatchEvent(new Event("bladeos-hardware")); return { ok: true, via: "usb" }; }
      catch (e) { if (d.printMode === "usb" && !usbBlocked) throw e; window.dispatchEvent(new Event("bladeos-hardware")); }
    } else if (p.kind === "serial") {
      try { for (let i = 0; i < times; i++) await writeSerial(await esc(i), d.printerBaud); return { ok: true, via: "serial" }; }
      catch (e) { if (d.printMode === "escpos") throw e; }
    } else if (d.printMode === "usb" || d.printMode === "escpos") {
      throw new Error(d.printMode === "usb" ? "The USB receipt printer isn't connected — check the cable, or tap Find printer in Devices." : "No receipt printer port chosen — open Devices and pick the printer's COM port.");
    }
    return await viaWindows();
  } catch (e) {
    return { ok: false, error: e?.message || "Printing failed." };
  }
}
export async function openDrawer() {
  const d = loadDevices();
  const p = await detectPrinter();
  try {
    if (p.kind === "helper") { await writeHelper(drawerKick()); return { ok: true }; }
    if (p.kind === "usb") { await writeUsb(drawerKick()); return { ok: true }; }
    if (p.kind === "serial") { await writeSerial(drawerKick(), d.printerBaud); return { ok: true }; }
  } catch (e) { if (!usbBlocked) return { ok: false, error: e.message }; }
  return { ok: false, error: "The drawer opens through the Windows printer driver — it opens when a cash receipt prints. (In the driver's Printing preferences, set “Cash drawer: open before printing”.)" };
}

/* ======================================================================= customer display */
// The terminal's second screen shows the ticket live. Same browser profile → BroadcastChannel, no server round trip.
const CH = "bladeos-customer-display";
let channel = null;
const chan = () => (typeof BroadcastChannel === "undefined" ? null : (channel ??= new BroadcastChannel(CH)));
export const customerDisplay = {
  send(msg) { try { chan()?.postMessage(msg); } catch { /* ignore */ } },
  listen(fn) { const c = chan(); if (!c) return () => {}; const h = (e) => fn(e.data); c.addEventListener("message", h); return () => c.removeEventListener("message", h); },
};

/** Open the customer display, on the second screen when the browser can tell where that is. */
export async function openCustomerDisplay() {
  const url = `${location.origin}${location.pathname}#customer-display`;
  let features = "popup,width=1024,height=600";
  try {
    if ("getScreenDetails" in window) {
      const sd = await window.getScreenDetails();
      const other = sd.screens.find((s) => s !== sd.currentScreen) || null;
      if (other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
    }
  } catch { /* permission refused: open a normal window the cashier can drag across */ }
  const w = window.open(url, "bladeos-customer-display", features);
  return !!w;
}
