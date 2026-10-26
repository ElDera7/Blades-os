import React, { useState } from "react";
import { api } from "../lib/api.js";
import { Plus, Pencil, Check, Trash2, Download, CalendarDays, Mail, Cake, Send, Copy, Settings2 } from "lucide-react";
import { C, nairaFmt, exportCsv } from "../lib/theme.js";
import { CONTENT_STATUSES } from "../shared/permissions.js";
import { KpiCard, SectionHeader, Btn, StatusPill, Modal, Field, Input, Select, Card, Table, Empty, ICONS, useBusy } from "../components/ui.jsx";

const PLATFORMS = ["Instagram", "TikTok", "Facebook", "WhatsApp", "X (Twitter)", "All Channels"];
const POST_TYPES = ["Product Spotlight", "Butcher Tip", "Behind the Scenes", "Recipe", "Weekend Offer", "Customer Testimonial", "Lifestyle / Family Food"];
const todayIso = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function MarketingView({ data, actions, permit }) {
  const campaigns = data.campaigns || [];
  const content = data.content || [];
  const canEdit = permit("marketing.edit");
  const [modal, setModal] = useState(null); // { kind: "campaign"|"post", item? }
  const [confirm, setConfirm] = useState(null);

  const spend = campaigns.reduce((s, c) => s + c.budget, 0);
  const revenue = campaigns.reduce((s, c) => s + c.revenue, 0);
  const leads = campaigns.reduce((s, c) => s + c.leads, 0);
  const orders = campaigns.reduce((s, c) => s + c.orders, 0);
  const today = todayIso();
  const upcoming = content.filter((p) => p.date >= today);
  const recent = content.filter((p) => p.date < today).reverse();

  const doExport = () => {
    const ok = exportCsv("bladeos-campaigns.csv", campaigns.map(({ id, ...c }) => ({ ...c, roas: c.budget ? (c.revenue / c.budget).toFixed(2) : "" })));
    actions.notify(ok ? "Campaigns exported" : "Nothing to export", ok ? "ok" : "error");
  };
  const remove = async () => {
    const { kind, item } = confirm;
    const ok = kind === "campaign" ? await actions.deleteCampaign(item.id, item.name) : await actions.deletePost(item.id);
    if (ok) setConfirm(null);
  };

  return (
    <div>
      {modal?.kind === "campaign" && <CampaignForm item={modal.item} onClose={() => setModal(null)} actions={actions} />}
      {modal?.kind === "post" && <PostForm item={modal.item} onClose={() => setModal(null)} actions={actions} />}
      {confirm && (
        <Modal title="Delete?" onClose={() => setConfirm(null)}>
          <p className="f-body text-sm mb-5" style={{ color: C.ink }}>Delete {confirm.kind === "campaign" ? `the campaign "${confirm.item.name}"` : `the post "${confirm.item.title}"`}? This can't be undone.</p>
          <div className="flex gap-2"><Btn variant="ghost" full onClick={() => setConfirm(null)}>Keep it</Btn><Btn variant="danger" icon={Trash2} full onClick={remove}>Delete</Btn></div>
        </Modal>
      )}

      <SectionHeader eyebrow="Marketing" title="Marketing & Content" action={<>
        {campaigns.length > 0 && <Btn icon={Download} small variant="ghost" onClick={doExport}>Export</Btn>}
        {canEdit && <Btn icon={Plus} small onClick={() => setModal({ kind: "campaign" })}>Add Campaign</Btn>}
      </>} />

      {data.emailMarketing && <EmailMarketing em={data.emailMarketing} canEdit={canEdit} actions={actions} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <KpiCard label="Ad Spend" value={nairaFmt(spend)} icon={ICONS.DollarSign} />
        <KpiCard label="Leads" value={leads.toLocaleString("en-NG")} icon={ICONS.MessageCircle} />
        <KpiCard label="Orders" value={orders.toLocaleString("en-NG")} icon={ICONS.ClipboardList} />
        <KpiCard label="Blended ROAS" value={spend ? `${(revenue / spend).toFixed(2)}x` : "—"} sub={revenue ? `${nairaFmt(revenue)} revenue` : null} icon={ICONS.TrendingUp} />
      </div>

      <Card pad={false} className="mb-6">
        <div className="px-5 py-4 border-b f-display text-base" style={{ borderColor: C.line, color: C.ink }}>Campaign Performance</div>
        <Table head={["Campaign", "Platform", "Budget", "Leads", "Orders", "Revenue", "ROAS", ""]} minWidth={820}
          empty={campaigns.length === 0 ? (canEdit ? "No campaigns yet — add one, then update leads, orders and revenue as results come in." : "No campaigns yet.") : null}>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-t" style={{ borderColor: C.rowLine }}>
              <td className="px-5 py-3 f-body text-sm font-medium" style={{ color: C.ink }}>{c.name}</td>
              <td className="px-5 py-3 f-body text-xs" style={{ color: C.muted }}>{c.platform}</td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{nairaFmt(c.budget)}</td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{c.leads}</td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{c.orders}</td>
              <td className="px-5 py-3 f-mono text-sm font-semibold" style={{ color: C.burgundy }}>{nairaFmt(c.revenue)}</td>
              <td className="px-5 py-3 f-mono text-sm font-semibold" style={{ color: C.ok }}>{c.budget ? `${(c.revenue / c.budget).toFixed(2)}x` : "—"}</td>
              <td className="px-5 py-3">
                {canEdit && <div className="flex gap-1 justify-end">
                  <Btn label="Edit campaign" small variant="ghost" icon={Pencil} onClick={() => setModal({ kind: "campaign", item: c })} />
                  <Btn label="Delete campaign" small variant="ghost" icon={Trash2} onClick={() => setConfirm({ kind: "campaign", item: c })} />
                </div>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-2 mb-4">
          <h3 className="f-display text-base flex items-center gap-2" style={{ color: C.ink }}><CalendarDays size={15} /> Content Calendar</h3>
          {canEdit && <Btn small icon={Plus} onClick={() => setModal({ kind: "post" })}>Add Post</Btn>}
        </div>
        {content.length === 0 && <Empty>Nothing planned. Add posts to plan the week's content and track approvals.</Empty>}
        {upcoming.length > 0 && <PostGrid posts={upcoming} canEdit={canEdit} onEdit={(p) => setModal({ kind: "post", item: p })} onDelete={(p) => setConfirm({ kind: "post", item: p })} today={today} />}
        {recent.length > 0 && (<>
          <div className="f-body text-[10px] uppercase tracking-widest mt-5 mb-2" style={{ color: C.muted }}>Last 14 days</div>
          <PostGrid posts={recent} canEdit={canEdit} onEdit={(p) => setModal({ kind: "post", item: p })} onDelete={(p) => setConfirm({ kind: "post", item: p })} today={today} />
        </>)}
      </Card>
    </div>
  );
}

function PostGrid({ posts, canEdit, onEdit, onDelete, today }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {posts.map((p) => (
        <div key={p.id} className="rounded-xl p-3" style={{ background: C.cream, outline: p.date === today ? `2px solid ${C.gold}` : "none" }}>
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div className="f-body text-[10px] uppercase tracking-wide" style={{ color: p.date === today ? C.gold : C.muted }}>{p.date === today ? "Today" : dayLabel(p.date)}</div>
            {canEdit && <div className="flex gap-1 -mt-1 -mr-1">
              <button aria-label="Edit post" onClick={() => onEdit(p)} className="w-6 h-6 rounded flex items-center justify-center hover:bg-white"><Pencil size={11} style={{ color: C.muted }} /></button>
              <button aria-label="Delete post" onClick={() => onDelete(p)} className="w-6 h-6 rounded flex items-center justify-center hover:bg-white"><Trash2 size={11} style={{ color: C.muted }} /></button>
            </div>}
          </div>
          <div className="f-body text-sm font-semibold mb-1" style={{ color: C.ink }}>{p.title}</div>
          <div className="f-body text-[11px] mb-2" style={{ color: C.muted }}>{p.type} · {p.platform}</div>
          <StatusPill status={p.status} />
        </div>
      ))}
    </div>
  );
}

function CampaignForm({ item, onClose, actions }) {
  const [f, setF] = useState({ name: item?.name ?? "", platform: item?.platform ?? "Instagram", budget: String(item?.budget ?? ""), leads: String(item?.leads ?? 0), orders: String(item?.orders ?? 0), revenue: String(item?.revenue ?? 0) });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const nums = ["budget", "leads", "orders", "revenue"];
  const valid = f.name.trim().length >= 2 && f.platform.trim().length >= 2 && nums.every((k) => f[k] !== "" && Number.isInteger(Number(f[k])) && Number(f[k]) >= 0);
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { name: f.name.trim(), platform: f.platform.trim(), ...Object.fromEntries(nums.map((k) => [k, Number(f[k])])) };
      const r = item ? await actions.updateCampaign(item.id, body) : await actions.addCampaign(body);
      if (r) onClose();
    });
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : "Add Campaign"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Campaign name"><Input value={f.name} onChange={set("name")} required maxLength={80} autoFocus placeholder="e.g. Sallah Ram & Beef Bundle" /></Field>
        <Field label="Platform">
          <Input list="mk-plat" value={f.platform} onChange={set("platform")} required maxLength={60} />
          <datalist id="mk-plat">{PLATFORMS.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Budget / spend (₦)"><Input mono type="number" min="0" step="1" value={f.budget} onChange={set("budget")} required /></Field>
          <Field label="Revenue (₦)"><Input mono type="number" min="0" step="1" value={f.revenue} onChange={set("revenue")} /></Field>
          <Field label="Leads"><Input mono type="number" min="0" step="1" value={f.leads} onChange={set("leads")} /></Field>
          <Field label="Orders"><Input mono type="number" min="0" step="1" value={f.orders} onChange={set("orders")} /></Field>
        </div>
        <p className="f-body text-xs" style={{ color: C.muted }}>Update leads, orders and revenue as results come in from each platform.</p>
        <Btn type="submit" icon={Check} full busy={busy} disabled={!valid}>{item ? "Save Changes" : "Add Campaign"}</Btn>
      </form>
    </Modal>
  );
}

function PostForm({ item, onClose, actions }) {
  const [f, setF] = useState({ date: item?.date ?? todayIso(), title: item?.title ?? "", type: item?.type ?? POST_TYPES[0], platform: item?.platform ?? "Instagram", status: item?.status ?? "Draft" });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const valid = f.date && f.title.trim().length >= 2 && f.type.trim().length >= 2 && f.platform.trim().length >= 2;
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { ...f, title: f.title.trim(), type: f.type.trim(), platform: f.platform.trim() };
      const r = item ? await actions.updatePost(item.id, body) : await actions.addPost(body);
      if (r) onClose();
    });
  };
  return (
    <Modal title={item ? "Edit Post" : "Add Post"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title"><Input value={f.title} onChange={set("title")} required maxLength={120} autoFocus placeholder="e.g. Weekend family meat box" /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Date"><Input type="date" value={f.date} onChange={set("date")} required /></Field>
          <Field label="Status"><Select value={f.status} onChange={set("status")}>{CONTENT_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Type">
            <Input list="post-types" value={f.type} onChange={set("type")} required maxLength={40} />
            <datalist id="post-types">{POST_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="Platform">
            <Input list="post-plat" value={f.platform} onChange={set("platform")} required maxLength={40} />
            <datalist id="post-plat">{PLATFORMS.map((p) => <option key={p} value={p} />)}</datalist>
          </Field>
        </div>
        <Btn type="submit" icon={Check} full busy={busy} disabled={!valid}>{item ? "Save Changes" : "Add Post"}</Btn>
      </form>
    </Modal>
  );
}

/* ============================================================ CUSTOMER EMAILS + BIRTHDAYS */
function EmailMarketing({ em, canEdit, actions }) {
  const [compose, setCompose] = useState(false);
  const [settings, setSettings] = useState(false);
  const [list, setList] = useState(null);
  const copyList = async (key) => {
    try {
      const rows = await api(`/marketing/audience/${key}`);
      if (!rows.length) { actions.notify("Nobody in that group has an email and has agreed to marketing.", "error"); return; }
      const text = rows.map((r) => r.email).join(", ");
      try { await navigator.clipboard.writeText(text); actions.notify(`${rows.length} email${rows.length === 1 ? "" : "s"} copied — paste into the BCC box`); }
      catch { setList(text); }
    } catch (e) { actions.notify(e.message, "error"); }
  };
  const t = em.birthdaysToday;
  return (
    <div className="grid lg:grid-cols-5 gap-4 mb-6">
      {compose && <ComposeEmail em={em} actions={actions} onClose={() => setCompose(false)} onCopy={copyList} />}
      {settings && <BirthdaySettings em={em} actions={actions} onClose={() => setSettings(false)} />}
      {list && (
        <Modal title="Email list" onClose={() => setList(null)}>
          <p className="f-body text-xs mb-2" style={{ color: C.muted }}>Copy these into the BCC box of your email.</p>
          <textarea readOnly value={list} className="w-full h-40 f-mono text-xs rounded-lg border p-2" style={{ borderColor: C.input }} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
      <Card className="lg:col-span-2">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2"><Cake size={18} style={{ color: C.burgundy }} /><h3 className="f-display text-base" style={{ color: C.ink }}>Birthdays</h3></div>
          {canEdit && <Btn small variant="ghost" icon={Settings2} onClick={() => setSettings(true)}>Greeting</Btn>}
        </div>
        <div className="f-body text-xs mb-3" style={{ color: em.settings.birthdayAuto && em.configured ? C.ok : C.muted }} data-birthday-mode>
          {em.settings.birthdayAuto && em.configured ? "Automatic: each birthday customer gets the greeting by email at 8:00." : em.settings.birthdayAuto ? "Automatic greetings are on, but email sending isn't set up yet." : "Automatic greetings are off."}
        </div>
        <div className="f-body text-[11px] uppercase tracking-wide mb-1.5" style={{ color: C.muted }}>Today</div>
        {t.length === 0 ? <p className="f-body text-sm mb-3" style={{ color: C.muted }}>No birthdays today.</p> : (
          <ul className="space-y-1.5 mb-3">
            {t.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 f-body text-sm" data-birthday-today>
                <span className="truncate" style={{ color: C.ink }}>🎂 {c.name}</span>
                <span className="text-[11px] shrink-0" style={{ color: c.greeted ? C.ok : C.muted }}>{c.greeted ? "Greeted ✓" : c.canEmail ? "Email ready" : c.phone ? `Call / WhatsApp ${c.phone}` : "No email or consent"}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="f-body text-[11px] uppercase tracking-wide mb-1.5" style={{ color: C.muted }}>Rest of {em.monthName}</div>
        <p className="f-body text-xs" style={{ color: C.ink }}>{em.birthdaysMonth.length ? em.birthdaysMonth.map((c) => `${c.name} (${c.day})`).join(" · ") : "None recorded yet — add birthdays on customer profiles."}</p>
      </Card>

      <Card className="lg:col-span-3">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2"><Mail size={18} style={{ color: C.burgundy }} /><h3 className="f-display text-base" style={{ color: C.ink }}>Customer emails</h3></div>
          {canEdit && <Btn small icon={Send} onClick={() => setCompose(true)}>New email</Btn>}
        </div>
        {!em.configured && (
          <p className="f-body text-xs mb-3 rounded-lg px-3 py-2" style={{ background: "#F6EEDD", color: C.ink }} data-email-setup>
            Sending isn't set up yet. Add <span className="f-mono">RESEND_API_KEY</span> and <span className="f-mono">EMAIL_FROM</span> to the app's settings on your host (e.g. fly secrets set) to send from here.
            Meanwhile, <b>Copy emails</b> gives you the list for any email app.
          </p>
        )}
        {em.configured && <p className="f-body text-xs mb-3" style={{ color: C.muted }}>Sending as <span className="f-mono">{em.from}</span>. Only customers who agreed get emails; each one has an unsubscribe link.</p>}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
          {em.audiences.map((a) => (
            <div key={a.key} className="rounded-lg px-3 py-2" style={{ background: C.cream }}>
              <div className="f-mono text-lg font-semibold" style={{ color: C.ink }}>{a.count}</div>
              <div className="f-body text-[11px] leading-tight" style={{ color: C.muted }}>{a.label}</div>
              {canEdit && a.count > 0 && <button onClick={() => copyList(a.key)} className="f-body text-[11px] mt-1 inline-flex items-center gap-1 hover:underline" style={{ color: C.burgundy }}><Copy size={11} /> Copy emails</button>}
            </div>
          ))}
        </div>
        <div className="f-body text-[11px] uppercase tracking-wide mb-1.5" style={{ color: C.muted }}>Recently sent</div>
        {em.history.length === 0 ? <p className="f-body text-sm" style={{ color: C.muted }}>Nothing sent yet.</p> : (
          <ul className="space-y-1.5">
            {em.history.slice(0, 5).map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-2 f-body text-xs">
                <span className="min-w-0 truncate" style={{ color: C.ink }}>{h.at} · {h.kind === "birthday" ? "🎂 " : ""}{h.subject} <span style={{ color: C.muted }}>· {h.audience} · {h.who}</span></span>
                <span className="shrink-0" style={{ color: h.failed ? C.danger : C.ok }}>{h.sent} sent{h.failed ? `, ${h.failed} failed` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ComposeEmail({ em, actions, onClose, onCopy }) {
  const [f, setF] = useState({ audience: "all", subject: "", body: "Hello {name},\n\n" });
  const [busy, run] = useBusy();
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const aud = em.audiences.find((a) => a.key === f.audience);
  const valid = f.subject.trim().length >= 3 && f.body.trim().length >= 10;
  const send = (test) => run(async () => {
    setErr(null);
    try {
      const r = await api("/marketing/email", { method: "POST", body: { ...f, test } });
      actions.notify(test ? "Test sent to your own email" : `Email sent to ${r.sent} customer${r.sent === 1 ? "" : "s"}${r.failed ? ` (${r.failed} failed)` : ""}`);
      await actions.refresh();
      if (!test) onClose();
    } catch (e) { setErr(e.message); }
  });
  return (
    <Modal title="Email customers" onClose={onClose} wide>
      <div className="space-y-4">
        <Field label="Send to">
          <Select value={f.audience} onChange={set("audience")}>{em.audiences.map((a) => <option key={a.key} value={a.key}>{a.label} ({a.count})</option>)}</Select>
        </Field>
        <Field label="Subject"><Input value={f.subject} onChange={set("subject")} maxLength={150} placeholder="Fresh goat meat in this weekend" /></Field>
        <Field label="Message" hint="{name} becomes each customer's first name. Leave a blank line between paragraphs.">
          <textarea value={f.body} onChange={set("body")} rows={8} maxLength={5000} className="w-full rounded-lg border px-3.5 py-2.5 f-body text-sm outline-none focus:ring-2"
            style={{ borderColor: C.input, "--tw-ring-color": C.goldLight }} />
        </Field>
        <p className="f-body text-xs" style={{ color: C.muted }}>Your business name, address and an unsubscribe link are added at the bottom automatically.</p>
        {err && <p className="f-body text-xs" style={{ color: C.danger }}>{err}</p>}
        {em.configured ? (
          <div className="flex flex-wrap gap-2">
            <Btn variant="ghost" icon={Mail} busy={busy} disabled={!valid} onClick={() => send(true)}>Send me a test</Btn>
            <Btn icon={Send} busy={busy} disabled={!valid || !aud?.count} onClick={() => send(false)}>Send to {aud?.count || 0} customer{aud?.count === 1 ? "" : "s"}</Btn>
          </div>
        ) : (
          <Btn icon={Copy} disabled={!aud?.count} onClick={() => onCopy(f.audience)}>Copy {aud?.count || 0} email{aud?.count === 1 ? "" : "s"} for your email app</Btn>
        )}
      </div>
    </Modal>
  );
}

function BirthdaySettings({ em, actions, onClose }) {
  const [f, setF] = useState({ ...em.settings });
  const [busy, run] = useBusy();
  const save = () => run(async () => {
    try { await api("/settings/email", { method: "PATCH", body: f }); actions.notify("Birthday greeting saved"); await actions.refresh(); onClose(); }
    catch (e) { actions.notify(e.message, "error"); }
  });
  return (
    <Modal title="Birthday greeting" onClose={onClose}>
      <div className="space-y-4">
        <label className="flex items-start gap-2.5 f-body text-sm cursor-pointer" style={{ color: C.ink }}>
          <input type="checkbox" checked={f.birthdayAuto} onChange={(e) => setF((p) => ({ ...p, birthdayAuto: e.target.checked }))} className="mt-0.5 w-4 h-4" style={{ accentColor: C.burgundy }} aria-label="Send birthday greetings automatically" />
          <span>Send automatically at 8:00 on each customer's birthday<span className="block text-xs" style={{ color: C.muted }}>Only to customers with an email who agreed to marketing. Once a year each.</span></span>
        </label>
        <Field label="Subject"><Input value={f.birthdaySubject} onChange={(e) => setF((p) => ({ ...p, birthdaySubject: e.target.value }))} maxLength={150} /></Field>
        <Field label="Message" hint="{name} = first name, {business} = your business name">
          <textarea value={f.birthdayBody} onChange={(e) => setF((p) => ({ ...p, birthdayBody: e.target.value }))} rows={6} maxLength={3000}
            className="w-full rounded-lg border px-3.5 py-2.5 f-body text-sm outline-none focus:ring-2" style={{ borderColor: C.input, "--tw-ring-color": C.goldLight }} />
        </Field>
        {!em.configured && <p className="f-body text-xs" style={{ color: C.muted }}>Greetings start once email sending is set up (RESEND_API_KEY and EMAIL_FROM in the app's settings).</p>}
        <Btn full icon={Check} busy={busy} disabled={f.birthdaySubject.trim().length < 3 || f.birthdayBody.trim().length < 10} onClick={save}>Save</Btn>
      </div>
    </Modal>
  );
}
