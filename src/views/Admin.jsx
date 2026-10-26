import React, { useState } from "react";
import { UserPlus, Pencil, ShieldCheck, KeyRound } from "lucide-react";
import { C, initials } from "../lib/theme.js";
import { ROLES, PERMISSIONS, LEADERSHIP_ROLES, COMBINABLE_ROLES, PASSWORD_MIN } from "../shared/permissions.js";
import { SectionHeader, Btn, StatusPill, Modal, Field, Input, Select, Card, Table, useBusy } from "../components/ui.jsx";
import { BackupsCard } from "./Business.jsx";

/* ============================================================ ADMIN */
const PERM_LABELS = {
  "dashboard.view": "Executive dashboard", "reports.view": "Management reports & exports", "ai.use": "ButcherAI",
  "costs.view": "See cost prices, stock value and purchase costs",
  "ranch.view": "View livestock", "ranch.edit": "Add & update animals", "processing.view": "View processing", "processing.edit": "Run processing batches",
  "inventory.view": "View stock levels", "stock.receive": "Receive stock (with delivery reference)", "stock.transfer": "Transfer stock between locations",
  "stock.adjust.request": "Request write-offs & count corrections", "stock.adjust.approve": "Approve write-offs & corrections (not own)",
  "stock.adjust.direct": "Post write-offs & corrections directly", "products.edit": "Add & edit products, prices, costs",
  "pos.use": "POS sales", "orders.view": "View orders", "orders.edit": "Update orders (status, paid, cancel before delivery)",
  "refunds.request": "Request refunds", "refunds.approve": "Approve refunds (not own)", "refunds.direct": "Issue refunds directly",
  "customers.view": "View customers", "customers.edit": "Add customers & record marketing consent", "customers.erase": "Erase a customer's personal data on request", "delivery.view": "Delivery dashboard",
  "procurement.view": "View suppliers", "procurement.edit": "Add suppliers & record invoices", "payables.pay": "Record supplier payments",
  "marketing.view": "View marketing", "marketing.edit": "Edit campaigns & content",
  "setup.manage": "Business Setup: locations & ranches", "users.manage": "Manage staff accounts", "audit.view": "Audit trail",
};

export function AdminView({ data, actions, permit, user }) {
  const users = data.users;
  const [editing, setEditing] = useState(null); // user object or "new"
  const [showMatrix, setShowMatrix] = useState(false);
  const canManage = permit("users.manage");

  return (
    <div>
      {editing && <UserModal target={editing === "new" ? null : editing} me={user} onClose={() => setEditing(null)} actions={actions} />}
      <SectionHeader eyebrow="System" title="Administration" />
      <BackupsCard data={data} actions={actions} permit={permit} />

      {canManage && users && (
        <Card pad={false} className="mb-6">
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b" style={{ borderColor: C.line }}>
            <h3 className="f-display text-base" style={{ color: C.ink }}>Staff Accounts</h3>
            <Btn icon={UserPlus} small onClick={() => setEditing("new")}>Add User</Btn>
          </div>
          <Table head={["Name", "Email", "Role", "Last Sign-in", "Status", ""]} minWidth={720}>
            {users.map((u) => (
              <tr key={u.id} className="border-t" style={{ borderColor: C.rowLine, opacity: u.active ? 1 : 0.6 }}>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center f-mono text-[10px] font-semibold shrink-0" style={{ background: C.cream2, color: C.burgundy }}>{initials(u.name)}</div>
                    <span className="f-body text-sm font-medium" style={{ color: C.ink }}>{u.name}{u.id === user.id ? " (you)" : ""}</span>
                  </div>
                </td>
                <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{u.email}</td>
                <td className="px-5 py-3 f-body text-sm" style={{ color: C.ink }}>
                  {u.role}{u.extraRoles?.length > 0 && <span style={{ color: C.muted }}> + {u.extraRoles.join(", ")}</span>}
                </td>
                <td className="px-5 py-3 f-mono text-xs whitespace-nowrap" style={{ color: C.muted }}>{u.lastLogin}</td>
                <td className="px-5 py-3">{u.active && u.mustChangePassword ? <StatusPill status="Pending" /> : <StatusPill status={u.active ? "Active" : "Inactive"} />}
                  {u.active && u.mustChangePassword && <div className="f-body text-[10px] mt-0.5" style={{ color: C.muted }}>temporary password</div>}
                  {u.mfaEnabled && <div className="f-body text-[10px] mt-0.5 flex items-center gap-1" style={{ color: C.ok }}><ShieldCheck size={10} /> two-step on</div>}</td>
                <td className="px-5 py-3 text-right"><Btn label="Edit user" small variant="ghost" icon={Pencil} onClick={() => setEditing(u)} /></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        <Card>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="f-display text-base" style={{ color: C.ink }}>Roles</h3>
            <Btn small variant="ghost" icon={ShieldCheck} onClick={() => setShowMatrix((v) => !v)}>{showMatrix ? "Hide" : "Show"} permissions</Btn>
          </div>
          {!showMatrix ? (
            <div className="flex flex-wrap gap-2">
              {ROLES.map((r) => <span key={r} className="f-body text-xs px-3 py-1.5 rounded-full" style={{ background: C.cream, color: C.ink }}>{r}</span>)}
            </div>
          ) : (
            <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
              {Object.entries(PERMISSIONS).map(([p, roles]) => (
                <div key={p}>
                  <div className="f-body text-xs font-semibold" style={{ color: C.ink }}>{PERM_LABELS[p] || p}</div>
                  <div className="f-body text-[11px]" style={{ color: C.muted }}>{roles.join(", ")}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <h3 className="f-display text-base mb-3" style={{ color: C.ink }}>Integrations</h3>
          <div className="space-y-2">
            {["WhatsApp Business", "Paystack / Flutterwave", "Digital Scale", "Accounting Software", "Social Media"].map((i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2.5" style={{ background: C.cream }}>
                <span className="f-body text-sm truncate" style={{ color: C.ink }}>{i}</span>
                <StatusPill status="Planned" />
              </div>
            ))}
          </div>
          <p className="f-body text-xs mt-3" style={{ color: C.muted }}>See the Roadmap for when each integration arrives.</p>
        </Card>
      </div>

      {data.audit && (
        <Card>
          <h3 className="f-display text-base mb-3" style={{ color: C.ink }}>Audit Trail</h3>
          <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
            {data.audit.map((a, i) => (
              <div key={i} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 f-body text-xs" style={{ color: C.muted }}>
                <span className="font-semibold sm:w-36 shrink-0 truncate" style={{ color: C.ink }}>{a.who}</span>
                <span className="flex-1">{a.action}{a.detail && <> <span style={{ color: C.burgundy }}>{a.detail}</span></>}</span>
                <span className="f-mono shrink-0">{a.at}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function UserModal({ target, me, onClose, actions }) {
  const isNew = !target;
  const [name, setName] = useState(target?.name || "");
  const [email, setEmail] = useState(target?.email || "");
  const [role, setRole] = useState(target?.role || "Cashier");
  const [extras, setExtras] = useState(target?.extraRoles || []);
  const [active, setActive] = useState(target?.active ?? true);
  const [password, setPassword] = useState("");
  const [busy, run] = useBusy();
  const self = target?.id === me.id;
  const isSuper = me.role === "Super Admin";
  // Only the Super Admin grants (or changes) Super Admin, Owner, Managing Director and Administrator accounts.
  const roleOptions = isSuper ? ROLES : ROLES.filter((r) => !LEADERSHIP_ROLES.includes(r));
  const locked = target && LEADERSHIP_ROLES.includes(target.role) && !isSuper;
  const leader = LEADERSHIP_ROLES.includes(role);
  const extraOptions = COMBINABLE_ROLES.filter((r) => r !== role);
  const cleanExtras = leader ? [] : extras.filter((r) => r !== role);

  const pwOk = (p) => p.length >= PASSWORD_MIN;
  const valid = name.trim().length >= 2 && (isNew ? /\S+@\S+\.\S+/.test(email) && pwOk(password) : !password || pwOk(password));
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      let r;
      if (isNew) r = await actions.createUser({ name: name.trim(), email: email.trim(), role, extraRoles: cleanExtras, password });
      else {
        const body = {};
        if (name.trim() !== target.name) body.name = name.trim();
        if (role !== target.role) body.role = role;
        if (cleanExtras.join() !== (target.extraRoles || []).join()) body.extraRoles = cleanExtras;
        if (active !== target.active) body.active = active;
        if (password) body.password = password;
        if (!Object.keys(body).length) return onClose();
        r = await actions.updateUser(target.id, body);
      }
      if (r) onClose();
    });
  };

  return (
    <Modal title={isNew ? "Add User" : `Edit ${target.name}`} onClose={onClose}>
      {locked ? <p className="f-body text-sm" style={{ color: C.muted }}>Only the Super Admin can change Super Admin, Owner, Managing Director or Administrator accounts.</p> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={!isNew} autoComplete="off" /></Field>
          <Field label="Main role" hint={self ? "You can't change your own roles." : "Decides which screen they start on."}>
            <Select value={role} onChange={(e) => setRole(e.target.value)} disabled={self}>{roleOptions.map((r) => <option key={r}>{r}</option>)}</Select>
          </Field>
          {!leader && (
            <div>
              <div className="f-body text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: C.muted }}>Also works as (optional)</div>
              <div className="grid grid-cols-2 gap-1.5">
                {extraOptions.map((r) => (
                  <label key={r} className="flex items-center gap-2 f-body text-xs rounded-lg px-2.5 py-2 border cursor-pointer" style={{ borderColor: C.input, color: C.ink, opacity: self ? 0.5 : 1 }}>
                    <input type="checkbox" disabled={self} checked={extras.includes(r)} onChange={(e) => setExtras((p) => e.target.checked ? [...p, r] : p.filter((x) => x !== r))} /> {r}
                  </label>
                ))}
              </div>
              <p className="f-body text-[11px] mt-1.5" style={{ color: C.muted }}>For staff who cover two jobs, e.g. Cashier and Storekeeper. Approvals still need a different person.</p>
            </div>
          )}
          {leader && <p className="f-body text-xs" style={{ color: C.muted }}>{role} accounts can't hold additional roles.</p>}
          {!isNew && !self && (
            <label className="flex items-center gap-2 f-body text-sm" style={{ color: C.ink }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Account active (can sign in)
            </label>
          )}
          <Field label={isNew ? "Temporary password" : "Reset to a temporary password (optional)"} hint={`At least ${PASSWORD_MIN} characters. Share it privately — they must choose their own at first sign-in.`}>
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={isNew ? PASSWORD_MIN : undefined} required={isNew} />
          </Field>
          <Btn type="submit" icon={isNew ? UserPlus : KeyRound} full busy={busy} disabled={!valid}>{isNew ? "Create User" : "Save Changes"}</Btn>
          {!isNew && !self && target.mfaEnabled && (
            <div className="rounded-lg px-3 py-2.5 flex items-center justify-between gap-2" style={{ background: C.cream }}>
              <span className="f-body text-xs" style={{ color: C.ink }}>Lost phone? Reset two-step sign-in — they set it up again at next sign-in.</span>
              <Btn small variant="danger" busy={busy} onClick={() => run(async () => { if (await actions.updateUser(target.id, { resetMfa: true })) onClose(); })}>Reset</Btn>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
