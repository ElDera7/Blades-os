// Offline mode for the till.
//   • The last good copy of the app's data and the signed-in user live in IndexedDB on this device, so BladeOS opens
//     and sells without internet.
//   • Anything done offline (sales, cleared tickets, temperature readings, food-safety checklists) goes into an
//     upload queue ("outbox") that survives refreshes and power cuts, and uploads in order once the internet is back.
//   • Uploads are safe to repeat: every sale carries a unique reference, so a retry never records it twice.
import { api, ApiError } from "./api.js";
import { loadDevices } from "./hardware.js";

/* ======================================================================= tiny IndexedDB layer */
const DB = "bladeos", VER = 1;
let dbp = null;
const mem = { kv: new Map(), outbox: new Map(), seq: 0 };          // fallback when IndexedDB isn't available
const hasIDB = () => typeof indexedDB !== "undefined";
let idbBroken = false;
const hasIDBok = () => hasIDB() && !idbBroken;
function open() {
  if (!hasIDBok()) return null;
  dbp ??= new Promise((res, rej) => {
    // If the browser's storage doesn't answer (blocked by another window, or damaged), don't hang the app:
    // after 4 s carry on with in-memory storage for this visit.
    const t = setTimeout(() => { idbBroken = true; console.warn("BladeOS: device storage isn't responding — using memory for now."); res(null); }, 4000);
    const r = indexedDB.open(DB, VER);
    r.onblocked = () => console.warn("BladeOS: device storage is busy in another window.");
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
    };
    r.onsuccess = () => { clearTimeout(t); const d = r.result; d.onversionchange = () => d.close(); res(d); };
    r.onerror = () => { clearTimeout(t); idbBroken = true; res(null); };
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await open();
  if (!d) return fn(null);
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const kv = {
  async get(key) { if (!hasIDBok() || !(await open())) return mem.kv.get(key); return tx("kv", "readonly", (s) => req(s.get(key))); },
  async set(key, val) { if (!hasIDBok() || !(await open())) { mem.kv.set(key, val); return; } return tx("kv", "readwrite", (s) => { s.put(val, key); }); },
  async del(key) { if (!hasIDBok() || !(await open())) { mem.kv.delete(key); return; } return tx("kv", "readwrite", (s) => { s.delete(key); }); },
};

/* ======================================================================= cached session + data */
/** Remember who's signed in on this till and the data they last saw. */
export async function saveSnapshot(user, state) {
  try {
    await kv.set(`user:${user.id}`, { user, state, savedAt: Date.now() });
    await kv.set("lastUserId", user.id);
    const ids = new Set((await kv.get("deviceUsers")) || []); ids.add(user.id);
    await kv.set("deviceUsers", [...ids]);
  } catch { /* storage full or blocked: online use is unaffected */ }
}
export async function loadSnapshot(userId) {
  try { return (await kv.get(`user:${userId ?? (await kv.get("lastUserId"))}`)) || null; } catch { return null; }
}
/** People who've used this till before (offline sign-in list). Only those with an offline PIN can sign in offline. */
export async function deviceUsers() {
  const ids = (await kv.get("deviceUsers")) || [];
  const out = [];
  for (const id of ids) {
    const s = await kv.get(`user:${id}`);
    const pin = await kv.get(`pin:${id}`);
    if (s) out.push({ id, name: s.user.name, role: s.user.role, hasPin: !!pin, savedAt: s.savedAt });
  }
  return out;
}
/** Keep this browser's storage from being cleared when the disk is low. */
export async function persistStorage() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
}

/* ======================================================================= offline PIN (unlocks this till only) */
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hashPin(pin, salt) {
  if (!globalThis.crypto?.subtle) throw new Error("This browser can't store an offline PIN securely.");
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 150000 }, key, 256));
}
export async function setOfflinePin(userId, pin) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await kv.set(`pin:${userId}`, { salt, hash: await hashPin(pin, salt), fails: 0 });
}
export const hasOfflinePin = async (userId) => !!(await kv.get(`pin:${userId}`));
/** Returns true / false; 5 wrong tries wipe the PIN (the person then needs the internet to sign in). */
export async function checkOfflinePin(userId, pin) {
  const rec = await kv.get(`pin:${userId}`);
  if (!rec) return false;
  if ((await hashPin(pin, rec.salt)) === rec.hash) { if (rec.fails) await kv.set(`pin:${userId}`, { ...rec, fails: 0 }); return true; }
  const fails = (rec.fails || 0) + 1;
  if (fails >= 5) await kv.del(`pin:${userId}`); else await kv.set(`pin:${userId}`, { ...rec, fails });
  return false;
}

/* ======================================================================= outbox */
export const outbox = {
  async add(item) {
    const rec = { ...item, createdAt: new Date().toISOString(), status: "pending", attempts: 0 };
    if (!hasIDBok() || !(await open())) { const id = ++mem.seq; mem.outbox.set(id, { ...rec, id }); changed(); return id; }
    const id = await tx("outbox", "readwrite", (s) => req(s.add(rec)));
    changed();
    return id;
  },
  async all() {
    if (!hasIDBok() || !(await open())) return [...mem.outbox.values()].sort((a, b) => a.id - b.id);
    return (await tx("outbox", "readonly", (s) => req(s.getAll()))).sort((a, b) => a.id - b.id);
  },
  async put(rec) { if (!hasIDBok() || !(await open())) { mem.outbox.set(rec.id, rec); changed(); return; } await tx("outbox", "readwrite", (s) => { s.put(rec); }); changed(); },
  async remove(id) { if (!hasIDBok() || !(await open())) { mem.outbox.delete(id); changed(); return; } await tx("outbox", "readwrite", (s) => { s.delete(id); }); changed(); },
};

/* ======================================================================= status for the banner */
const status = { online: typeof navigator === "undefined" ? true : navigator.onLine !== false, syncing: false, pending: 0, errors: 0, waitingFor: [], lastSync: null, offlineSince: null, needsSignIn: false };
const listeners = new Set();
export const syncStatus = () => ({ ...status });
export function onSync(fn) { listeners.add(fn); fn(syncStatus()); return () => listeners.delete(fn); }
function emit() { const s = syncStatus(); listeners.forEach((f) => f(s)); }
async function changed() {
  const items = await outbox.all();
  status.pending = items.filter((i) => i.status === "pending").length;
  status.errors = items.filter((i) => i.status === "error").length;
  emit();
}

/** Called by the app whenever a request fails for lack of network, or succeeds. */
export async function setOnline(on) {
  if (on === status.online) return;
  status.online = on;
  if (!on) {
    status.offlineSince = (await kv.get("offlineSince")) || Date.now();
    await kv.set("offlineSince", status.offlineSince);
  }
  emit();
}
export async function initOfflineStatus() {
  status.offlineSince = (await kv.get("offlineSince")) || null;
  await changed();
}
/** How long this till has been working without the server (oldest unsent item or when it went offline). */
export async function offlineAgeHours() {
  const items = (await outbox.all()).filter((i) => i.status !== "error");
  const oldest = items.length ? Date.parse(items[0].createdAt) : null;
  const since = status.online ? oldest : Math.min(status.offlineSince || Date.now(), oldest || Date.now());
  return since ? (Date.now() - since) / 3600e3 : 0;
}
export const OFFLINE_WARN_HOURS = 24, OFFLINE_STOP_HOURS = 72;

/** A saved copy of the data, with this till's not-yet-uploaded sales and holds taken into account. */
export const clone = (x) => (typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
export async function withPending(state, userId) {
  if (!state) return state;
  const items = (await outbox.all()).filter((i) => i.kind === "sale");
  const localHeld = (await kv.get("heldLocal")) || [];
  if (!items.length && !localHeld.length) return state;     // nothing waiting: use the server's copy as it is
  const n = clone(state);
  for (const it of items) {
    for (const l of it.payload.items || []) {
      const p = n.inventory?.find((x) => x.sku === l.sku);
      if (p) { p.qty = Math.max(0, Math.round((p.qty - l.qty) * 1000) / 1000); p.sellable = Math.max(0, Math.round(((p.sellable ?? p.qty) - l.qty) * 1000) / 1000); }
    }
    if (n.tills?.mine && it.userId === userId && it.payload.tillCode === n.tills.mine.code) n.tills.mine.sales += 1;
  }
  if (n.pos && localHeld.length) n.pos.held = [...n.pos.held.filter((h) => !String(h.id).startsWith("local-")), ...localHeld];
  return n;
}
/** Sales still on this till for one person (closing their till waits for these). */
export async function pendingSalesFor(userId) {
  return (await outbox.all()).filter((i) => i.kind === "sale" && i.userId === userId);
}

/* ======================================================================= offline receipt numbers */
export function nextOfflineNo() {
  const till = String(loadDevices().tillNo || "1").replace(/[^A-Za-z0-9]/g, "").slice(0, 4) || "1";
  let n = 0;
  try { n = Number(localStorage.getItem("bladeos.offlineSeq") || 0) + 1; localStorage.setItem("bladeos.offlineSeq", String(n)); } catch { n = Date.now() % 1e6; }
  return `T${till}-${String(n).padStart(6, "0")}`;
}

/* ======================================================================= sync */
const ENDPOINT = {
  sale: (p) => ["/pos/offline-sales", "POST", p],
  void: (p) => ["/pos/void", "POST", p],
  temp: (p) => ["/temperatures", "POST", p],
  haccp: (p) => [`/haccp/${p.checklistId}/complete`, "POST", { results: p.results, note: p.note, completedAt: p.completedAt }],
};
let running = null;
/**
 * Upload everything waiting, oldest first. `user` = who's signed in; their own items always go,
 * and a manager (canUploadForOthers) also uploads other people's sales on their behalf.
 */
export function syncNow(user, { canUploadForOthers = false } = {}) {
  if (running) return running;
  running = (async () => {
    status.syncing = true; status.needsSignIn = false; emit();
    let uploaded = 0;
    try {
      const items = (await outbox.all()).filter((i) => i.status === "pending");
      const waiting = new Set();
      for (const it of items) {
        if (it.userId !== user?.id && !(it.kind === "sale" && canUploadForOthers)) { waiting.add(it.userName); continue; }
        const [path, method, body] = ENDPOINT[it.kind](it.payload);
        try {
          const r = await api(path, { method, body });
          await outbox.remove(it.id);
          await kv.set("lastSynced", { at: Date.now(), kind: it.kind, label: it.label, code: r?.code });
          uploaded++;
        } catch (e) {
          if (e instanceof ApiError && e.status === 0) { await setOnline(false); break; }                 // no network: stop, try later
          if (e instanceof ApiError && e.status === 401) { status.needsSignIn = true; break; }              // signed out: sign in to continue
          await outbox.put({ ...it, status: "error", error: e.message, attempts: (it.attempts || 0) + 1, failedAt: new Date().toISOString() });
        }
      }
      status.waitingFor = [...waiting];
      if (uploaded) {
        status.lastSync = Date.now();
        await setOnline(true);
      }
      if (status.online && !(await outbox.all()).some((i) => i.status === "pending")) { status.offlineSince = null; await kv.del("offlineSince"); }
    } finally {
      status.syncing = false;
      await changed();
      running = null;
    }
    return uploaded;
  })();
  return running;
}
export async function retryItem(id) {
  const it = (await outbox.all()).find((i) => i.id === id);
  if (it) await outbox.put({ ...it, status: "pending", error: null });
}
/** Download everything still on this till as a file (belt and braces before reinstalling Windows, etc.). */
export async function exportOutbox() {
  const items = await outbox.all();
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bladeos-unsent-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
