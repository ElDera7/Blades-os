import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  LayoutDashboard, Beef, Scissors, Warehouse, ShoppingCart, Users, Truck, Package, Megaphone, FileBarChart,
  Search, Bell, X, LogIn, Sparkles, ShieldCheck, Settings, ClipboardList, ClipboardCheck, Menu, LogOut, KeyRound, Loader2, RefreshCw, FileText, Landmark, ListChecks, Wallet, MonitorDown, Download, Check,
} from "lucide-react";
import { api, setUnauthorizedHandler } from "./lib/api.js";
import { C, initials } from "./lib/theme.js";
import { can, routeAllowed, PASSWORD_MIN, weakPin } from "./shared/permissions.js";
import { Btn, Toast, ICONS, Modal, Field, Input, useBusy } from "./components/ui.jsx";
import ButcherAI from "./components/ButcherAI.jsx";
// Charts are heavy (≈150 KB): the screens that draw them load on first use, so the till and sign-in open fast.
const named = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const loadOverview = () => import("./views/Overview.jsx");
const loadRanch = () => import("./views/Ranch.jsx");
const Dashboard = named(loadOverview, "Dashboard");
const ReportsView = named(loadOverview, "ReportsView");
const RoadmapView = named(loadOverview, "RoadmapView");
const RanchView = named(loadRanch, "RanchView");
const ProcessingView = named(loadRanch, "ProcessingView");
import { InventoryView } from "./views/Inventory.jsx";
import { OrdersView, CustomersView, DeliveryView, CashierSalesView } from "./views/Sales.jsx";
import { POSView } from "./views/POS.jsx";
import { AdminView } from "./views/Admin.jsx";
import { ProcurementView } from "./views/Procurement.jsx";
import { MarketingView } from "./views/Marketing.jsx";
import { SetupView } from "./views/Setup.jsx";
import { ApprovalsView } from "./views/Approvals.jsx";
import { MfaStep, MfaEnrol, MfaDisable, SessionsPanel } from "./views/Security.jsx";
import { PurchasesView, PaymentsView, FoodSafetyView } from "./views/Business.jsx";
import { ScaleProvider } from "./lib/scale.jsx";
import { OfflineSignIn, OfflineLock, OfflineBanner, SyncModal, OfflinePinModal, UpdateBanner } from "./views/Offline.jsx";
import { priceTicket } from "./views/POS.jsx";
import {
  saveSnapshot, loadSnapshot, setOnline, onSync, syncNow, syncStatus, outbox, nextOfflineNo, offlineAgeHours, OFFLINE_STOP_HOURS,
  initOfflineStatus, persistStorage, kv, withPending, pendingSalesFor, clone,
} from "./lib/offline.js";

const NAV = [
  { section: "Overview", items: [
    { id: "dashboard", label: "Executive Dashboard", icon: LayoutDashboard },
    { id: "approvals", label: "Approvals", icon: ClipboardCheck },
  ] },
  { section: "Ranch", items: [{ id: "ranch", label: "Livestock", icon: Beef }] },
  { section: "Processing", items: [{ id: "processing", label: "Processing Batches", icon: Scissors }] },
  { section: "Inventory", items: [
    { id: "inventory", label: "Inventory & Cold Room", icon: Warehouse },
    { id: "foodsafety", label: "Food Safety (HACCP)", icon: ListChecks },
  ] },
  { section: "Sales", items: [
    { id: "pos", label: "POS", icon: ShoppingCart },
    { id: "cashiers", label: "Cashier Sales", icon: Wallet },
    { id: "orders", label: "Orders", icon: ClipboardList },
    { id: "customers", label: "Customers", icon: Users },
    { id: "delivery", label: "Delivery", icon: Truck },
  ] },
  { section: "Procurement", items: [
    { id: "purchases", label: "Purchase Orders", icon: FileText },
    { id: "procurement", label: "Suppliers", icon: Package },
  ] },
  { section: "Money", items: [{ id: "payments", label: "Payment Reconciliation", icon: Landmark }] },
  { section: "Marketing", items: [{ id: "marketing", label: "Marketing & Content", icon: Megaphone }] },
  { section: "Reports", items: [{ id: "reports", label: "Management Reports", icon: FileBarChart }] },
  { section: "System", items: [
    { id: "setup", label: "Business Setup", icon: Settings },
    { id: "roadmap", label: "Roadmap", icon: Sparkles },
    { id: "admin", label: "Administration", icon: ShieldCheck },
  ] },
];

const allowed = (roles, id) => routeAllowed(roles, id);
const IDLE_MINUTES = 30; // shared tills and back-office PCs sign out when left unattended
// Where each role starts its day.
const HOME = { Cashier: "pos", Storekeeper: "inventory", "Ranch Manager": "ranch", "Production Manager": "processing", "Delivery Manager": "delivery", "Marketing Manager": "marketing", Administrator: "admin" };
const firstRoute = (user) => (HOME[user.role] && allowed(user.roles, HOME[user.role]) ? HOME[user.role]
  : NAV.flatMap((s) => s.items).find((i) => i.id !== "roadmap" && allowed(user.roles, i.id))?.id ?? "roadmap");

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking session
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || null);
  const [toast, setToast] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [sessOpen, setSessOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [reportTab, setReportTab] = useState(null);
  // Offline mode
  const [sync, setSync] = useState(syncStatus());
  const [offlineSession, setOfflineSession] = useState(false); // signed in on this till with the offline PIN (no server session)
  const [offlineGate, setOfflineGate] = useState(false);       // no internet at start-up: offer offline sign-in
  const [locked, setLocked] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [offPinOpen, setOffPinOpen] = useState(false);
  const userRef = useRef(null); userRef.current = user;
  const dataRef = useRef(null); dataRef.current = data;
  useEffect(() => { initOfflineStatus(); persistStorage(); return onSync(setSync); }, []);
  useEffect(() => {
    const off = () => setOnline(false);
    window.addEventListener("offline", off);
    return () => window.removeEventListener("offline", off);
  }, []);

  const notify = useCallback((message, kind = "ok") => setToast({ message, kind, at: Date.now() }), []);

  const refresh = useCallback(async () => {
    try {
      const s = await api("/state");
      if (userRef.current) saveSnapshot(userRef.current, s);
      // Sales not uploaded yet and tickets parked offline still show at the till.
      setData(await withPending(s, userRef.current?.id));
      setLoadError(null);
      await setOnline(true);
    } catch (e) {
      if (e.status === 0) {
        // No internet: carry on with the copy saved on this till.
        await setOnline(false);
        if (!dataRef.current && userRef.current) {
          const snap = await loadSnapshot(userRef.current.id);
          if (snap) { setData(await withPending(snap.state, userRef.current.id)); setLoadError(null); return; }
        }
        if (!dataRef.current) setLoadError("No internet, and this till has no saved copy of BladeOS yet. Connect once to set it up.");
      } else if (e.status !== 401) setLoadError(e.message);
    }
  }, []);

  // Session check on load; any 401 later sends the user back to sign-in.
  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setData(null); });
    api("/auth/me").then((r) => setUser(r.user)).catch(async (e) => {
      if (e.status === 0) { await setOnline(false); setOfflineGate(true); }
      setUser(null);
    });
  }, []);

  // Upload anything done offline: on start, when the internet returns, and every 20 s while something is waiting.
  useEffect(() => {
    if (!user || offlineSession || user.mustChangePassword || user.mfaSetupRequired) return;
    const go = () => syncNow(user, { canUploadForOthers: can(user.roles, "till.review") }).then((n) => { if (n) refresh(); });
    go();
    const t = setInterval(() => { const st = syncStatus(); if (st.pending && !st.syncing) go(); }, 20000);
    window.addEventListener("online", go);
    return () => { clearInterval(t); window.removeEventListener("online", go); };
  }, [user, offlineSession, refresh]);
  // While offline, check for the internet every 15 s.
  useEffect(() => {
    if (!user || sync.online) return;
    const check = () => { if (offlineSession) fetch("/health", { cache: "no-store" }).then((r) => { if (r.ok) setOnline(true); }).catch(() => {}); else refresh(); };
    const t = setInterval(check, 15000);
    window.addEventListener("online", check);   // Windows says the network is back: check straight away
    return () => { clearInterval(t); window.removeEventListener("online", check); };
  }, [user, sync.online, offlineSession, refresh]);

  useEffect(() => { if (user && !user.mustChangePassword && !user.mfaSetupRequired) refresh(); }, [user, refresh]);

  // Idle sign-out.
  useEffect(() => {
    if (!user) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ["mousedown", "keydown", "touchstart", "scroll"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(async () => {
      if (Date.now() - last > IDLE_MINUTES * 60000) {
        // Offline the till can't sign back in with a password, so it locks instead (unlock with the offline PIN).
        if (offlineSession || !syncStatus().online) { setLocked(true); last = Date.now(); return; }
        await api("/auth/logout", { method: "POST" }).catch(() => {});
        setUser(null); setData(null); setRoute(null);
        setToast({ message: `Signed out after ${IDLE_MINUTES} minutes of inactivity.`, kind: "ok", at: Date.now() });
      }
    }, 30000);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [user, offlineSession]);

  // Keep figures fresh across tills and screens.
  useEffect(() => {
    if (!user) return;
    if (!user || user.mustChangePassword || user.mfaSetupRequired) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);
    return () => clearInterval(t);
  }, [user, refresh]);

  // Route guard + deep-linkable hash
  useEffect(() => {
    if (!user) return;
    if (!route || !allowed(user.roles, route)) setRoute(firstRoute(user));
  }, [user, route]);
  useEffect(() => { if (route) window.history.replaceState(null, "", `#${route}`); }, [route]);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.slice(1) || null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goTo = (r) => { setRoute(r); setMobileNavOpen(false); window.scrollTo(0, 0); };

  /** Run an API call, toast the result, refresh data. Returns the response, or null on failure. */
  const act = useCallback(async (fn, success) => {
    try {
      const res = await fn();
      if (success) notify(typeof success === "function" ? success(res) : success);
      await refresh();
      return res ?? true;
    } catch (e) {
      if (e.status === 0) { await setOnline(false); notify("You're offline — this needs the internet. Sales and checklists still work.", "error"); return null; }
      notify(e.message, "error");
      return null;
    }
  }, [notify, refresh]);

  /* ---------------------------------------------------------------- offline versions of counter actions */
  const isOffline = () => offlineSession || !syncStatus().online;
  const patchData = (fn) => setData((d) => { if (!d) return d; const n = clone(d); fn(n); return n; });
  const queue = async (kind, payload, label) => {
    await outbox.add({ kind, payload, label, userId: user.id, userName: user.name });
  };
  const offlineSale = async (body) => {
    if ((await offlineAgeHours()) > OFFLINE_STOP_HOURS) { notify(`This till has been offline for over ${OFFLINE_STOP_HOURS} hours. Connect to the internet to upload before selling more.`, "error"); return null; }
    if (body.payLater) { notify("Pay later needs the internet — take payment now.", "error"); return null; }
    const inv = Object.fromEntries((dataRef.current?.inventory || []).map((p) => [p.sku, p]));
    const items = body.items.map((i) => ({ ...i, price: inv[i.sku]?.price ?? 0 }));
    const priced = priceTicket(items.map((i) => ({ ...i, price: i.price })), body.discount, (sku) => inv[sku]?.vatRate || 0);
    const payments = body.payments || [];
    const change = payments.reduce((sum, p) => sum + (p.tendered ? p.tendered - p.amount : 0), 0);
    const offlineNo = nextOfflineNo();
    const payload = { ...body, items, offlineNo, soldAt: new Date().toISOString(), sellerId: user.id, tillCode: dataRef.current?.tills?.mine?.code ?? null };
    delete payload.overrideToken;
    await queue("sale", payload, `${offlineNo} · ₦${priced.total.toLocaleString("en-NG")}`);
    // Keep the screen honest until it syncs: less stock, one more sale.
    patchData((d) => {
      for (const it of items) {
        const p = d.inventory?.find((x) => x.sku === it.sku);
        if (p) { p.qty = Math.max(0, Math.round((p.qty - it.qty) * 1000) / 1000); p.sellable = Math.max(0, Math.round(((p.sellable ?? p.qty) - it.qty) * 1000) / 1000); }
      }
      if (d.tills?.mine) d.tills.mine.sales += 1;
    });
    const methods = [...new Set(payments.map((p) => p.method))];
    notify(`Sale ${offlineNo} saved on this till — it uploads when the internet is back`);
    return { code: offlineNo, offlineNo, total: priced.total, gross: priced.gross, discount: priced.discount, tax: priced.tax, change, offline: true,
      paymentMethod: methods.length === 1 ? methods[0] : "Split" };
  };

  const actions = {
    addAnimal: (body) => act(() => api("/livestock", { method: "POST", body }), (r) => `${r.code} added to the livestock register`),
    updateAnimal: (code, body) => act(() => api(`/livestock/${encodeURIComponent(code)}`, { method: "PATCH", body }), `${code} updated`),
    processBatch: (body) => act(() => api("/processing", { method: "POST", body }), (r) => `Batch ${r.code} completed — ${r.yield}% yield, ${r.saleable} KG added to inventory`),
    transfer: (body) => act(() => api("/inventory/transfer", { method: "POST", body }), (r) => `${body.qty} of ${r.name} moved to ${body.to}`),
    adjust: (body) => act(() => api("/inventory/adjust", { method: "POST", body }),
      (r) => r.status === "Pending" ? `${r.code} sent for approval — stock changes once a manager approves` : r.code ? `${r.code} posted — ${r.name} updated` : `${r.name} received`),
    addProduct: (body) => act(() => api("/products", { method: "POST", body }), (r) => `${r.name} added (${r.sku})`),
    updateProduct: (sku, body, msg = "Product updated") => act(() => api(`/products/${encodeURIComponent(sku)}`, { method: "PATCH", body }), msg),
    addLocation: (body) => act(() => api("/locations", { method: "POST", body }), (r) => `${r.name} added`),
    updateLocation: (id, body, msg) => act(() => api(`/locations/${id}`, { method: "PATCH", body }), msg),
    addRanch: (body) => act(() => api("/ranches", { method: "POST", body }), (r) => `${r.name} added`),
    updateRanch: (id, body, msg) => act(() => api(`/ranches/${id}`, { method: "PATCH", body }), msg),
    sell: async (body) => {
      if (isOffline()) return offlineSale(body);
      try {
        const r = await api("/sales", { method: "POST", body });
        notify(`Sale ${r.code} completed — ₦${r.total.toLocaleString("en-NG")}`);
        refresh();
        return r;
      } catch (e) {
        // The connection dropped: save it on the till. If the server did get it, the upload is recognised (same reference).
        if (e.status === 0) { await setOnline(false); return offlineSale(body); }
        notify(e.message, "error");
        return null;
      }
    },
    offlineSummary: async () => {
      const sales = (await outbox.all()).filter((i) => i.kind === "sale" && i.userId === user.id);
      const by = {};
      for (const s of sales) for (const p of s.payload.payments || []) by[p.method] = (by[p.method] || 0) + p.amount;
      return { count: sales.length, byMethod: by, total: Object.values(by).reduce((a, b) => a + b, 0) };
    },
    posAuthorize: (body) => api("/pos/authorize", { method: "POST", body }).catch((e) => ({ error: e.message })),
    holdTicket: async (body) => {
      if (!isOffline()) { const r = await act(() => api("/pos/held", { method: "POST", body }), (x) => `Ticket held — ${x.label}`); if (r || !isOffline()) return r; }
      // Offline: park it on this till.
      const id = `local-${Date.now()}`;
      const label = body.label || `Ticket ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" })}`;
      const held = { id, label, customerId: body.customerId, cart: body.cart, total: body.total, who: user.name, at: "this till (offline)", lines: body.cart.items.length };
      await kv.set("heldLocal", [...((await kv.get("heldLocal")) || []), held]);
      patchData((d) => { if (d.pos) d.pos.held = [...d.pos.held, held]; });
      notify(`Ticket held on this till — ${label}`);
      return { id, label };
    },
    recallTicket: async (id) => {
      if (String(id).startsWith("local-")) {
        const list = (await kv.get("heldLocal")) || [];
        const h = list.find((x) => x.id === id);
        await kv.set("heldLocal", list.filter((x) => x.id !== id));
        patchData((d) => { if (d.pos) d.pos.held = d.pos.held.filter((x) => x.id !== id); });
        if (h) notify(`${h.label} recalled`);
        return h ? { label: h.label, customerId: h.customerId, cart: h.cart } : null;
      }
      return act(() => api(`/pos/held/${id}/recall`, { method: "POST" }), (r) => `${r.label} recalled`);
    },
    voidTicket: async (body) => {
      if (isOffline()) { await queue("void", body, `Cleared ticket · ₦${body.value.toLocaleString("en-NG")}`); notify("Ticket cleared (logged — uploads later)"); return true; }
      return act(() => api("/pos/void", { method: "POST", body }), "Ticket cleared");
    },
    tillReport: (code) => api(`/till/${encodeURIComponent(code)}/report`),
    setPosPin: (body) => act(() => api("/auth/pos-pin", { method: "POST", body }), "Till approval PIN saved"),
    saveBusiness: (body) => act(() => api("/settings/business", { method: "PATCH", body }), "Receipt details saved"),
    updateOrder: (code, body) => act(() => api(`/orders/${encodeURIComponent(code)}`, { method: "PATCH", body }), `${code} updated`),
    getOrder: (code) => api(`/orders/${encodeURIComponent(code)}`),
    addCustomer: (body) => act(() => api("/customers", { method: "POST", body }), (r) => `${r.name} added`),
    updateCustomer: (id, body, msg) => act(() => api(`/customers/${id}`, { method: "PATCH", body }), msg),
    eraseCustomer: (id) => act(() => api(`/customers/${id}/erase`, { method: "POST", body: {} }), "Customer's personal data erased"),
    addSupplier: (body) => act(() => api("/suppliers", { method: "POST", body }), (r) => `${r.name} added`),
    updateSupplier: (id, body, msg = "Supplier updated") => act(() => api(`/suppliers/${id}`, { method: "PATCH", body }), msg),
    supplierEntry: (id, body, msg) => act(() => api(`/suppliers/${id}/entries`, { method: "POST", body }), msg),
    addCampaign: (body) => act(() => api("/campaigns", { method: "POST", body }), (r) => `${r.name} added`),
    updateCampaign: (id, body) => act(() => api(`/campaigns/${id}`, { method: "PATCH", body }), "Campaign updated"),
    deleteCampaign: (id, name) => act(() => api(`/campaigns/${id}`, { method: "DELETE" }), `${name} deleted`),
    addPost: (body) => act(() => api("/content", { method: "POST", body }), "Post added to the calendar"),
    updatePost: (id, body) => act(() => api(`/content/${id}`, { method: "PATCH", body }), "Post updated"),
    deletePost: (id) => act(() => api(`/content/${id}`, { method: "DELETE" }), "Post deleted"),
    requestRefund: (body) => act(() => api("/refunds", { method: "POST", body }),
      (r) => r.status === "Approved" ? `Refund ${r.code} issued — ₦${r.amount.toLocaleString("en-NG")}` : `Refund ${r.code} sent for approval — ₦${r.amount.toLocaleString("en-NG")}`),
    decide: (kind, code, decision, note) => act(() => api(`/approvals/${kind}/${encodeURIComponent(code)}`, { method: "POST", body: { decision, note } }),
      (r) => `${r.code} ${r.status.toLowerCase()}`),
    openTill: (float) => act(() => api("/till/open", { method: "POST", body: { float } }), (r) => `Till ${r.code} open`),
    closeTill: async (body) => {
      // The cash-up must include every sale: upload the ones made offline first.
      if ((await pendingSalesFor(user.id)).length) {
        await syncNow(user, { canUploadForOthers: can(user.roles, "till.review") }).catch(() => {});
        const left = (await pendingSalesFor(user.id)).length;
        if (left) { notify(`${left} sale${left === 1 ? " is" : "s are"} still saved on this till — upload ${left === 1 ? "it" : "them"} (internet needed) before closing the till.`, "error"); return null; }
      }
      return act(() => api("/till/close", { method: "POST", body }), null);
    },
    reviewTill: (code, note) => act(() => api(`/till/${encodeURIComponent(code)}/review`, { method: "POST", body: { note } }), `${code} signed off`),
    logTemp: async (body) => {
      if (isOffline()) {
        await queue("temp", { ...body, recordedAt: new Date().toISOString() }, `${body.location} ${body.reading}°C`);
        notify(`${body.location}: ${body.reading}°C saved on this till — uploads later`);
        return { ok: true, offline: true, location: body.location, reading: body.reading };
      }
      return actions._logTempOnline(body);
    },
    _logTempOnline: (body) => act(() => api("/temperatures", { method: "POST", body }), (r) => r.inRange ? `${r.location}: ${r.reading}°C logged` : `${r.location}: ${r.reading}°C logged as a breach`),
    scheduleCount: (body) => act(() => api("/counts", { method: "POST", body }), (r) => `Stock count ${r.code} scheduled`),
    getCount: (code) => api(`/counts/${encodeURIComponent(code)}`),
    submitCount: (code, lines) => act(() => api(`/counts/${encodeURIComponent(code)}/submit`, { method: "POST", body: { lines } }),
      (r) => r.variances ? `${r.code} submitted — ${r.variances} difference${r.variances === 1 ? "" : "s"} sent for approval` : `${r.code} submitted — everything matched`),
    cancelCount: (code) => act(() => api(`/counts/${encodeURIComponent(code)}/cancel`, { method: "POST" }), `${code} cancelled`),
    trace: (lot) => api(`/trace/${encodeURIComponent(lot)}`),
    createPO: (body) => act(() => api("/purchase-orders", { method: "POST", body }), (r) => r.status === "Approved" ? `${r.code} raised and approved` : `${r.code} raised — waiting for approval`),
    decidePO: (code, decision, note) => act(() => api(`/purchase-orders/${encodeURIComponent(code)}/decide`, { method: "POST", body: { decision, note } }), (r) => `${r.code} ${r.status.toLowerCase()}`),
    receivePO: (code, body) => act(() => api(`/purchase-orders/${encodeURIComponent(code)}/receive`, { method: "POST", body }), (r) => `${r.code}: delivery received (${r.reference}) — ${r.status.toLowerCase()}`),
    closePO: (code, note) => act(() => api(`/purchase-orders/${encodeURIComponent(code)}/close`, { method: "POST", body: { note } }), (r) => `${r.code} ${r.status.toLowerCase()}`),
    getRecon: (day, method) => api(`/reconciliations/${day}/${encodeURIComponent(method)}`),
    recordRecon: (body) => act(() => api("/reconciliations", { method: "POST", body }), (r) => r.variance === 0 ? `${r.method} matched — sent for sign-off` : `${r.method} recorded with a ₦${Math.abs(r.variance).toLocaleString("en-NG")} difference — sent for sign-off`),
    reviewRecon: (id, note) => act(() => api(`/reconciliations/${id}/review`, { method: "POST", body: { note } }), "Reconciliation signed off"),
    completeHaccp: async (id, body) => {
      if (isOffline()) {
        const c = dataRef.current?.foodSafety?.checklists?.find((x) => x.id === id);
        await queue("haccp", { checklistId: id, ...body, completedAt: new Date().toISOString() }, `${c?.name ?? "Checklist"}`);
        patchData((d) => { const x = d.foodSafety?.checklists?.find((k) => k.id === id); if (x) { x.due = false; x.current = { allOk: body.results.every((r) => r.ok), results: body.results.map((r, i) => ({ ...r, item: x.items[i] })), completedBy: user.name, completedAt: "saved on this till", verifiedBy: null }; } });
        notify("Checklist saved on this till — uploads when the internet is back");
        return { ok: true, offline: true, allOk: body.results.every((r) => r.ok), failures: body.results.filter((r) => !r.ok).length };
      }
      return actions._completeHaccpOnline(id, body);
    },
    _completeHaccpOnline: (id, body) => act(() => api(`/haccp/${id}/complete`, { method: "POST", body }), (r) => r.allOk ? "Checklist complete — all passed" : `Checklist complete — ${r.failures} failure${r.failures === 1 ? "" : "s"} sent to a manager`),
    verifyHaccp: (id, note) => act(() => api(`/haccp/runs/${id}/verify`, { method: "POST", body: { note } }), "Checklist verified"),
    addChecklist: (body) => act(() => api("/haccp/checklists", { method: "POST", body }), `${body.name} added`),
    updateChecklist: (id, body, msg = "Checklist updated") => act(() => api(`/haccp/checklists/${id}`, { method: "PATCH", body }), msg),
    runBackup: () => act(() => api("/backups/run", { method: "POST" }), (r) => `Backup stored off-site — ${r.rows.toLocaleString("en-NG")} rows`),
    testRestore: () => act(() => api("/backups/test", { method: "POST" }), (r) => r.ok ? `Restore test passed — ${r.tables} tables, ${r.rows.toLocaleString("en-NG")} rows` : `Restore test FAILED: ${r.problems[0]}`),
    saveLimits: (body) => act(() => api("/settings/limits", { method: "PATCH", body }), "Approval limits saved"),
    createUser: (body) => act(() => api("/users", { method: "POST", body }), (r) => `${r.name} can now sign in`),
    updateUser: (id, body) => act(() => api(`/users/${id}`, { method: "PATCH", body }), "User updated"),
    notify,
    refresh,
  };

  const logout = async () => {
    if (!offlineSession) await api("/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null); setData(null); setRoute(null); setOfflineSession(false); setLocked(false);
  };

  // Cashiers get the whole screen for selling: the menu folds away behind ☰ (checklists, refunds and orders are still there).
  const compact = !!user && user.role === "Cashier" && (user.roles || []).length === 1;
  if (user === undefined) return <Splash />;
  if (!user && (offlineGate || !sync.online)) return (
    <OfflineSignIn pending={sync.pending}
      onSignedIn={async (snap) => { setOfflineGate(false); setOfflineSession(true); setData(await withPending(snap.state, snap.user.id)); setUser(snap.user); setRoute(null); }}
      onTryOnline={async () => { try { const r = await api("/auth/me"); await setOnline(true); setOfflineGate(false); setUser(r.user); } catch (e) { if (e.status !== 0) { await setOnline(true); setOfflineGate(false); } } }} />
  );
  if (!user) return (<>{toast && <Toast toast={toast} onDone={() => setToast(null)} />}<LoginScreen pending={sync.pending} onLogin={(u) => { setUser(u); setRoute(window.location.hash.slice(1) || null); }} /></>);
  if (!user.mustChangePassword && user.mfaSetupRequired) return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: C.charcoal }}>
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: "#fff" }}>
        <MfaEnrol required onDone={() => { setUser({ ...user, mfaSetupRequired: false, mfaEnabled: true }); notify("Two-step sign-in is on"); }} />
        <button onClick={logout} className="f-body text-xs mt-4 w-full text-center hover:underline" style={{ color: C.muted }}>Sign out</button>
      </div>
    </div>
  );
  if (user.mustChangePassword) return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: C.charcoal }}>
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: "#fff" }}>
        <h1 className="f-display text-xl mb-1" style={{ color: C.ink }}>Choose your own password</h1>
        <p className="f-body text-sm mb-5" style={{ color: C.muted }}>You signed in with a temporary password. Set a private one of at least {PASSWORD_MIN} characters to continue.</p>
        <PasswordForm onDone={() => { setUser({ ...user, mustChangePassword: false }); notify(user.mfaSetupRequired ? "Password set — now turn on two-step sign-in" : "Password set — welcome to BladeOS"); }} />
        <button onClick={logout} className="f-body text-xs mt-4 w-full text-center hover:underline" style={{ color: C.muted }}>Sign out</button>
      </div>
    </div>
  );
  if (!data) return <Splash error={loadError} onRetry={refresh} onLogout={logout} />;

  const permit = (p) => can(user.roles, p);

  return (
    <ScaleProvider>
    <div className="f-body min-h-screen flex" style={{ background: C.cream }}>
      {toast && <Toast toast={toast} onDone={() => setToast(null)} />}
      {aiOpen && data.insights && <ButcherAI insights={data.insights} onClose={() => setAiOpen(false)} />}
      {mfaOpen && (
        <Modal title="Two-step sign-in" onClose={() => setMfaOpen(false)}>
          {user.mfaEnabled
            ? <MfaDisable onCancel={() => setMfaOpen(false)} onDone={() => { setMfaOpen(false); setUser({ ...user, mfaEnabled: false }); notify("Two-step sign-in is off"); }} />
            : <MfaEnrol onCancel={() => setMfaOpen(false)} onDone={() => { setMfaOpen(false); setUser({ ...user, mfaEnabled: true }); notify("Two-step sign-in is on"); }} />}
        </Modal>
      )}
      {locked && <OfflineLock user={user} onUnlock={() => setLocked(false)} onSignOut={logout} />}
      {syncOpen && <SyncModal user={user} canManage={permit("till.review")} onClose={() => setSyncOpen(false)} onSynced={refresh} />}
      {offPinOpen && <OfflinePinModal user={user} onClose={() => setOffPinOpen(false)} onSaved={() => { setOffPinOpen(false); notify("Offline PIN saved on this till"); }} />}
      {pinOpen && <PinModal onClose={() => setPinOpen(false)} onSave={async (body) => { if (await actions.setPosPin(body)) { setUser({ ...user, posPinSet: true }); setPinOpen(false); } }} />}
      {pwOpen && (
        <Modal title="Change Password" onClose={() => setPwOpen(false)}>
          <PasswordForm onDone={() => { notify("Password changed"); setPwOpen(false); }} />
        </Modal>
      )}
      {iconOpen && <DesktopIconModal onClose={() => setIconOpen(false)} />}
      {sessOpen && (
        <Modal title="Signed-in devices" onClose={() => setSessOpen(false)}>
          <SessionsPanel notify={notify} />
        </Modal>
      )}
      {reportTab && (
        <Modal title="Report Center" onClose={() => setReportTab(null)} wide>
          <Suspense fallback={<Loader2 size={16} className="animate-spin" />}><ReportsView data={data} initialTab={reportTab} notify={notify} /></Suspense>
        </Modal>
      )}

      <Sidebar compact={compact} route={route} setRoute={goTo} mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} user={user} onLogout={logout}
        badges={{ approvals: (data.approvals ? [...data.approvals.adjustments.filter(() => data.approvals.canApproveStock), ...data.approvals.refunds.filter(() => data.approvals.canApproveRefunds)].filter((x) => x.status === "Pending" && !x.mine).length : 0)
          + (data.tills?.review || []).filter((t) => t.status === "Closed" && !t.mine).length,
          purchases: permit("purchasing.approve") ? (data.purchases || []).filter((p) => p.status === "Pending Approval" && p.createdById !== user.id).length : 0,
          payments: (data.payments?.outstanding || 0) + (data.payments?.days || []).filter((d) => d.rec?.status === "Recorded" && !d.rec.mine).length,
          foodsafety: (data.foodSafety?.checklists || []).filter((c) => c.due).length + (permit("haccp.verify") ? (data.foodSafety?.runs || []).filter((r) => !r.verifiedBy && r.completedById !== user.id).length : 0) }} />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar compact={compact}
          notifications={data.notifications} canAI={permit("ai.use")} setAiOpen={setAiOpen}
          onMenuClick={() => setMobileNavOpen(true)} onNavigate={goTo} user={user}
          onPassword={() => setPwOpen(true)} onMfa={() => setMfaOpen(true)} onPin={() => setPinOpen(true)} onLogout={logout} onRefresh={refresh} loadError={loadError}
          onOfflinePin={() => setOffPinOpen(true)} onSync={() => setSyncOpen(true)} onSessions={() => setSessOpen(true)} onDesktopIcon={() => setIconOpen(true)} pending={sync.pending + sync.errors}
        />
        <OfflineBanner sync={sync} offlineSession={offlineSession} onOpen={() => setSyncOpen(true)} onSignIn={logout} />
        <UpdateBanner />
        <main className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7">
          <Suspense fallback={<div className="flex items-center gap-2 f-body text-sm py-10 justify-center" style={{ color: C.muted }}><Loader2 size={16} className="animate-spin" /> Loading…</div>}>
          {route === "dashboard" && <Dashboard data={data} onOpenReport={setReportTab} onNavigate={goTo} />}
          {route === "approvals" && <ApprovalsView data={data} actions={actions} permit={permit} />}
          {route === "ranch" && <RanchView data={data} actions={actions} permit={permit} />}
          {route === "processing" && <ProcessingView data={data} actions={actions} permit={permit} />}
          {route === "inventory" && <InventoryView data={data} actions={actions} permit={permit} />}
          {route === "pos" && <POSView data={data} actions={actions} permit={permit} />}
          {route === "orders" && <OrdersView data={data} actions={actions} permit={permit} />}
          {route === "cashiers" && <CashierSalesView />}
          {route === "customers" && <CustomersView data={data} actions={actions} permit={permit} />}
          {route === "delivery" && <DeliveryView data={data} actions={actions} permit={permit} />}
          {route === "procurement" && <ProcurementView data={data} actions={actions} permit={permit} />}
          {route === "purchases" && <PurchasesView data={data} actions={actions} permit={permit} />}
          {route === "payments" && <PaymentsView data={data} actions={actions} permit={permit} />}
          {route === "foodsafety" && <FoodSafetyView data={data} actions={actions} permit={permit} />}
          {route === "marketing" && <MarketingView data={data} actions={actions} permit={permit} />}
          {route === "reports" && <ReportsView data={data} notify={notify} />}
          {route === "setup" && <SetupView data={data} actions={actions} permit={permit} />}
          {route === "roadmap" && <RoadmapView />}
          {route === "admin" && <AdminView data={data} actions={actions} permit={permit} user={user} />}
          </Suspense>
        </main>
      </div>
    </div>
    </ScaleProvider>
  );
}

/* ============================================================ splash / login */
/** Throw away this device's cached copy of the app (service worker + file cache) and load it fresh.
 *  The offline upload queue and saved data in IndexedDB are left alone. */
async function repairApp() {
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister();
    for (const k of (await window.caches?.keys?.()) || []) await caches.delete(k);
  } catch { /* nothing cached */ }
  window.location.reload();
}

function Splash({ error, onRetry, onLogout }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 10000); return () => clearTimeout(t); }, []);
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: C.cream }}>
      <div className="text-center">
        {error ? (
          <>
            <p className="f-body text-sm mb-4" style={{ color: C.danger }}>{error}</p>
            <div className="flex gap-2 justify-center">
              <Btn icon={RefreshCw} onClick={onRetry}>Try again</Btn>
              <Btn variant="ghost" onClick={onLogout}>Sign out</Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2 f-body text-sm" style={{ color: C.muted }}>
              <Loader2 size={16} className="animate-spin" /> Loading BladeOS…
            </div>
            {slow && (
              <div className="mt-6 max-w-xs mx-auto" data-slow-start>
                <p className="f-body text-xs mb-3" style={{ color: C.muted }}>This is taking longer than usual. Reload, or repair this device's copy of BladeOS (sales saved offline are kept).</p>
                <div className="flex gap-2 justify-center">
                  <Btn small icon={RefreshCw} onClick={() => window.location.reload()}>Reload</Btn>
                  <Btn small variant="ghost" onClick={repairApp}>Repair app</Btn>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin, pending = 0 }) {
  const [privacy, setPrivacy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [busy, run] = useBusy();

  const submit = (e) => {
    e.preventDefault();
    setError(null);
    run(async () => {
      try {
        const r = await api("/auth/login", { method: "POST", body: { email, password } });
        if (r.mfaRequired) { setTicket(r.ticket); setPassword(""); return; }
        onLogin(r.user);
      } catch (err) {
        setError(err.message);
      }
    });
  };

  const inputStyle = { background: C.charcoal, color: C.cream, border: `1px solid ${C.charcoal3}` };
  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden" style={{ background: C.charcoal }}>
      <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: `repeating-linear-gradient(45deg, ${C.gold} 0, ${C.gold} 1px, transparent 1px, transparent 40px)` }} />
      <div className="relative z-10 w-full max-w-md px-6">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: C.burgundy }}>
              <Scissors size={20} color="#fff" />
            </div>
            <span className="f-display text-2xl tracking-wide" style={{ color: C.cream }}>BLADEOS</span>
          </div>
          <h1 className="f-display text-3xl mb-2" style={{ color: C.cream }}>Blades & Butchers</h1>
          <p className="f-body text-sm" style={{ color: C.mutedLight }}>Digital Operations Platform</p>
          <p className="f-display italic text-base mt-4" style={{ color: C.goldLight }}>"From Ranch to Retail. One Digital System."</p>
          {pending > 0 && <p className="f-body text-xs mt-4 rounded-lg px-3 py-2 inline-block" style={{ background: C.charcoal3, color: C.cream }}>{pending} item{pending === 1 ? "" : "s"} saved offline on this till — sign in to upload {pending === 1 ? "it" : "them"}.</p>}
        </div>

        {ticket ? <MfaStep ticket={ticket} onDone={onLogin} onBack={() => setTicket(null)} /> : (
        <form onSubmit={submit} className="rounded-2xl p-6" style={{ background: C.charcoal2, border: `1px solid ${C.charcoal3}` }}>
          <label className="f-body text-xs font-semibold uppercase tracking-wide block mb-1.5" style={{ color: C.mutedLight }} htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full mb-4 rounded-lg px-3.5 py-2.5 f-body text-sm outline-none focus:ring-2" style={{ ...inputStyle, "--tw-ring-color": C.gold }} />
          <label className="f-body text-xs font-semibold uppercase tracking-wide block mb-1.5" style={{ color: C.mutedLight }} htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full mb-5 rounded-lg px-3.5 py-2.5 f-body text-sm outline-none focus:ring-2" style={{ ...inputStyle, "--tw-ring-color": C.gold }} />
          {error && <div className="f-body text-xs mb-4 rounded-lg px-3 py-2" style={{ background: "#3A1E20", color: "#F2B8B5" }}>{error}</div>}
          <button type="submit" disabled={busy} className="w-full f-body font-semibold rounded-lg py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: C.burgundy, color: "#fff" }}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />} Sign In
          </button>
          <p className="f-body text-xs text-center mt-4" style={{ color: C.mutedLight }}>Forgot your password? Ask your administrator to reset it.</p>
        </form>)}
        <button onClick={() => setPrivacy(true)} className="f-body text-xs mt-6 mx-auto block hover:underline" style={{ color: C.mutedLight }}>Privacy notice</button>
        {privacy && (
          <Modal title="Privacy notice" onClose={() => setPrivacy(false)}>
            <div className="f-body text-sm space-y-3" style={{ color: C.ink }}>
              <p>BladeOS is the internal operations system of Blades &amp; Butchers, for authorised staff only. Use is recorded.</p>
              <p><b>Staff:</b> your name, work email, role, sign-ins and the actions you take are recorded for security, cash and stock control, and the audit trail.</p>
              <p><b>Customers:</b> name, phone, delivery area and purchases are kept only to take and deliver orders, issue receipts and refunds, and trace a batch if food safety requires it. Marketing messages go only to customers who agreed. Card numbers are never stored.</p>
              <p>Sales records are kept for six years for tax. Customers can ask to see, correct or erase their details, and staff can ask management. This follows the Nigeria Data Protection Act 2023.</p>
            </div>
          </Modal>
        )}
        <p className="f-body text-center text-xs mt-6" style={{ color: C.mutedLight }}>Digital Web Oracle ICT · Abuja, Nigeria</p>
      </div>
    </div>
  );
}

function PasswordForm({ onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  const mismatch = confirm && next !== confirm;
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      try {
        await api("/auth/password", { method: "POST", body: { current, next } });
        onDone();
      } catch (err) { setError(err.message); }
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
      <Field label="New password" hint={`At least ${PASSWORD_MIN} characters. A short phrase is easier to remember than random symbols.`}><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={PASSWORD_MIN} /></Field>
      <Field label="Confirm new password" error={mismatch ? "Passwords don't match" : null}><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
      {error && <div className="f-body text-xs" style={{ color: C.danger }}>{error}</div>}
      <Btn type="submit" icon={KeyRound} full busy={busy} disabled={!current || next.length < PASSWORD_MIN || next !== confirm || next === current}>Save Password</Btn>
    </form>
  );
}

/* ============================================================ sidebar + topbar */
function Sidebar({ route, setRoute, mobileOpen, onClose, user, onLogout, badges = {}, compact = false }) {
  const lg = (cls) => (compact ? "" : cls); // full-screen till: the menu is a drawer at every screen size
  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => allowed(user.roles, i.id)) })).filter((s) => s.items.length);
  return (
    <>
      {mobileOpen && <div className={`fixed inset-0 z-[65] ${lg("lg:hidden")}`} style={{ background: "rgba(28,24,21,0.55)" }} onClick={onClose} />}
      <aside
        className={`w-72 sm:w-64 shrink-0 flex flex-col h-screen fixed ${lg("lg:sticky")} top-0 inset-y-0 left-0 z-[70] ${lg("lg:z-auto")} transition-transform duration-200 ease-out ${mobileOpen ? "translate-x-0" : `-translate-x-full ${lg("lg:translate-x-0")}`}`}
        style={{ background: C.charcoal }}
      >
        <div className="px-5 py-5 flex items-center gap-2.5 border-b shrink-0" style={{ borderColor: C.charcoal3 }}>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.burgundy }}>
            <Scissors size={16} color="#fff" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="f-display text-base leading-tight" style={{ color: C.cream }}>BLADEOS</div>
            <div className="f-body text-[10px] uppercase tracking-wide truncate" style={{ color: C.mutedLight }}>Blades & Butchers</div>
          </div>
          <button onClick={onClose} aria-label="Close menu" className={`${lg("lg:hidden")} w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 active:scale-95 transition-all shrink-0`}>
            <X size={15} color={C.mutedLight} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-3">
          {sections.map((sec) => (
            <div key={sec.section} className="mb-4">
              <div className="f-body text-[10px] font-semibold uppercase tracking-widest px-3 mb-1.5" style={{ color: C.mutedLight }}>{sec.section}</div>
              {sec.items.map((it) => {
                const active = route === it.id;
                return (
                  <button key={it.id} onClick={() => setRoute(it.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg mb-0.5 f-body text-sm transition-all duration-150 hover:bg-white/5 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1"
                    style={{ background: active ? C.burgundy : "transparent", color: active ? "#fff" : C.mutedLight, "--tw-ring-color": C.gold }}>
                    <it.icon size={15} className="shrink-0" />
                    <span className="truncate flex-1 text-left">{it.label}</span>
                    {badges[it.id] > 0 && <span className="f-mono text-[10px] font-bold min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center" style={{ background: C.gold, color: "#fff" }}>{badges[it.id]}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="px-4 py-4 border-t shrink-0" style={{ borderColor: C.charcoal3 }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full flex items-center justify-center f-mono text-xs font-semibold shrink-0" style={{ background: C.gold, color: "#fff" }}>{initials(user.name)}</div>
            <div className="min-w-0 flex-1">
              <div className="f-body text-xs font-semibold truncate" style={{ color: C.cream }}>{user.name}</div>
              <div className="f-body text-[10px] truncate" style={{ color: C.mutedLight }} title={user.roles.join(" + ")}>{user.roles.join(" + ")}</div>
            </div>
            <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/10 active:scale-95 transition-all shrink-0">
              <LogOut size={15} color={C.mutedLight} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

const TONE = { warn: C.warn, gold: C.gold, burgundy: C.burgundy, danger: C.danger, muted: C.muted, ok: C.ok };

function TopBar({ notifications = [], canAI, setAiOpen, onMenuClick, onNavigate, user, onPassword, onMfa, onPin, onLogout, onRefresh, loadError, onOfflinePin, onSync, onSessions, onDesktopIcon, pending = 0, compact = false }) {
  const [open, setOpen] = useState(null); // "notif" | "user" | null
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <header className="h-16 shrink-0 flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-5 lg:px-8 border-b sticky top-0 z-30" style={{ borderColor: C.border, background: "#fff" }}>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button onClick={onMenuClick} aria-label="Open menu" className={`${compact ? "" : "lg:hidden"} w-9 h-9 shrink-0 rounded-lg flex items-center justify-center hover:bg-stone-100 active:scale-95 transition-all`}>
          <Menu size={18} style={{ color: C.ink }} />
        </button>
        {loadError && <span className="f-body text-xs truncate" style={{ color: C.danger }}>Offline — showing last loaded data</span>}
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 relative shrink-0" ref={ref}>
        <button onClick={onRefresh} aria-label="Refresh data" title="Refresh" className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-stone-100 active:scale-95 transition-all">
          <RefreshCw size={15} style={{ color: C.muted }} />
        </button>
        {canAI && <Btn variant="gold" icon={Sparkles} small label="ButcherAI" onClick={() => setAiOpen(true)}><span className="hidden sm:inline">ButcherAI</span></Btn>}
        <button onClick={() => setOpen(open === "notif" ? null : "notif")} aria-label="Notifications" className="relative w-9 h-9 rounded-lg flex items-center justify-center hover:bg-stone-100 active:scale-95 transition-all">
          <Bell size={16} style={{ color: C.ink }} />
          {notifications.length > 0 && <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full f-mono text-[9px] font-bold flex items-center justify-center" style={{ background: C.danger, color: "#fff" }}>{notifications.length}</span>}
        </button>
        <button onClick={() => setOpen(open === "user" ? null : "user")} aria-label="Account" className="w-9 h-9 rounded-full flex items-center justify-center f-mono text-xs font-semibold active:scale-95 transition-all" style={{ background: C.gold, color: "#fff" }}>
          {initials(user.name)}
        </button>

        {open === "notif" && (
          <div className="absolute right-0 top-11 w-[calc(100vw-1.5rem)] max-w-96 rounded-xl shadow-2xl z-40 overflow-hidden" style={{ background: "#fff", border: `1px solid ${C.border}` }}>
            <div className="px-4 py-3 border-b f-body text-sm font-semibold" style={{ borderColor: C.line, color: C.ink }}>Notifications</div>
            {notifications.length === 0 && <div className="px-4 py-6 f-body text-xs text-center" style={{ color: C.muted }}>All clear — nothing needs attention.</div>}
            {notifications.map((n, i) => {
              const Icon = ICONS[n.icon] || Bell;
              return (
                <button key={i} onClick={() => { onNavigate(n.route); setOpen(null); }}
                  className="w-full text-left flex gap-3 px-4 py-3 border-b last:border-0 hover:bg-stone-50 transition-colors" style={{ borderColor: C.rowLine }}>
                  <Icon size={15} style={{ color: TONE[n.tone] || C.muted, marginTop: 2, flexShrink: 0 }} />
                  <span className="f-body text-xs" style={{ color: C.ink }}>{n.text}</span>
                </button>
              );
            })}
          </div>
        )}
        {open === "user" && (
          <div className="absolute right-0 top-11 w-60 rounded-xl shadow-2xl z-40 overflow-hidden" style={{ background: "#fff", border: `1px solid ${C.border}` }}>
            <div className="px-4 py-3 border-b" style={{ borderColor: C.line }}>
              <div className="f-body text-sm font-semibold truncate" style={{ color: C.ink }}>{user.name}</div>
              <div className="f-body text-xs truncate" style={{ color: C.muted }}>{user.email}</div>
              <div className="f-body text-[10px] uppercase tracking-wide mt-1" style={{ color: C.gold }}>{user.roles.join(" + ")}</div>
            </div>
            <button onClick={() => { setOpen(null); onPassword(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
              <KeyRound size={14} /> Change password
            </button>
            <button onClick={() => { setOpen(null); onSessions(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
              <ShieldCheck size={14} /> Signed-in devices
            </button>
            <button onClick={() => { setOpen(null); onOfflinePin(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
              <KeyRound size={14} /> Offline PIN (this till)
            </button>
            <button onClick={() => { setOpen(null); onSync(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
              <RefreshCw size={14} /> Saved on this till{pending ? ` (${pending})` : ""}
            </button>
            <button onClick={() => { setOpen(null); onDesktopIcon(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
              <MonitorDown size={14} /> Desktop icon
            </button>
            {can(user.roles, "pos.discount") && (
              <button onClick={() => { setOpen(null); onPin(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
                <KeyRound size={14} /> {user.posPinSet ? "Change" : "Set"} till approval PIN
              </button>
            )}
            {(!user.mfaEnabled || !user.mfaRequired) && (
              <button onClick={() => { setOpen(null); onMfa(); }} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.ink }}>
                <ShieldCheck size={14} /> {user.mfaEnabled ? "Turn off two-step sign-in" : "Turn on two-step sign-in"}
              </button>
            )}
            <button onClick={onLogout} className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 f-body text-sm hover:bg-stone-50" style={{ color: C.danger }}>
              <LogOut size={14} /> Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * "Desktop icon" (account menu, everyone): the till icon for Windows (opens straight on the POS, receipts print with
 * no dialog, printer made default) and, on any device, installing BladeOS as an app.
 */
function DesktopIconModal({ onClose }) {
  const [canInstall, setCanInstall] = useState(!!window.__bladeosInstall);
  useEffect(() => { const h = () => setCanInstall(!!window.__bladeosInstall); window.addEventListener("bladeos-installable", h); return () => window.removeEventListener("bladeos-installable", h); }, []);
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || window.matchMedia?.("(display-mode: window-controls-overlay)").matches;
  const ua = navigator.userAgent;
  const windows = /Windows/.test(ua), ios = /iPhone|iPad|iPod/.test(ua), android = /Android/.test(ua);
  const [got, setGot] = useState(false);
  const download = async () => {
    // Fetched, not navigated to, so the installed app's offline cache never answers instead of the server.
    const r = await fetch("/downloads/BladeOS-Till-Setup.cmd", { cache: "no-store" });
    if (!r.ok) throw new Error("Couldn't download the setup file — check the internet connection.");
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "BladeOS-Till-Setup.cmd" });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setGot(true);
  };
  const [busy, run] = useBusy();
  const Step = ({ n, children }) => <li className="flex gap-2.5"><span className="w-5 h-5 shrink-0 rounded-full f-mono text-[11px] flex items-center justify-center" style={{ background: C.gold, color: "#fff" }}>{n}</span><span>{children}</span></li>;
  return (
    <Modal title="Desktop icon" onClose={onClose}>
      <div className="space-y-4 f-body text-sm" style={{ color: C.ink }} data-desktop-icon>
        <section className="rounded-xl p-4 space-y-3" style={{ background: C.cream }}>
          <h4 className="font-semibold flex items-center gap-2"><MonitorDown size={15} style={{ color: C.burgundy }} />Till computer (Windows)</h4>
          <p className="text-xs" style={{ color: C.muted }}>Puts a <b>BladeOS POS</b> icon on the desktop. It opens straight on the POS, full screen, and receipts print at once with no print window. It also finds the receipt printer (e.g. Licon LP100) and makes it the default.</p>
          <Btn icon={Download} busy={busy} onClick={() => run(download)}>Download till icon (Windows)</Btn>
          {!windows && <p className="text-xs" style={{ color: C.muted }}>Download this on the till computer itself.</p>}
          <ol className="space-y-2 text-xs" data-icon-steps>
            <Step n={1}>Open <b>BladeOS-Till-Setup</b> from Downloads. If the browser asks, choose <b>Keep</b>.</Step>
            <Step n={2}>If Windows says “Windows protected your PC”, click <b>More info → Run anyway</b>.</Step>
            <Step n={3}>Answer Y if BladeOS should open when the computer starts. The <b>BladeOS POS</b> icon is now on the desktop.</Step>
            <Step n={4}>Sign in once in the window that opens. From then on, just double-click the icon.</Step>
          </ol>
          {got && <p role="status" className="text-xs" style={{ color: C.ok }}><Check size={13} className="inline mr-1" />Downloaded — open it from the Downloads folder.</p>}
        </section>
        <section className="rounded-xl p-4 space-y-2 border" style={{ borderColor: C.border }}>
          <h4 className="font-semibold">Phone, tablet or office computer</h4>
          {installed ? <p className="text-xs" style={{ color: C.ok }}>BladeOS is already installed on this device.</p>
            : canInstall ? <Btn variant="ghost" icon={Sparkles} onClick={async () => { await window.__bladeosInstall?.(); }}>Install BladeOS app</Btn>
            : <p className="text-xs" style={{ color: C.muted }}>{ios ? "In Safari, tap Share, then Add to Home Screen."
              : android ? "In Chrome, tap ⋮, then Add to Home screen (or Install app)."
              : "In Chrome or Edge, open the browser menu ⋮ → Cast, save and share (Chrome) or Apps (Edge) → Install BladeOS."}</p>}
        </section>
      </div>
    </Modal>
  );
}

/** Managers' till PIN: approves discounts at another person's till. */
function PinModal({ onClose, onSave }) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, run] = useBusy();
  const weak = pin.length >= 4 && weakPin(pin);
  return (
    <Modal title="Till approval PIN" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(() => onSave({ password, pin })); }}>
        <p className="f-body text-sm" style={{ color: C.muted }}>Cashiers call you over for discounts above their limit. You type your email and this PIN on their till. Keep it to yourself.</p>
        <Field label="New PIN (4–6 digits)" error={weak ? "Too easy to guess — avoid 1111 or 1234." : null}>
          <Input mono type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoFocus aria-label="New PIN" />
        </Field>
        <Field label="Your password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" aria-label="Your password" /></Field>
        <Btn type="submit" icon={KeyRound} full busy={busy} disabled={!/^\d{4,6}$/.test(pin) || weak || !password}>Save PIN</Btn>
      </form>
    </Modal>
  );
}
