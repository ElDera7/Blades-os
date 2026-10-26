import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { query } from "./db.js";
import { can, PASSWORD_MIN, MFA_REQUIRED_ROLES, weakPassword } from "../src/shared/permissions.js";
import { ah, audit, parse, HttpError } from "./util.js";
import { newSecret, verifyTotp, otpauthUri, encryptSecret, decryptSecret, newRecoveryCodes } from "./totp.js";

const COOKIE = "bladeos_session";
const SESSION_HOURS = 12;
const isProd = process.env.NODE_ENV === "production";

let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  if (isProd) {
    console.error("JWT_SECRET must be set to a random string of at least 32 characters.");
    process.exit(1);
  }
  SECRET = "dev-only-secret-do-not-use-in-production-0123456789";
}

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
/** A short keyed fingerprint (unsubscribe links): can't be forged without the server secret. */
export const sign = (text) => crypto.createHmac("sha256", SECRET).update(String(text)).digest("base64url").slice(0, 24);
/** Short-lived signed tokens for one purpose (e.g. a manager's override at the till). Never accepted as a session. */
export const signPurpose = (claims, ttl) => jwt.sign(claims, SECRET, { expiresIn: ttl });
export function verifyPurpose(token, purpose) {
  const c = jwt.verify(token, SECRET);
  if (c.purpose !== purpose) throw new Error("wrong token");
  return c;
}

/** Every role an account holds: the primary role first, then any additional ones. */
export const rolesOf = (u) => [u.role, ...(u.extra_roles || []).filter((r) => r !== u.role)];
// Two-step sign-in is optional for everyone (each person can turn it on from the account menu).
// REQUIRE_TWO_STEP=true makes it mandatory again for the leadership roles (Super Admin, Owner, MD, Administrator).
const requireTwoStep = () => /^(1|true|yes|on)$/i.test(process.env.REQUIRE_TWO_STEP || "");
const mfaRequired = (u) => requireTwoStep() && rolesOf(u).some((r) => MFA_REQUIRED_ROLES.includes(r));

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, roles: rolesOf(u), extraRoles: u.extra_roles || [],
  active: u.active, mustChangePassword: !!u.must_change_password,
  mfaEnabled: !!u.totp_enabled, mfaRequired: mfaRequired(u), mfaSetupRequired: mfaRequired(u) && !u.totp_enabled, posPinSet: !!u.pos_pin_hash,
});

export const passwordRule = z.string().min(PASSWORD_MIN, `must be at least ${PASSWORD_MIN} characters`).max(200);
/** Refuse passwords that are common, a simple run, the business name or the person's email. */
export function checkPassword(pw, email) {
  const why = pw && weakPassword(pw, email);
  if (why) throw new HttpError(400, `That password ${why}. Choose something harder to guess — a short phrase works well.`);
}

/* ---- in-memory throttles: passwords 10 failures / 15 min per IP+email; codes 6 / 15 min per account ---- */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function throttled(key, max = 10) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) return false;
  return a.count >= max;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}
setInterval(() => {
  for (const [k, a] of attempts) if (Date.now() - a.first > WINDOW) attempts.delete(k);
}, WINDOW).unref();

/** Start a session: a row in user_sessions (so it can be ended server-side) and a signed cookie that names it. */
async function setSession(req, res, user, { mfa = false } = {}) {
  const sid = crypto.randomUUID();
  await query(
    "INSERT INTO user_sessions (id, user_id, mfa, expires_at, ip, user_agent) VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)",
    [sid, user.id, mfa, SESSION_HOURS, req.ip || null, String(req.get("user-agent") || "").slice(0, 200) || null]);
  if (req.sessionId) await query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [req.sessionId]);
  req.sessionId = sid;
  const token = jwt.sign({ sub: user.id, sid }, SECRET, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: SESSION_HOURS * 3600 * 1000, path: "/" });
}

/** End every session a user has (password reset, deactivation, role change…), optionally keeping one. */
export async function endSessions(db, userId, keep = null) {
  const { rowCount } = await (db?.query ? db : { query }).query(
    "UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)", [userId, keep]);
  return rowCount;
}

/** Loads req.user from the session cookie (valid token, active account, and — if enrolled — a completed second step). */
export const loadUser = ah(async (req, _res, next) => {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const claims = jwt.verify(token, SECRET);
      if (claims.purpose || !claims.sid) throw new Error("not a session token");
      const { rows } = await query(
        `SELECT u.*, s.mfa AS session_mfa, s.last_seen AS session_seen FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`, [claims.sid, claims.sub]);
      const u = rows[0];
      if (u && (!u.totp_enabled || u.session_mfa)) {
        req.user = u; req.user.roles = rolesOf(u); req.sessionId = claims.sid;
        if (Date.now() - new Date(u.session_seen).getTime() > 60e3) query("UPDATE user_sessions SET last_seen = now() WHERE id = $1", [claims.sid]).catch(() => {});
      }
    } catch {
      /* invalid/expired token → treated as logged out */
    }
  }
  next();
});

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, "Please sign in."));
  next();
}

/**
 * Account setup gates, in order: replace a temporary password, then (leadership roles) turn on
 * two-step sign-in. Until both are done only the account endpoints work.
 */
const OPEN_WHILE_SETUP = new Set(["/auth/me", "/auth/password", "/auth/logout", "/auth/login", "/auth/mfa", "/auth/mfa/setup", "/auth/mfa/enable"]);
export function requirePasswordChange(req, _res, next) {
  if (req.user && !OPEN_WHILE_SETUP.has(req.path)) {
    if (req.user.must_change_password) return next(new HttpError(403, "Choose a new password to continue."));
    if (mfaRequired(req.user) && !req.user.totp_enabled) return next(new HttpError(403, "Set up two-step sign-in to continue."));
  }
  next();
}

export const requirePerm = (perm) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "Please sign in."));
  if (!can(req.user.roles, perm)) return next(new HttpError(403, "Your role doesn't have access to this action."));
  next();
};

/** Check a 6-digit code (no replays) or a single-use recovery code. Returns true and records use. */
async function checkSecondFactor(user, { code, recoveryCode }) {
  if (recoveryCode) {
    const clean = recoveryCode.trim().toUpperCase();
    for (const [i, h] of (user.recovery_codes || []).entries()) {
      if (await bcrypt.compare(clean, h)) {
        const left = user.recovery_codes.filter((_, j) => j !== i);
        await query("UPDATE users SET recovery_codes = $2 WHERE id = $1", [user.id, left]);
        await audit(null, user.id, "Signed in with a recovery code", `${left.length} left`);
        return true;
      }
    }
    return false;
  }
  if (!user.totp_secret) return false;
  const step = verifyTotp(decryptSecret(user.totp_secret, SECRET), code);
  if (step == null || (user.totp_last_step != null && step <= user.totp_last_step)) return false;
  await query("UPDATE users SET totp_last_step = $2 WHERE id = $1", [user.id, step]);
  return true;
}

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });
const codeSchema = z.object({ code: z.string().trim().max(10).optional(), recoveryCode: z.string().trim().max(20).optional() });

export function authRoutes(router) {
  router.post("/auth/login", ah(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const key = `${req.ip}|${email.toLowerCase()}`;
    if (throttled(key)) throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
    const { rows } = await query("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok || !user.active) {
      recordFailure(key);
      throw new HttpError(401, user && ok && !user.active ? "This account has been deactivated." : "Email or password is incorrect.");
    }
    attempts.delete(key);
    if (user.totp_enabled) {
      // Password is right; the session only starts after the authenticator code.
      const ticket = jwt.sign({ sub: user.id, purpose: "mfa" }, SECRET, { expiresIn: "5m" });
      return res.json({ mfaRequired: true, ticket });
    }
    await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await audit(null, user.id, "Signed in", null);
    await setSession(req, res, user);
    res.json({ user: publicUser(user) });
  }));

  router.post("/auth/mfa", ah(async (req, res) => {
    const b = parse(codeSchema.extend({ ticket: z.string().min(10) }), req.body);
    let claims;
    try { claims = jwt.verify(b.ticket, SECRET); } catch { throw new HttpError(401, "That sign-in took too long. Enter your password again."); }
    if (claims.purpose !== "mfa") throw new HttpError(401, "Enter your password again.");
    const key = `mfa|${claims.sub}`;
    if (throttled(key, 6)) throw new HttpError(429, "Too many wrong codes. Try again in 15 minutes.");
    const user = (await query("SELECT * FROM users WHERE id = $1 AND active", [claims.sub])).rows[0];
    if (!user || !user.totp_enabled) throw new HttpError(401, "Enter your password again.");
    if (!(await checkSecondFactor(user, b))) {
      recordFailure(key);
      throw new HttpError(401, b.recoveryCode ? "That recovery code isn't valid or was already used." : "That code isn't right. Check your authenticator app's clock and try again.");
    }
    attempts.delete(key);
    await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await audit(null, user.id, "Signed in", "with two-step verification");
    await setSession(req, res, user, { mfa: true });
    res.json({ user: publicUser(user) });
  }));

  /** Step 1 of enrolment: the secret to scan (stable until enrolment completes). */
  router.post("/auth/mfa/setup", requireAuth, ah(async (req, res) => {
    if (req.user.totp_enabled) throw new HttpError(409, "Two-step sign-in is already on.");
    if (req.user.must_change_password) throw new HttpError(403, "Choose a new password first.");
    // Reuse an unfinished secret so a reloaded or double-opened setup screen never shows a stale QR code.
    let secret = null;
    if (req.user.totp_secret) { try { secret = decryptSecret(req.user.totp_secret, SECRET); } catch { secret = null; } }
    if (!secret) {
      secret = newSecret();
      await query("UPDATE users SET totp_secret = $2 WHERE id = $1", [req.user.id, encryptSecret(secret, SECRET)]);
    }
    res.json({ secret, uri: otpauthUri(secret, req.user.email) });
  }));

  /** Step 2: prove the app works; returns recovery codes once. */
  router.post("/auth/mfa/enable", requireAuth, ah(async (req, res) => {
    const b = parse(z.object({ code: z.string().trim().max(10) }), req.body);
    const u = (await query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
    if (u.totp_enabled) throw new HttpError(409, "Two-step sign-in is already on.");
    if (!u.totp_secret) throw new HttpError(400, "Start the setup first.");
    const step = verifyTotp(decryptSecret(u.totp_secret, SECRET), b.code);
    if (step == null) throw new HttpError(400, "That code isn't right. Check the app and try again.");
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
    await query("UPDATE users SET totp_enabled = TRUE, totp_last_step = $2, recovery_codes = $3 WHERE id = $1", [u.id, step, hashes]);
    await audit(null, u.id, "Turned on two-step sign-in", null);
    await endSessions(null, u.id, req.sessionId);
    await setSession(req, res, u, { mfa: true });
    res.json({ recoveryCodes: codes });
  }));

  /** Switch it off (needs a current code or a recovery code). Not allowed while REQUIRE_TWO_STEP makes it mandatory. */
  router.post("/auth/mfa/disable", requireAuth, ah(async (req, res) => {
    const b = parse(codeSchema, req.body);
    if (mfaRequired(req.user)) throw new HttpError(403, "Two-step sign-in is required for your role.");
    if (!req.user.totp_enabled) return res.json({ ok: true });
    if (!(await checkSecondFactor(req.user, b))) throw new HttpError(400, "That code isn't right.");
    await query("UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = NULL, recovery_codes = '{}' WHERE id = $1", [req.user.id]);
    await audit(null, req.user.id, "Turned off two-step sign-in", null);
    await setSession(req, res, req.user);
    res.json({ ok: true });
  }));

  router.post("/auth/logout", ah(async (req, res) => {
    if (req.sessionId) await query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [req.sessionId]);
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  }));

  /** Where this account is signed in, and a way to end every other session (a lost phone, a shared PC). */
  router.get("/auth/sessions", requireAuth, ah(async (req, res) => {
    const { rows } = await query(
      `SELECT id, created_at, last_seen, ip, user_agent FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen DESC`, [req.user.id]);
    res.json(rows.map((s) => ({ current: s.id === req.sessionId, since: s.created_at, lastSeen: s.last_seen, ip: s.ip, device: s.user_agent })));
  }));
  router.post("/auth/sessions/end-others", requireAuth, ah(async (req, res) => {
    const n = await endSessions(null, req.user.id, req.sessionId);
    if (n) await audit(null, req.user.id, "Signed out other devices", `${n} session${n === 1 ? "" : "s"} ended`);
    res.json({ ended: n });
  }));

  router.get("/auth/me", (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

  router.post("/auth/password", requireAuth, ah(async (req, res) => {
    const { current, next } = parse(z.object({ current: z.string().min(1), next: passwordRule }), req.body);
    if (!(await bcrypt.compare(current, req.user.password_hash))) throw new HttpError(400, "Current password is incorrect.");
    if (current === next) throw new HttpError(400, "The new password must be different from the current one.");
    checkPassword(next, req.user.email);
    await query("UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = now() WHERE id = $2", [await hashPassword(next), req.user.id]);
    const ended = await endSessions(null, req.user.id, req.sessionId);
    await audit(null, req.user.id, "Changed own password", ended ? `signed out of ${ended} other session${ended === 1 ? "" : "s"}` : null);
    res.json({ ok: true });
  }));
}

/** Break-glass: RESET_MFA_FOR=<email> clears that account's two-step sign-in on boot (for a lost phone and lost codes). */
export async function breakGlassMfa() {
  const email = process.env.RESET_MFA_FOR;
  if (!email) return;
  const { rows } = await query(
    "UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = NULL, recovery_codes = '{}' WHERE lower(email) = lower($1) RETURNING id",
    [email]);
  if (rows[0]) {
    await endSessions(null, rows[0].id);
    await audit(null, null, `Two-step sign-in reset by RESET_MFA_FOR`, email);
    console.warn(`⚠️  Two-step sign-in reset for ${email}. Remove RESET_MFA_FOR from the environment now.`);
  }
}
