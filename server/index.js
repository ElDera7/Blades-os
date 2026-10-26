import express from "express";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";
import { bootstrap } from "./seed.js";
import { apiRouter } from "./routes.js";
import { errorHandler } from "./util.js";
import { startScheduler } from "./backup.js";
import { tillRoutes } from "./till.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // the host's edge proxy (Fly.io, Render, Railway…) — needed for real client IPs and secure cookies.

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:", "blob:"],
      "connect-src": ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "http://127.0.0.1:17777"], // fonts kept for offline use; the till's own BladeOS printer helper (loopback only)
      "frame-ancestors": ["'self'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"],
      "worker-src": ["'self'"],
      "manifest-src": ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
}));
// Only the hardware the till really uses: USB and USB-serial (receipt printer, scale), nothing else for anyone.
app.use((_req, res, next) => {
  res.set("Permissions-Policy", "serial=(self), usb=(self), camera=(), microphone=(), geolocation=(), payment=()");
  next();
});
// Every request gets an id (echoed to the browser) so a cashier's "something went wrong" can be found in the logs.
// Errors and slow requests are logged as one JSON line each — the host keeps and searches them.
app.use((req, res, next) => {
  const id = req.get("x-request-id")?.slice(0, 64) || crypto.randomUUID();
  const t0 = process.hrtime.bigint();
  req.id = id;
  res.set("X-Request-Id", id);
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (res.statusCode >= 500 || ms > 2000 || (req.path.startsWith("/api/auth/") && res.statusCode === 429)) {
      console.log(JSON.stringify({ at: new Date().toISOString(), level: res.statusCode >= 500 ? "error" : "warn", id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), ip: req.ip }));
    }
  });
  next();
});
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.set("Cache-Control", "no-store").json({ status: "ok", db: "ok", uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
});

app.use("/api", apiRouter());
tillRoutes(app);   // the till's desktop icon (Windows setup file)

if (fs.existsSync(path.join(DIST, "index.html"))) {
  app.use("/assets", express.static(path.join(DIST, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  // The service worker and manifest must always be re-checked, or tills would keep running an old version.
  app.get(["/sw.js", "/manifest.webmanifest"], (req, res) => {
    res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" }).sendFile(path.join(DIST, req.path.slice(1)));
  });
  app.use(express.static(DIST, { index: false, maxAge: "1h" }));
  app.get("*", (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(DIST, "index.html"));
  });
} else {
  console.warn("dist/ not found — API only. Run `npm run build` to serve the app.");
}

app.use(errorHandler);

// Never die silently: log anything unexpected with a timestamp (the host restarts the app if it exits).
process.on("unhandledRejection", (err) => console.error(JSON.stringify({ at: new Date().toISOString(), level: "error", unhandledRejection: String(err?.stack || err) })));
process.on("uncaughtException", (err) => { console.error(JSON.stringify({ at: new Date().toISOString(), level: "fatal", uncaughtException: String(err?.stack || err) })); process.exit(1); });

// On a new deploy the database is often still starting (Railway, Render, docker compose): wait for it
// (up to DB_WAIT_SECONDS, default 120) instead of failing and restart-looping.
async function waitForDatabase() {
  const limit = (Number(process.env.DB_WAIT_SECONDS) || 120) * 1000;
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    try { await pool.query("SELECT 1"); if (i > 1) console.log("Database is ready."); return; }
    catch (e) {
      if (Date.now() - t0 > limit) throw new Error(`Database not reachable after ${Math.round(limit / 1000)} s (${e.code || e.message}). Check DATABASE_URL.`);
      if (i === 1 || i % 5 === 0) console.log(`Waiting for the database… (${e.code || e.message})`);
      await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * i)));
    }
  }
}

async function start() {
  await waitForDatabase();
  await migrate();
  await bootstrap();
  const server = app.listen(PORT, "0.0.0.0", () => console.log(`BladeOS running on port ${PORT}`));
  startScheduler(); // daily off-site backup + monthly restore test (when BACKUP_* variables are set)
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((err) => {
  console.error("Startup failed: " + (err?.message || err));
  if (err?.stack && !/^Database not reachable/.test(err.message)) console.error(err.stack);
  process.exit(1);
});
