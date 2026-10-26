// Offline mode screens: sign-in with the till PIN, idle lock, status banner, sync queue, PIN setup, app update.
import React, { useEffect, useState } from "react";
import { WifiOff, Wifi, RefreshCw, AlertTriangle, Check, Lock, KeyRound, Download, CloudUpload, Trash2, RotateCcw, Scissors, Sparkles } from "lucide-react";
import { C, nairaFmt } from "../lib/theme.js";
import { Btn, Modal, Field, Input, Empty, useBusy } from "../components/ui.jsx";
import {
  deviceUsers, checkOfflinePin, loadSnapshot, setOfflinePin, outbox, syncNow, retryItem, exportOutbox, offlineAgeHours,
  OFFLINE_WARN_HOURS, OFFLINE_STOP_HOURS,
} from "../lib/offline.js";

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const PinPad = ({ value, onChange, onEnter }) => (
  <div className="grid grid-cols-3 gap-2">
    {["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "go"].map((k) => (
      <button key={k} type="button" aria-label={k === "go" ? "Unlock" : k === "clear" ? "Clear" : k}
        onClick={() => (k === "clear" ? onChange("") : k === "go" ? onEnter() : value.length < 6 && onChange(value + k))}
        className="f-mono text-xl font-semibold py-3 rounded-xl active:scale-95"
        style={{ background: k === "go" ? C.burgundy : C.charcoal3, color: k === "go" ? "#fff" : C.cream }}>
        {k === "go" ? "OK" : k === "clear" ? "C" : k}
      </button>
    ))}
  </div>
);

/* ============================================================ start-up with no internet */
export function OfflineSignIn({ onSignedIn, onTryOnline, pending }) {
  const [users, setUsers] = useState(null);
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  useEffect(() => { deviceUsers().then(setUsers); }, []);
  const usable = (users || []).filter((u) => u.hasPin);
  const enter = async () => {
    if (!who || pin.length < 4) return;
    setError(null);
    if (!(await checkOfflinePin(who.id, pin))) { setPin(""); setError("Wrong PIN. After 5 wrong tries the PIN is removed and you'll need the internet to sign in."); deviceUsers().then(setUsers); return; }
    const snap = await loadSnapshot(who.id);
    if (!snap) { setError("No saved copy for this person on this till."); return; }
    onSignedIn(snap);
  };
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: C.charcoal }} data-offline-signin>
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: C.burgundy }}><Scissors size={18} color="#fff" /></div>
          <span className="f-display text-2xl" style={{ color: C.cream }}>BLADEOS</span>
        </div>
        <div className="rounded-2xl p-5 space-y-4" style={{ background: C.charcoal2, border: `1px solid ${C.charcoal3}` }}>
          <div className="flex items-center gap-2 f-body text-sm" style={{ color: C.goldLight }}><WifiOff size={16} /> No internet — offline sign-in</div>
          {pending > 0 && <p className="f-body text-xs" style={{ color: C.mutedLight }}>{plural(pending, "item")} on this till waiting to upload.</p>}
          {users === null ? <p className="f-body text-sm" style={{ color: C.mutedLight }}>Checking this till…</p>
            : !usable.length ? (
              <p className="f-body text-sm" style={{ color: C.cream }}>Nobody has set an offline PIN on this till, so BladeOS needs the internet to sign in. (Set one from the account menu next time you're online.)</p>
            ) : !who ? (
              <div className="space-y-2">
                <p className="f-body text-xs" style={{ color: C.mutedLight }}>Who's signing in?</p>
                {usable.map((u) => (
                  <button key={u.id} onClick={() => setWho(u)} className="w-full text-left rounded-xl px-4 py-3 f-body" style={{ background: C.charcoal3, color: C.cream }}>
                    <div className="text-sm font-semibold">{u.name}</div><div className="text-xs" style={{ color: C.mutedLight }}>{u.role}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between f-body text-sm" style={{ color: C.cream }}>
                  <span>{who.name}</span><button className="text-xs underline" style={{ color: C.mutedLight }} onClick={() => { setWho(null); setPin(""); setError(null); }}>Change</button>
                </div>
                <div className="f-mono text-3xl tracking-[0.5em] text-center py-2" style={{ color: C.cream }} aria-label="PIN entered">{"•".repeat(pin.length) || " "}</div>
                <PinPad value={pin} onChange={setPin} onEnter={enter} />
              </div>
            )}
          {error && <p className="f-body text-xs" style={{ color: "#F0A39C" }}>{error}</p>}
          <button onClick={onTryOnline} className="w-full f-body text-xs flex items-center justify-center gap-1.5 pt-1" style={{ color: C.mutedLight }}><RefreshCw size={12} /> Internet's back? Sign in normally</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ idle lock while offline */
export function OfflineLock({ user, onUnlock, onSignOut }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  const [hasPin, setHasPin] = useState(null);
  useEffect(() => { import("../lib/offline.js").then((m) => m.hasOfflinePin(user.id)).then(setHasPin); }, [user.id]);
  const enter = async () => {
    if (pin.length < 4) return;
    if (await checkOfflinePin(user.id, pin)) onUnlock();
    else { setPin(""); setError("Wrong PIN."); }
  };
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center px-4" style={{ background: C.charcoal }} data-offline-lock>
      <div className="w-full max-w-xs space-y-4 text-center">
        <Lock size={28} style={{ color: C.goldLight, margin: "0 auto" }} />
        <div className="f-display text-xl" style={{ color: C.cream }}>Locked — {user.name}</div>
        {hasPin === false ? (
          <p className="f-body text-sm" style={{ color: C.mutedLight }}>No offline PIN on this till. Sign out, then sign in when the internet is back.</p>
        ) : (<>
          <div className="f-mono text-3xl tracking-[0.5em]" style={{ color: C.cream }}>{"•".repeat(pin.length) || " "}</div>
          <PinPad value={pin} onChange={setPin} onEnter={enter} />
        </>)}
        {error && <p className="f-body text-xs" style={{ color: "#F0A39C" }}>{error}</p>}
        <button onClick={onSignOut} className="f-body text-xs underline" style={{ color: C.mutedLight }}>Sign out</button>
      </div>
    </div>
  );
}

/* ============================================================ banner */
export function OfflineBanner({ sync, offlineSession, onOpen, onSignIn }) {
  const [age, setAge] = useState(0);
  useEffect(() => { offlineAgeHours().then(setAge); const t = setInterval(() => offlineAgeHours().then(setAge), 60000); return () => clearInterval(t); }, [sync.online, sync.pending]);
  let tone = null, icon = null, text = null, action = null;
  if (offlineSession && sync.online) {
    tone = "#E7F0E9"; icon = Wifi; text = `Back online.${sync.pending ? ` Sign in to upload ${plural(sync.pending, "item")} from this till.` : " Sign in to carry on."}`;
    action = <Btn small onClick={onSignIn}>Sign in</Btn>;
  } else if (!sync.online) {
    tone = age > OFFLINE_WARN_HOURS ? "#F5E4E2" : "#F6EEDD"; icon = WifiOff;
    text = `Offline — sales are saved on this till and upload when the internet is back${sync.pending ? ` · ${plural(sync.pending, "item")} waiting` : ""}.`
      + (age > OFFLINE_STOP_HOURS ? ` Over ${OFFLINE_STOP_HOURS} hours offline — selling is paused until it uploads.` : age > OFFLINE_WARN_HOURS ? ` Offline for ${Math.floor(age)} hours — get connected today.` : "");
  } else if (sync.syncing) {
    tone = "#F6EEDD"; icon = CloudUpload; text = `Uploading ${plural(sync.pending, "item")} saved offline…`;
  } else if (sync.errors) {
    tone = "#F5E4E2"; icon = AlertTriangle; text = `${plural(sync.errors, "item")} from offline couldn't upload — tap to review.`;
  } else if (sync.pending) {
    tone = "#F6EEDD"; icon = CloudUpload;
    text = sync.needsSignIn ? `${plural(sync.pending, "item")} waiting — sign in again to upload.` : sync.waitingFor.length ? `${plural(sync.pending, "item")} waiting for ${sync.waitingFor.join(", ")} (or a manager) to sign in on this till.` : `${plural(sync.pending, "item")} waiting to upload.`;
  } else if (sync.lastSync && Date.now() - sync.lastSync < 60000) {
    tone = "#E7F0E9"; icon = Check; text = "Everything from offline has been uploaded.";
  }
  if (!text) return null;
  const Icon = icon;
  return (
    <div role="status" data-offline-banner className="px-4 sm:px-8 py-2 flex items-center justify-between gap-3 border-b" style={{ background: tone, borderColor: C.border }}>
      <button onClick={onOpen} className="f-body text-xs sm:text-sm flex items-center gap-2 text-left" style={{ color: C.ink }}><Icon size={15} className="shrink-0" />{text}</button>
      {action}
    </div>
  );
}

/* ============================================================ sync queue */
const KIND = { sale: "Sale", void: "Cleared ticket", temp: "Temperature", haccp: "Checklist" };
export function SyncModal({ user, canManage, onClose, onSynced }) {
  const [items, setItems] = useState(null);
  const [busy, run] = useBusy();
  const load = () => outbox.all().then(setItems);
  useEffect(() => { load(); }, []);
  const syncAll = () => run(async () => { const n = await syncNow(user, { canUploadForOthers: canManage }); await load(); if (n) onSynced?.(); });
  return (
    <Modal title="Saved on this till" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="f-body text-xs" style={{ color: C.muted }}>Everything done here while offline. It uploads by itself; you can also upload now.</p>
        {items && !items.length && <Empty>Nothing waiting — everything is uploaded.</Empty>}
        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
          {(items || []).map((it) => (
            <div key={it.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: it.status === "error" ? "#F5E4E2" : C.cream }} data-outbox-item>
              <div className="min-w-0 f-body">
                <div className="text-sm truncate" style={{ color: C.ink }}>{KIND[it.kind]} · {it.label}</div>
                <div className="text-[11px]" style={{ color: it.status === "error" ? C.danger : C.muted }}>
                  {new Date(it.createdAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })} · {it.userName}
                  {it.status === "error" ? ` · couldn't upload: ${it.error}` : " · waiting"}
                </div>
              </div>
              {it.status === "error" && (
                <div className="flex gap-1 shrink-0">
                  <Btn small variant="ghost" icon={RotateCcw} onClick={async () => { await retryItem(it.id); load(); }}>Retry</Btn>
                  {canManage && <Btn label="Remove from this till" small variant="danger" icon={Trash2} onClick={async () => { if (window.confirm(`Remove ${KIND[it.kind].toLowerCase()} ${it.label} from this till without uploading it? Record it by hand if it really happened.`)) { await outbox.remove(it.id); load(); } }} />}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn icon={CloudUpload} busy={busy} disabled={!items?.length} onClick={syncAll}>Upload now</Btn>
          <Btn variant="ghost" icon={Download} disabled={!items?.length} onClick={exportOutbox}>Save a copy (file)</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================ offline PIN setup */
export function OfflinePinModal({ user, onClose, onSaved }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, run] = useBusy();
  const weak = pin.length >= 4 && (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin));
  const valid = /^\d{4,6}$/.test(pin) && pin === again && !weak;
  return (
    <Modal title="Offline PIN for this till" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) run(async () => { await setOfflinePin(user.id, pin); onSaved(); }); }}>
        <p className="f-body text-sm" style={{ color: C.muted }}>If the internet goes down, you sign in on <b>this till</b> with this PIN and keep selling. It's stored only on this computer — set it on each till you use.</p>
        <Field label="PIN (4–6 digits)" error={weak ? "Too easy to guess." : null}>
          <Input mono type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoFocus aria-label="Offline PIN" />
        </Field>
        <Field label="Same PIN again" error={again && again !== pin ? "Doesn't match." : null}>
          <Input mono type="password" inputMode="numeric" maxLength={6} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} aria-label="Offline PIN again" />
        </Field>
        <Btn type="submit" icon={KeyRound} full busy={busy} disabled={!valid}>Save offline PIN</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ new version ready */
export function UpdateBanner() {
  const [ready, setReady] = useState(false);
  useEffect(() => { const h = () => setReady(true); window.addEventListener("bladeos-update", h); if (window.__bladeosUpdate) setReady(true); return () => window.removeEventListener("bladeos-update", h); }, []);
  if (!ready) return null;
  const apply = () => {
    if (window.__bladeosBusy) { alert("Finish or hold the current sale first."); return; }
    window.__bladeosUpdate?.();
  };
  return (
    <div className="px-4 sm:px-8 py-2 flex items-center justify-between gap-3 border-b" style={{ background: "#E7F0E9", borderColor: C.border }} data-update-banner>
      <span className="f-body text-xs sm:text-sm flex items-center gap-2" style={{ color: C.ink }}><Sparkles size={15} /> A new version of BladeOS is ready.</span>
      <Btn small onClick={apply}>Update now</Btn>
    </div>
  );
}
