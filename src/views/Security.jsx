import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck, Copy, Check, Smartphone, Loader2 } from "lucide-react";
import { api } from "../lib/api.js";
import { C } from "../lib/theme.js";
import { Btn, Field, Input, useBusy } from "../components/ui.jsx";

/** Second step of sign-in: authenticator code, or a recovery code. */
export function MfaStep({ ticket, onDone, onBack }) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  const submit = (e) => {
    e.preventDefault();
    setError(null);
    run(async () => {
      try {
        const r = await api("/auth/mfa", { method: "POST", body: useRecovery ? { ticket, recoveryCode: code } : { ticket, code } });
        onDone(r.user);
      } catch (err) { setError(err.message); if (err.status === 401 && /too long|password again/.test(err.message)) setTimeout(onBack, 1500); }
    });
  };
  const inputStyle = { background: C.charcoal, color: C.cream, border: `1px solid ${C.charcoal3}`, "--tw-ring-color": C.gold };
  return (
    <form onSubmit={submit} className="rounded-2xl p-6" style={{ background: C.charcoal2, border: `1px solid ${C.charcoal3}` }}>
      <div className="flex items-center gap-2 mb-2"><Smartphone size={16} color={C.goldLight} /><span className="f-body text-sm font-semibold" style={{ color: C.cream }}>Two-step sign-in</span></div>
      <p className="f-body text-xs mb-4" style={{ color: C.mutedLight }}>{useRecovery ? "Enter one of your saved recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app."}</p>
      <input id="mfa-code" autoFocus inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)}
        placeholder={useRecovery ? "XXXX-XXXX" : "123456"} maxLength={useRecovery ? 9 : 6}
        className="w-full mb-4 rounded-lg px-3.5 py-2.5 f-mono text-lg tracking-widest text-center outline-none focus:ring-2" style={inputStyle} />
      {error && <div className="f-body text-xs mb-4 rounded-lg px-3 py-2" style={{ background: "#3A1E20", color: "#F2B8B5" }}>{error}</div>}
      <button type="submit" disabled={busy || code.trim().length < (useRecovery ? 8 : 6)} className="w-full f-body font-semibold rounded-lg py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: C.burgundy, color: "#fff" }}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Verify
      </button>
      <div className="flex justify-between mt-4">
        <button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }} className="f-body text-xs hover:underline" style={{ color: C.mutedLight }}>
          {useRecovery ? "Use the authenticator app" : "Lost your phone? Use a recovery code"}
        </button>
        <button type="button" onClick={onBack} className="f-body text-xs hover:underline" style={{ color: C.mutedLight }}>Back</button>
      </div>
    </form>
  );
}

/** Turn two-step sign-in off (optional unless REQUIRE_TWO_STEP is set): confirm with a current code or a recovery code. */
export function MfaDisable({ onDone, onCancel }) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  const submit = (e) => {
    e.preventDefault();
    setError(null);
    run(async () => {
      try { await api("/auth/mfa/disable", { method: "POST", body: useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() } }); onDone(); }
      catch (err) { setError(err.message); }
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4" data-mfa-disable>
      <p className="f-body text-sm" style={{ color: C.muted }}>After this, you sign in with your password only. You can turn it on again any time from the account menu.</p>
      <Field label={useRecovery ? "Recovery code" : "Code from your authenticator app"}>
        <Input mono autoFocus inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)}
          placeholder={useRecovery ? "XXXX-XXXX" : "123456"} maxLength={useRecovery ? 9 : 6} aria-label="Two-step code" />
      </Field>
      {error && <p role="alert" className="f-body text-xs" style={{ color: C.danger }}>{error}</p>}
      <div className="flex flex-wrap gap-2 items-center">
        <Btn type="submit" variant="danger" busy={busy} disabled={code.trim().length < (useRecovery ? 8 : 6)}>Turn off two-step sign-in</Btn>
        <Btn type="button" variant="ghost" onClick={onCancel}>Cancel</Btn>
        <button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }} className="f-body text-xs hover:underline ml-auto" style={{ color: C.muted }}>
          {useRecovery ? "Use the authenticator app" : "Lost your phone? Use a recovery code"}
        </button>
      </div>
    </form>
  );
}

/** Enrolment: scan, confirm a code, save recovery codes. */
export function MfaEnrol({ required, onDone, onCancel }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();

  useEffect(() => {
    api("/auth/mfa/setup", { method: "POST" })
      .then(async (s) => {
        setSetup(s);
        try {
          const svg = await QRCode.toString(s.uri, { type: "svg", margin: 1, width: 200 });
          setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
        } catch { /* the key below still works for manual entry */ }
      })
      .catch((e) => setError(e.message));
  }, []);

  const enable = (e) => {
    e.preventDefault();
    setError(null);
    run(async () => {
      try { setCodes((await api("/auth/mfa/enable", { method: "POST", body: { code } })).recoveryCodes); }
      catch (err) { setError(err.message); }
    });
  };
  const copy = async () => { try { await navigator.clipboard.writeText(codes.join("\n")); setCopied(true); } catch {} };

  if (codes) return (
    <div>
      <h2 className="f-display text-xl mb-1" style={{ color: C.ink }}>Save your recovery codes</h2>
      <p className="f-body text-sm mb-4" style={{ color: C.muted }}>If you lose your phone, each code signs you in once. Store them somewhere safe and private — not on the same phone.</p>
      <div className="grid grid-cols-2 gap-2 rounded-xl p-4 mb-3" style={{ background: C.cream }}>
        {codes.map((c) => <div key={c} className="f-mono text-sm text-center" style={{ color: C.ink }}>{c}</div>)}
      </div>
      <Btn variant="ghost" small icon={copied ? Check : Copy} onClick={copy}>{copied ? "Copied" : "Copy codes"}</Btn>
      <label className="flex items-center gap-2 f-body text-sm my-4" style={{ color: C.ink }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved these codes
      </label>
      <Btn full icon={ShieldCheck} disabled={!saved} onClick={onDone}>Finish</Btn>
    </div>
  );

  return (
    <form onSubmit={enable}>
      <h2 className="f-display text-xl mb-1" style={{ color: C.ink }}>Turn on two-step sign-in</h2>
      <p className="f-body text-sm mb-4" style={{ color: C.muted }}>
        {required ? "Your role can approve money and stock, so a password alone isn't enough. " : ""}
        Install an authenticator app (Google Authenticator, Microsoft Authenticator or Authy), scan this code, then enter the 6 digits it shows.
      </p>
      <div className="flex flex-col items-center mb-4">
        {qr ? <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="rounded-lg" /> : <div className="w-[200px] h-[200px] flex items-center justify-center"><Loader2 className="animate-spin" size={20} style={{ color: C.muted }} /></div>}
        {setup && <div className="f-body text-[11px] mt-2 text-center" style={{ color: C.muted }}>Can't scan? Enter this key: <span className="f-mono select-all break-all" style={{ color: C.ink }}>{setup.secret}</span></div>}
      </div>
      <Field label="6-digit code"><Input mono inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} placeholder="123456" /></Field>
      {error && <div className="f-body text-xs mt-2" style={{ color: C.danger }}>{error}</div>}
      <div className="flex gap-2 mt-4">
        {!required && onCancel && <Btn variant="ghost" full onClick={onCancel}>Not now</Btn>}
        <Btn type="submit" full icon={ShieldCheck} busy={busy} disabled={!setup || code.trim().length !== 6}>Turn On</Btn>
      </div>
    </form>
  );
}

/** Where this account is signed in — with a way to end every other session (a lost phone, a shared PC left signed in). */
export function SessionsPanel({ notify }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, run] = useBusy();
  const load = () => api("/auth/sessions").then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const device = (ua = "") => {
    if (!ua) return "Unknown device";
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone / iPad" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
    const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    return `${br} on ${os}`;
  };
  const when = (d) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });
  const others = (list || []).filter((s) => !s.current).length;
  return (
    <div>
      {error && <p className="f-body text-xs mb-3" style={{ color: C.danger }}>{error}</p>}
      {!list ? <p className="f-body text-sm" style={{ color: C.muted }}><Loader2 size={14} className="inline animate-spin mr-1" /> Loading…</p> : (
        <ul className="space-y-2 mb-5">
          {list.map((s, i) => (
            <li key={i} className="rounded-lg px-3 py-2.5 flex items-center justify-between gap-3" style={{ background: C.cream }}>
              <span className="min-w-0">
                <span className="f-body text-sm font-medium block truncate" style={{ color: C.ink }}>{device(s.device)}{s.current && <span className="ml-2 f-body text-[10px] uppercase tracking-wide" style={{ color: C.ok }}>This device</span>}</span>
                <span className="f-mono text-xs block truncate" style={{ color: C.muted }}>Last active {when(s.lastSeen)}{s.ip ? ` · ${s.ip}` : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Btn full variant="danger" busy={busy} disabled={!others} onClick={() => run(async () => {
        try { const r = await api("/auth/sessions/end-others", { method: "POST", body: {} }); notify?.(`Signed out of ${r.ended} other device${r.ended === 1 ? "" : "s"}`); await load(); }
        catch (e) { setError(e.message); }
      })}>{others ? `Sign out of ${others} other device${others === 1 ? "" : "s"}` : "No other devices signed in"}</Btn>
      <p className="f-body text-xs mt-3" style={{ color: C.muted }}>Changing your password also signs you out everywhere else.</p>
    </div>
  );
}
