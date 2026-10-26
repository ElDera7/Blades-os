import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies migrations/*.sql in order, once each. Safe to run on every boot. */
export async function migrate() {
  const client = await pool.connect();
  try {
    // Advisory lock so two instances booting together don't race.
    await client.query("SELECT pg_advisory_lock(727274)");
    // BladeOS needs its own database. Never install into one that already holds another app's tables:
    // stop with a clear message instead of mixing the two (and failing half-way).
    const fresh = !(await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
    if (fresh) {
      const other = (await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")).rows.map((r) => r.table_name);
      if (other.length) {
        throw new Error(`This database already has ${other.length} table(s) from another app (${other.slice(0, 6).join(", ")}${other.length > 6 ? ", …" : ""}). `
          + "BladeOS needs its own empty PostgreSQL database: create one and point DATABASE_URL at it.");
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [f]);
        await client.query("COMMIT");
        console.log(`Migration applied: ${f}`);
      } catch (err) {
        await client.query("ROLLBACK");
        const shared = err.code === "42P07" || err.code === "42710";   // a table / trigger BladeOS creates is already there
        throw new Error(`Migration ${f} failed: ${err.message}`
          + (shared ? ". This database also holds another app's tables — BladeOS needs its own PostgreSQL database (see DEPLOY.md)." : ""));
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => { console.log("Migrations up to date."); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
