// Backups: a consistent logical copy of every table, compressed, encrypted and stored off-site,
// plus an automatic restore test that proves the copy can actually be loaded.
//
//   File (.bdb):  "BLDB1" | salt(16) | iv(12) | AES-256-GCM( gzip(NDJSON) ) | tag(16)     — encrypted
//                 gzip(NDJSON)                                                               — unencrypted (download without a passphrase)
//   NDJSON:       line 1 = header {format, version, createdAt, migrations, tables:[{name, columns, rows}], sequences}
//                 then one line per row: {"t": table, "r": row-as-json}
//
// Rows are read with row_to_json inside one REPEATABLE READ snapshot, so the copy is consistent and every
// value keeps its exact PostgreSQL text form. Restores load them with json_populate_recordset.
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { pool, query } from "./db.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const MAGIC = Buffer.from("BLDB1");
const FORMAT = "bladeos-backup";

/* ================================================================== configuration */
export function backupConfig() {
  const e = process.env;
  const s3 = e.BACKUP_S3_ENDPOINT && e.BACKUP_S3_BUCKET && e.BACKUP_S3_ACCESS_KEY && e.BACKUP_S3_SECRET_KEY
    ? {
        endpoint: e.BACKUP_S3_ENDPOINT.replace(/\/+$/, ""),
        bucket: e.BACKUP_S3_BUCKET,
        region: e.BACKUP_S3_REGION || "auto",
        accessKey: e.BACKUP_S3_ACCESS_KEY,
        secretKey: e.BACKUP_S3_SECRET_KEY,
        prefix: (e.BACKUP_S3_PREFIX ?? "bladeos/").replace(/^\/+/, ""),
      }
    : null;
  const passphrase = e.BACKUP_PASSPHRASE || null;
  return {
    s3,
    passphrase,
    // "offsite": nightly encrypted copy to S3-compatible storage. "manual": the host's own Postgres backups plus a
    // weekly encrypted download by the Owner (each download is restore-checked before it's handed over).
    mode: s3 ? "offsite" : "manual",
    passphraseOk: !!(passphrase && passphrase.length >= 12),
    retentionDays: Math.max(7, Number(e.BACKUP_RETENTION_DAYS) || 35),
    // Off-site copies must be encrypted: without a passphrase the scheduler won't upload.
    ready: !!(s3 && passphrase && passphrase.length >= 12),
    problem: !s3 ? "Off-site storage isn't set up (BACKUP_S3_* variables)."
      : !passphrase ? "BACKUP_PASSPHRASE isn't set — off-site copies must be encrypted."
      : passphrase.length < 12 ? "BACKUP_PASSPHRASE must be at least 12 characters." : null,
  };
}

/* ================================================================== encryption */
function keyFrom(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
export function encrypt(buf, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFrom(passphrase, salt), iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
}
export function isEncrypted(buf) {
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}
export function decrypt(buf, passphrase) {
  if (!isEncrypted(buf)) return buf;
  if (!passphrase) throw new Error("This backup is encrypted — set BACKUP_PASSPHRASE to the passphrase used when it was made.");
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(buf.length - 16), body = buf.subarray(33, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(passphrase, salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error("Can't decrypt this backup — wrong passphrase, or the file is damaged.");
  }
}
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* ================================================================== dump */
async function listTables(db, schema = "public") {
  const rows = (await db.query(
    `SELECT c.relname::text AS name,
       array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attgenerated = '') AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = $1 AND c.relkind = 'r'
     GROUP BY c.relname ORDER BY c.relname`, [schema])).rows;
  return rows;
}

const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** A consistent snapshot of the whole database as gzip'd NDJSON. */
export async function dumpDatabase() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await listTables(client);
    const seqs = (await client.query(
      `SELECT sequencename AS name, last_value, (last_value IS NOT NULL) AS is_called, start_value
       FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`)).rows;
    const migrations = (await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
    const lines = [];
    const meta = [];
    let total = 0;
    for (const t of tables) {
      const cols = t.columns.map(qi).join(", ");
      // Text, not parsed values: row_to_json keeps numerics, timestamps and arrays exactly.
      const { rows } = await client.query({ text: `SELECT row_to_json(x)::text AS j FROM (SELECT ${cols} FROM ${qi(t.name)}) x`, rowMode: "array" });
      for (const [j] of rows) lines.push(`{"t":${JSON.stringify(t.name)},"r":${j}}`);
      meta.push({ name: t.name, columns: t.columns, rows: rows.length });
      total += rows.length;
    }
    await client.query("COMMIT");
    const header = {
      format: FORMAT, version: 1, createdAt: new Date().toISOString(), migrations,
      tables: meta,
      sequences: Object.fromEntries(seqs.map((s) => [s.name, { value: s.last_value ?? s.start_value, isCalled: s.is_called }])),
    };
    const ndjson = Buffer.from([JSON.stringify(header), ...lines].join("\n") + "\n");
    return { gz: await gzip(ndjson, { level: 6 }), tables: meta.length, rows: total, header };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Read a backup file back into { header, rows: Map(table → [row objects as JSON text]) }. */
export async function readBackup(buf, passphrase) {
  const plain = await gunzip(decrypt(buf, passphrase)).catch((e) => {
    if (/decrypt|encrypted/.test(e.message)) throw e;
    throw new Error("This isn't a BladeOS backup file (or it's damaged).");
  });
  const text = plain.toString("utf8");
  const nl = text.indexOf("\n");
  const header = JSON.parse(text.slice(0, nl));
  if (header.format !== FORMAT) throw new Error("This isn't a BladeOS backup file.");
  const rows = new Map(header.tables.map((t) => [t.name, []]));
  let i = nl + 1;
  while (i < text.length) {
    const j = text.indexOf("\n", i);
    const line = text.slice(i, j < 0 ? text.length : j);
    i = j < 0 ? text.length : j + 1;
    if (!line) continue;
    // Keep each row as raw JSON text: it's passed straight to json_populate_recordset.
    const m = /^\{"t":("(?:[^"\\]|\\.)*"),"r":/.exec(line);
    if (!m) throw new Error("Backup file is damaged (bad row line).");
    const table = JSON.parse(m[1]);
    if (!rows.has(table)) throw new Error(`Backup file is damaged (unknown table ${table}).`);
    rows.get(table).push(line.slice(m[0].length, -1));
  }
  for (const t of header.tables) {
    if (rows.get(t.name).length !== t.rows) throw new Error(`Backup file is incomplete: ${t.name} has ${rows.get(t.name).length} of ${t.rows} rows.`);
  }
  return { header, rows };
}

/* ================================================================== load */
/** Tables ordered so that every table comes after the tables it references. */
export async function fkOrder(db, schema = "public") {
  const tables = (await listTables(db, schema)).map((t) => t.name);
  const deps = (await db.query(
    `SELECT DISTINCT c.relname AS child, p.relname AS parent FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = $1 AND c.oid <> p.oid`, [schema])).rows;
  const out = [], seen = new Set(), visiting = new Set();
  const visit = (t) => {
    if (seen.has(t)) return;
    if (visiting.has(t)) throw new Error(`Foreign-key cycle involving ${t}.`);
    visiting.add(t);
    for (const d of deps.filter((x) => x.child === t)) visit(d.parent);
    visiting.delete(t); seen.add(t); out.push(t);
  };
  tables.forEach(visit);
  return out;
}

/** Insert backed-up rows into `schema`.`table`, only for columns both sides have (newer columns take their defaults). */
async function loadTable(db, schema, table, backupCols, rows) {
  if (!rows.length) return 0;
  const live = (await listTables(db, schema)).find((t) => t.name === table);
  if (!live) throw new Error(`Table ${table} doesn't exist in this database.`);
  const cols = backupCols.filter((c) => live.columns.includes(c));
  const list = cols.map(qi).join(", ");
  const target = `${qi(schema)}.${qi(table)}`;
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = `[${rows.slice(i, i + 2000).join(",")}]`;
    await db.query(`INSERT INTO ${target} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${target}, $1::json)`, [chunk]);
  }
  return rows.length;
}

/** Orphaned foreign keys in `schema` — a restored copy must have none. */
async function orphanCheck(db, schema) {
  const fks = (await db.query(
    `SELECT c.relname AS child, p.relname AS parent, k.conname,
       (SELECT array_agg(a.attname::text ORDER BY x.n) FROM unnest(k.conkey) WITH ORDINALITY x(att, n) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.att) AS ccols,
       (SELECT array_agg(a.attname::text ORDER BY x.n) FROM unnest(k.confkey) WITH ORDINALITY x(att, n) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.att) AS pcols
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = 'public'`)).rows;
  const problems = [];
  for (const f of fks) {
    const notNull = f.ccols.map((c) => `c.${qi(c)} IS NOT NULL`).join(" AND ");
    const join = f.ccols.map((c, i) => `p.${qi(f.pcols[i])} = c.${qi(c)}`).join(" AND ");
    const r = (await db.query(`SELECT count(*)::int AS n FROM ${qi(schema)}.${qi(f.child)} c WHERE ${notNull}
      AND NOT EXISTS (SELECT 1 FROM ${qi(schema)}.${qi(f.parent)} p WHERE ${join})`)).rows[0];
    if (r.n) problems.push(`${f.child} → ${f.parent}: ${r.n} orphaned row${r.n === 1 ? "" : "s"}`);
  }
  return { checked: fks.length, problems };
}

/**
 * Restore test: load the backup into a throw-away schema next to the live tables, check every table's row count
 * and every foreign key, then drop it. Live data is never touched.
 */
export async function restoreIntoScratch(buf, passphrase) {
  const { header, rows } = await readBackup(buf, passphrase);
  const schema = `restore_test_${Date.now().toString(36)}`;
  const client = await pool.connect();
  const detail = { tables: [], fkChecked: 0, problems: [] };
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${qi(schema)}`);
    const liveTables = new Set((await listTables(client)).map((t) => t.name));
    for (const t of header.tables) {
      if (!liveTables.has(t.name)) { detail.problems.push(`${t.name} is in the backup but not in this database`); continue; }
      await client.query(`CREATE TABLE ${qi(schema)}.${qi(t.name)} (LIKE public.${qi(t.name)} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS)`);
    }
    for (const t of header.tables) {
      if (!liveTables.has(t.name)) continue;
      await loadTable(client, schema, t.name, t.columns, rows.get(t.name));
      const n = (await client.query(`SELECT count(*)::int AS n FROM ${qi(schema)}.${qi(t.name)}`)).rows[0].n;
      detail.tables.push({ name: t.name, expected: t.rows, restored: n });
      if (n !== t.rows) detail.problems.push(`${t.name}: restored ${n} of ${t.rows} rows`);
    }
    const fk = await orphanCheck(client, schema);
    detail.fkChecked = fk.checked;
    detail.problems.push(...fk.problems);
    await client.query("ROLLBACK"); // drops the scratch schema and everything in it
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return {
    ok: detail.problems.length === 0,
    tables: detail.tables.length,
    rows: detail.tables.reduce((s, t) => s + t.restored, 0),
    createdAt: header.createdAt,
    detail,
  };
}

/** Replace ALL live data with the backup's (used by server/restore.js). Runs in one transaction. */
export async function restoreLive(buf, passphrase, { log = console.log } = {}) {
  const { header, rows } = await readBackup(buf, passphrase);
  const client = await pool.connect();
  try {
    const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const newer = header.migrations.filter((m) => !applied.has(m));
    if (newer.length) throw new Error(`The backup was made by a newer BladeOS (${newer.join(", ")}). Deploy that version first.`);
    await client.query("BEGIN");
    const order = (await fkOrder(client)).filter((t) => t !== "schema_migrations");
    const inBackup = new Map(header.tables.map((t) => [t.name, t]));
    await client.query(`TRUNCATE ${order.map(qi).join(", ")} RESTART IDENTITY CASCADE`);
    let total = 0;
    for (const t of order) {
      const b = inBackup.get(t);
      if (!b) { log(`  ${t}: not in backup — left empty`); continue; }
      const n = await loadTable(client, "public", t, b.columns, rows.get(t));
      total += n;
      log(`  ${t}: ${n} rows`);
    }
    for (const [name, s] of Object.entries(header.sequences)) {
      const exists = (await client.query("SELECT 1 FROM pg_sequences WHERE schemaname = 'public' AND sequencename = $1", [name])).rows[0];
      if (exists) await client.query("SELECT setval($1::regclass, $2, $3)", [`public.${qi(name)}`, s.value, s.isCalled]);
    }
    const fk = await orphanCheck(client, "public");
    if (fk.problems.length) throw new Error(`Restored data fails foreign-key checks: ${fk.problems.join("; ")}`);
    await client.query("COMMIT");
    return { tables: order.length, rows: total, createdAt: header.createdAt };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ================================================================== S3-compatible storage (AWS Signature V4) */
const hmac = (key, s) => crypto.createHmac("sha256", key).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Sign a request for an S3-compatible service (R2, B2, S3, Wasabi, MinIO). Path-style URLs. */
export function signS3({ method, url, headers = {}, body = Buffer.alloc(0), region, accessKey, secretKey, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(h).sort();
  const canonicalPath = u.pathname.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/");
  const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete h.host; // fetch sets it
  return h;
}

async function s3(cfg, method, key, { body, query: q } = {}) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key ? key.split("/").map(enc).join("/") : ""}`);
  for (const [k, v] of Object.entries(q || {})) url.searchParams.set(k, v);
  const headers = signS3({ method, url: url.toString(), body: body ?? Buffer.alloc(0), headers: body ? { "content-type": "application/octet-stream" } : {},
    region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`Storage ${method} failed: ${res.status}${code ? ` ${code}` : ""}`);
  }
  return res;
}

export const s3Put = (cfg, key, body) => s3(cfg, "PUT", key, { body });
export const s3Get = async (cfg, key) => Buffer.from(await (await s3(cfg, "GET", key)).arrayBuffer());
export const s3Delete = (cfg, key) => s3(cfg, "DELETE", key);
export async function s3List(cfg) {
  const out = [];
  let token;
  do {
    const q = { "list-type": "2", prefix: cfg.prefix };
    if (token) q["continuation-token"] = token;
    const xml = await (await s3(cfg, "GET", "", { query: q })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1];
      const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1];
      if (key) out.push({ key: key.replace(/&amp;/g, "&"), modified: modified ? new Date(modified) : null });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : null;
  } while (token);
  return out;
}

/* ================================================================== jobs */
const stamp = (d = new Date()) => d.toISOString().replace(/[:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Make a backup and store it off-site. Records a row in `backups`. */
export async function runBackup({ kind = "scheduled", userId = null } = {}) {
  const cfg = backupConfig();
  if (!cfg.ready) throw new Error(cfg.problem);
  const row = (await query("INSERT INTO backups (kind, storage, encrypted, user_id) VALUES ($1, 's3', TRUE, $2) RETURNING id", [kind, userId])).rows[0];
  try {
    const dump = await dumpDatabase();
    const file = encrypt(dump.gz, cfg.passphrase);
    const key = `${cfg.s3.prefix}bladeos-${stamp()}.bdb`;
    await s3Put(cfg.s3, key, file);
    // Read it back and compare: an upload that can't be fetched intact isn't a backup.
    const back = await s3Get(cfg.s3, key);
    const hash = sha256(file);
    if (sha256(back) !== hash) throw new Error("The stored copy doesn't match what was uploaded.");
    await query(`UPDATE backups SET status = 'Succeeded', location = $2, bytes = $3, sha256 = $4, tables = $5, rows = $6, finished_at = now() WHERE id = $1`,
      [row.id, key, file.length, hash, dump.tables, dump.rows]);
    await prune(cfg).catch((e) => console.error("Backup retention clean-up failed:", e.message));
    return { id: row.id, key, bytes: file.length, tables: dump.tables, rows: dump.rows };
  } catch (err) {
    await query("UPDATE backups SET status = 'Failed', error = $2, finished_at = now() WHERE id = $1", [row.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

/** Delete off-site copies older than the retention period — but always keep the newest 7. */
async function prune(cfg) {
  const objects = (await s3List(cfg.s3)).filter((o) => /bladeos-.*\.bdb$/.test(o.key)).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  const cutoff = Date.now() - cfg.retentionDays * 864e5;
  for (const o of objects.slice(7)) {
    if (o.modified && o.modified.getTime() < cutoff) await s3Delete(cfg.s3, o.key);
  }
}

/** Fetch the newest good off-site backup, check its fingerprint, and restore it into a scratch schema. */
export async function runRestoreTest({ userId = null } = {}) {
  const cfg = backupConfig();
  if (!cfg.ready) throw new Error(cfg.problem);
  const b = (await query("SELECT * FROM backups WHERE status = 'Succeeded' AND storage = 's3' ORDER BY started_at DESC LIMIT 1")).rows[0];
  if (!b) throw new Error("There's no off-site backup to test yet — run a backup first.");
  const t = (await query("INSERT INTO restore_tests (backup_id, user_id) VALUES ($1, $2) RETURNING id", [b.id, userId])).rows[0];
  try {
    const file = await s3Get(cfg.s3, b.location);
    if (sha256(file) !== b.sha256) throw new Error("The stored backup's fingerprint has changed since it was made.");
    const r = await restoreIntoScratch(file, cfg.passphrase);
    if (r.rows !== b.rows) r.detail.problems.push(`restored ${r.rows} rows; the backup recorded ${b.rows}`);
    const ok = r.detail.problems.length === 0;
    await query(`UPDATE restore_tests SET status = $2, tables = $3, rows = $4, detail = $5, error = $6, finished_at = now() WHERE id = $1`,
      [t.id, ok ? "Passed" : "Failed", r.tables, r.rows, JSON.stringify(r.detail), ok ? null : r.detail.problems.slice(0, 5).join("; ")]);
    return { id: t.id, ok, tables: r.tables, rows: r.rows, problems: r.detail.problems, backupId: b.id };
  } catch (err) {
    await query("UPDATE restore_tests SET status = 'Failed', error = $2, finished_at = now() WHERE id = $1", [t.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

/* ================================================================== scheduler */
const LOCK_KEY = 74102931; // advisory lock: only one instance runs scheduled jobs
const lagosHour = () => new Date(Date.now() + 3600e3).getUTCHours();

export async function scheduledTick() {
  const cfg = backupConfig();
  if (!cfg.ready) return;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY])).rows[0].ok;
    if (!locked) return;
    // Anything left "Running" for an hour was interrupted by a restart.
    await client.query("UPDATE backups SET status = 'Failed', error = 'Interrupted (server restarted)', finished_at = now() WHERE status = 'Running' AND started_at < now() - interval '1 hour'");
    await client.query("UPDATE restore_tests SET status = 'Failed', error = 'Interrupted (server restarted)', finished_at = now() WHERE status = 'Running' AND started_at < now() - interval '1 hour'");
    const last = (await client.query("SELECT max(started_at) AS at FROM backups WHERE status = 'Succeeded' AND storage = 's3'")).rows[0].at;
    const lastTry = (await client.query("SELECT max(started_at) AS at FROM backups WHERE storage = 's3'")).rows[0].at;
    const hoursSince = (d) => (d ? (Date.now() - new Date(d).getTime()) / 3600e3 : Infinity);
    // Daily, in the quiet hours after 02:00 Lagos time; after a failure, retry every 2 hours.
    if (hoursSince(last) >= 23 && (lagosHour() >= 2 || hoursSince(last) >= 30) && hoursSince(lastTry) >= 2) {
      await runBackup({ kind: "scheduled" }).catch((e) => console.error("Scheduled backup failed:", e.message));
    }
    const lastTest = (await client.query("SELECT max(started_at) AS at FROM restore_tests")).rows[0].at;
    if (hoursSince(lastTest) >= 24 * 30) {
      await runRestoreTest().catch((e) => console.error("Scheduled restore test failed:", e.message));
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export function startScheduler() {
  const tick = () => {
    scheduledTick().catch((e) => console.error("Backup scheduler:", e.message));
    import("./email.js").then((m) => m.birthdayTick()).catch((e) => console.error("Birthday emails:", e.message));
    // Housekeeping: sign-in records are kept 90 days after they end (enough to investigate an incident), then removed.
    pool.query("DELETE FROM user_sessions WHERE expires_at < now() - interval '90 days'").catch(() => {});
  };
  setTimeout(tick, 60e3).unref();
  setInterval(tick, 15 * 60e3).unref();
}
