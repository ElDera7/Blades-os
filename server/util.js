import { ZodError } from "zod";
import { query } from "./db.js";

export const TZ = "Africa/Lagos";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate req.body with a zod schema and return the parsed value. */
export function parse(schema, data) {
  return schema.parse(data ?? {});
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({ error: `${first.path.join(".") || "input"}: ${first.message}` });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  // Errors from Express itself: missing static file (404), bad JSON (400), oversized body (413)…
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) {
    const msg = status === 404 ? "Not found" : err.type === "entity.parse.failed" ? "Request body isn't valid JSON." : status === 413 ? "Request is too large." : "Bad request.";
    return res.status(status).json({ error: msg });
  }
  if (err.code === "23505") {
    const which = { products_barcode_uq: "That barcode is already on another product.", products_plu_uq: "That PLU is already used by another product." }[err.constraint];
    return res.status(409).json({ error: which || "That record already exists." });
  }
  if (err.code === "23514") return res.status(409).json({ error: "That change would break a stock or data rule." });
  console.error(JSON.stringify({ at: new Date().toISOString(), level: "error", id: req.id, method: req.method, path: req.path, user: req.user?.id, error: String(err?.stack || err) }));
  res.status(500).json({ error: `Something went wrong on the server. If it keeps happening, quote reference ${String(req.id || "").slice(0, 8)}.` });
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
const shortFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

export const fmtDate = (d) => (d ? dateFmt.format(new Date(d)) : "—");
export const fmtShort = (d) => (d ? shortFmt.format(new Date(d)) : "—");
export const fmtDateTime = (d) => (d ? `${dateFmt.format(new Date(d))}, ${timeFmt.format(new Date(d))}` : "—");

export const round2 = (n) => Math.round(n * 100) / 100;
export const round3 = (n) => Math.round(n * 1000) / 1000;

export async function audit(db, userId, action, detail) {
  await (db?.query ? db : { query }).query(
    "INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)",
    [userId ?? null, action, detail ?? null]
  );
}
