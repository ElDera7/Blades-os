// Customer emails: marketing messages and automatic birthday greetings.
//   • Sent through Resend (https://resend.com) when RESEND_API_KEY and EMAIL_FROM are set; otherwise BladeOS shows the
//     list so it can be copied into any email tool.
//   • Only to customers who agreed to marketing and haven't unsubscribed. Every email carries a one-click unsubscribe
//     link (and List-Unsubscribe headers) — required by the Nigeria Data Protection Act 2023 and by Gmail/Yahoo.
import express from "express";
import { z } from "zod";
import { query, pool } from "./db.js";
import { requirePerm, sign } from "./auth.js";
import { ah, parse, audit, bad, conflict, HttpError, fmtDateTime } from "./util.js";
import { businessProfile } from "./pos.js";
import { can } from "../src/shared/permissions.js";

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DEFAULT_SETTINGS = {
  birthdayAuto: false,
  birthdaySubject: "Happy birthday, {name}! 🎂",
  birthdayBody: "Happy birthday, {name}!\n\nEveryone at {business} wishes you a wonderful day. Thank you for being part of our family — we look forward to serving you again soon.",
};

/** This app's public address: PUBLIC_URL (set it for a custom domain), else what the host provides. */
export function hostedUrl(env = process.env) {
  const u = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL
    || (env.RAILWAY_PUBLIC_DOMAIN && `https://${env.RAILWAY_PUBLIC_DOMAIN}`)
    || (env.FLY_APP_NAME && `https://${env.FLY_APP_NAME}.fly.dev`) || "";
  return u.replace(/\/+$/, "");
}

export function emailConfig() {
  const e = process.env;
  const base = hostedUrl();
  return { key: e.RESEND_API_KEY || null, from: e.EMAIL_FROM || null, api: (e.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, ""), base,
    ready: !!(e.RESEND_API_KEY && e.EMAIL_FROM) };
}
export async function emailSettings() {
  const r = (await query("SELECT value FROM settings WHERE key = 'email_settings'")).rows[0];
  return { ...DEFAULT_SETTINGS, ...(r?.value || {}) };
}

const lagosToday = () => { const d = new Date(Date.now() + 3600e3); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() }; };
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** Birthdays today — 29 February birthdays are celebrated on 28 February in other years. */
function birthdayWhere(alias = "c") {
  const t = lagosToday();
  const feb29 = t.m === 2 && t.d === 28 && !isLeap(t.y) ? ` OR (${alias}.birthday_month = 2 AND ${alias}.birthday_day = 29)` : "";
  return `((${alias}.birthday_month = ${t.m} AND ${alias}.birthday_day = ${t.d})${feb29})`;
}
const CONSENTED = (a = "c") => `${a}.erased_at IS NULL AND ${a}.marketing_ok AND ${a}.unsubscribed_at IS NULL AND ${a}.email IS NOT NULL`;
const AUDIENCES = {
  all: { label: "Everyone who agreed to marketing", where: () => "TRUE" },
  "birthdays-today": { label: "Birthdays today", where: () => birthdayWhere() },
  "birthdays-month": { label: "Birthdays this month", where: () => `c.birthday_month = ${lagosToday().m}` },
  "recent-30": { label: "Bought in the last 30 days", where: () => "EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status <> 'Cancelled' AND o.created_at > now() - interval '30 days')" },
  "lapsed-60": { label: "Haven't bought in 60 days", where: () => "NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status <> 'Cancelled' AND o.created_at > now() - interval '60 days')" },
};
const audienceRows = (key) => query(`SELECT c.id, c.name, c.email FROM customers c WHERE ${CONSENTED()} AND ${AUDIENCES[key].where()} ORDER BY c.name`).then((r) => r.rows);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
const fill = (t, vars) => String(t).replace(/\{(name|business)\}/g, (_, k) => vars[k] ?? "");
export const unsubscribeUrl = (base, id) => `${base}/api/public/unsubscribe?c=${id}&t=${sign(`unsub:${id}`)}`;

/** A plain, branded email that renders in every client (inline styles, no images to block). */
export function renderEmail(profile, { subject, body, name, unsub }) {
  const vars = { name: firstName(name), business: profile.name };
  const text = fill(body, vars);
  const paras = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const contact = [profile.address, profile.phone, profile.email].filter(Boolean).map(esc).join(" · ");
  const html = `<!doctype html><html><body style="margin:0;background:#F7F3EC;font-family:Helvetica,Arial,sans-serif;color:#221C17">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#7A2331;color:#fff;padding:18px 24px;font-size:18px;font-weight:bold;letter-spacing:.5px">${esc(profile.name)}</td></tr>
<tr><td style="padding:24px 24px 10px;font-size:15px">${paras}</td></tr>
<tr><td style="padding:14px 24px 22px;font-size:12px;color:#6B6358;border-top:1px solid #EEE7D9">${contact ? contact + "<br>" : ""}
You're receiving this because you agreed to hear from ${esc(profile.name)}. <a href="${esc(unsub)}" style="color:#7A2331">Unsubscribe</a>.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: fill(subject, vars), html, text: `${text}\n\n—\n${profile.name}\nUnsubscribe: ${unsub}` };
}

/** Send through Resend's batch API, up to 100 per call. Returns how many went and the first errors. */
export async function sendEmails(cfg, messages) {
  let sent = 0, failed = 0; const errors = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const r = await fetch(`${cfg.api}/emails/batch`, {
        method: "POST", headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((m) => ({ from: cfg.from, to: [m.to], subject: m.subject, html: m.html, text: m.text,
          headers: { "List-Unsubscribe": `<${m.unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }))),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) sent += chunk.length;
      else { failed += chunk.length; errors.push(`${r.status} ${(await r.text()).slice(0, 200)}`); }
    } catch (e) { failed += chunk.length; errors.push(e.message); }
  }
  return { sent, failed, errors };
}

async function sendTo(rows, { subject, body }, base) {
  const cfg = emailConfig();
  const profile = await businessProfile();
  const msgs = rows.map((c) => { const unsub = unsubscribeUrl(base, c.id); return { to: c.email, unsub, ...renderEmail(profile, { subject, body, name: c.name, unsub }) }; });
  return sendEmails(cfg, msgs);
}

const baseOf = (req) => emailConfig().base || `${req.protocol}://${req.get("host")}`;

/* ================================================================== routes */
export function emailRoutes(r) {
  r.post("/marketing/email", requirePerm("marketing.edit"), ah(async (req, res) => {
    const b = parse(z.object({
      subject: z.string().trim().min(3).max(150), body: z.string().trim().min(10).max(5000),
      audience: z.enum(Object.keys(AUDIENCES)), test: z.boolean().optional(),
    }), req.body);
    const cfg = emailConfig();
    if (!cfg.ready) throw conflict("Email sending isn't set up yet — add RESEND_API_KEY and EMAIL_FROM to the app's settings on your host. Meanwhile use Copy emails.");
    const rows = b.test ? [{ id: 0, name: req.user.name, email: req.user.email }] : await audienceRows(b.audience);
    if (!rows.length) throw bad("Nobody in that group has an email and has agreed to marketing.");
    const out = await sendTo(rows, b, baseOf(req));
    await query("INSERT INTO email_sends (kind, subject, audience, recipients, sent, failed, error, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [b.test ? "test" : "campaign", b.subject, b.test ? `test to ${req.user.email}` : AUDIENCES[b.audience].label, rows.length, out.sent, out.failed, out.errors[0] || null, req.user.id]);
    await audit(null, req.user.id, b.test ? "Sent a test marketing email" : "Sent a marketing email", `"${b.subject}" · ${out.sent} sent${out.failed ? `, ${out.failed} failed` : ""}`);
    if (!out.sent) throw new HttpError(502, `Nothing was sent: ${out.errors[0] || "the email service refused it"}`);
    res.json({ recipients: rows.length, ...out });
  }));

  /** The email list for a group — to paste into another email tool when sending isn't set up. */
  r.get("/marketing/audience/:key", requirePerm("marketing.edit"), ah(async (req, res) => {
    if (!AUDIENCES[req.params.key]) throw bad("Unknown group.");
    const rows = await audienceRows(req.params.key);
    await audit(null, req.user.id, "Exported a marketing email list", `${AUDIENCES[req.params.key].label} · ${rows.length}`);
    res.json(rows.map((c) => ({ name: c.name, email: c.email })));
  }));

  r.patch("/settings/email", requirePerm("marketing.edit"), ah(async (req, res) => {
    const b = parse(z.object({ birthdayAuto: z.boolean().optional(), birthdaySubject: z.string().trim().min(3).max(150).optional(),
      birthdayBody: z.string().trim().min(10).max(3000).optional() }), req.body);
    const next = { ...(await emailSettings()), ...b };
    await query("INSERT INTO settings (key, value) VALUES ('email_settings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(next)]);
    await audit(null, req.user.id, "Updated birthday email settings", `automatic ${next.birthdayAuto ? "on" : "off"}`);
    res.json(next);
  }));

  // Unsubscribe: the link shows a confirm button (mail scanners that open links can't unsubscribe anyone);
  // the button — or a mail app's one-click unsubscribe — POSTs here.
  const page = (title, msg, form = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#F7F3EC;font-family:Helvetica,Arial,sans-serif;color:#221C17"><div style="max-width:420px;margin:12vh auto;background:#fff;border-radius:12px;padding:28px;text-align:center">
<h1 style="font-size:20px;margin:0 0 10px">${title}</h1><p style="color:#6B6358;line-height:1.5">${msg}</p>${form}</div></body></html>`;
  const verify = async (c, t) => {
    const id = Number(c);
    if (!Number.isInteger(id) || id <= 0 || t !== sign(`unsub:${id}`)) return null;
    return (await query("SELECT id, code, name, unsubscribed_at FROM customers WHERE id = $1", [id])).rows[0] || null;
  };
  r.get("/public/unsubscribe", ah(async (req, res) => {
    const c = await verify(req.query.c, req.query.t);
    if (!c) return res.status(400).type("html").send(page("Link not valid", "This unsubscribe link is incomplete or has been changed."));
    const { name } = await businessProfile();
    if (c.unsubscribed_at) return res.type("html").send(page("You're unsubscribed", `You won't get marketing emails from ${esc(name)}.`));
    res.type("html").send(page(`Stop emails from ${esc(name)}?`, "You won't get offers, news or birthday emails any more. Receipts aren't affected.",
      `<form method="post"><input type="hidden" name="c" value="${esc(req.query.c)}"><input type="hidden" name="t" value="${esc(req.query.t)}">
<button style="background:#7A2331;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;cursor:pointer">Unsubscribe</button></form>`));
  }));
  r.post("/public/unsubscribe", express.urlencoded({ extended: false, limit: "2kb" }), ah(async (req, res) => {
    const c = await verify(req.body?.c ?? req.query.c, req.body?.t ?? req.query.t);
    if (!c) return res.status(400).type("html").send(page("Link not valid", "This unsubscribe link is incomplete or has been changed."));
    if (!c.unsubscribed_at) {
      await query("UPDATE customers SET marketing_ok = FALSE, unsubscribed_at = now() WHERE id = $1", [c.id]);
      await audit(null, null, `Customer unsubscribed from marketing emails`, c.code);
    }
    const { name } = await businessProfile();
    res.type("html").send(page("You're unsubscribed", `You won't get marketing emails from ${esc(name)} any more.`));
  }));
}

/* ================================================================== state + notifications */
export async function emailMarketingState() {
  const cfg = emailConfig();
  const [settings, today, month, counts, history] = await Promise.all([
    emailSettings(),
    query(`SELECT c.id, c.name, c.email, c.phone, (${CONSENTED()}) AS can_email,
             EXISTS (SELECT 1 FROM birthday_greetings g WHERE g.customer_id = c.id AND g.year = ${lagosToday().y}) AS greeted
           FROM customers c WHERE c.erased_at IS NULL AND ${birthdayWhere()} ORDER BY c.name`),
    query(`SELECT c.id, c.name, c.birthday_day AS day FROM customers c WHERE c.erased_at IS NULL AND c.birthday_month = ${lagosToday().m} ORDER BY c.birthday_day, c.name`),
    Promise.all(Object.keys(AUDIENCES).map((k) => query(`SELECT count(*)::int AS n FROM customers c WHERE ${CONSENTED()} AND ${AUDIENCES[k].where()}`).then((r) => [k, r.rows[0].n]))),
    query(`SELECT e.*, u.name AS who FROM email_sends e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT 10`),
  ]);
  return {
    configured: cfg.ready, from: cfg.from, settings,
    audiences: Object.entries(AUDIENCES).map(([key, a]) => ({ key, label: a.label, count: Object.fromEntries(counts)[key] })),
    birthdaysToday: today.rows.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, canEmail: c.can_email, greeted: c.greeted })),
    birthdaysMonth: month.rows.map((c) => ({ id: c.id, name: c.name, day: c.day })),
    monthName: MONTHS[lagosToday().m - 1],
    history: history.rows.map((h) => ({ id: h.id, kind: h.kind, subject: h.subject, audience: h.audience, recipients: h.recipients, sent: h.sent, failed: h.failed, error: h.error, who: h.who ?? "Automatic", at: fmtDateTime(h.created_at) })),
  };
}

export async function emailNotifications(user) {
  if (!can(user.roles, "marketing.view")) return [];
  const n = (await query(`SELECT count(*)::int AS n FROM customers c WHERE c.erased_at IS NULL AND ${birthdayWhere()}`)).rows[0].n;
  if (!n) return [];
  const s = await emailSettings(), cfg = emailConfig();
  const how = cfg.ready && s.birthdayAuto ? " — greetings go out by email automatically" : " — send them a greeting";
  return [{ icon: "Calendar", tone: "gold", route: "marketing", text: `${n} customer birthday${n === 1 ? "" : "s"} today${how}.` }];
}

/* ================================================================== daily birthday job */
const LOCK = 74102932;
export async function birthdayTick() {
  const cfg = emailConfig();
  if (!cfg.ready || !cfg.base) return;
  const s = await emailSettings();
  const t = lagosToday();
  if (!s.birthdayAuto || t.h < (process.env.BIRTHDAY_HOUR !== undefined ? Number(process.env.BIRTHDAY_HOUR) : 8)) return;   // from 08:00 Lagos time
  const client = await pool.connect();
  try {
    if (!(await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK])).rows[0].ok) return;
    try {
      // Claim first (one greeting per customer per year), then send.
      const due = (await client.query(
        `INSERT INTO birthday_greetings (customer_id, year) SELECT c.id, ${t.y} FROM customers c
         WHERE ${CONSENTED()} AND ${birthdayWhere()} ON CONFLICT DO NOTHING RETURNING customer_id`)).rows.map((r) => r.customer_id);
      if (!due.length) return;
      const rows = (await client.query("SELECT id, name, email FROM customers WHERE id = ANY($1)", [due])).rows;
      const out = await sendTo(rows, { subject: s.birthdaySubject, body: s.birthdayBody }, cfg.base);
      if (out.failed) await client.query("DELETE FROM birthday_greetings WHERE year = $1 AND customer_id = ANY($2)", [t.y, out.sent ? [] : due]); // nothing went: try again later
      await client.query("INSERT INTO email_sends (kind, subject, audience, recipients, sent, failed, error) VALUES ('birthday', $1, 'Birthdays today', $2, $3, $4, $5)",
        [s.birthdaySubject, rows.length, out.sent, out.failed, out.errors[0] || null]);
    } finally { await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {}); }
  } finally { client.release(); }
}
