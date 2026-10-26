// Full restore — replaces EVERY table's data with a backup's.
//
//   node server/restore.js <file.bdb>          a downloaded backup file
//   node server/restore.js --latest            the newest off-site copy (BACKUP_S3_* variables)
//   node server/restore.js --list              list the off-site copies
//
// Add --yes to actually do it. Needs DATABASE_URL (and BACKUP_PASSPHRASE for encrypted files).
// Moving host: create the new database, point DATABASE_URL at it, then run this with the latest weekly file —
// e.g. on Fly.io: `fly ssh console -C "node server/restore.js /tmp/backup.bdb --yes"` (see DEPLOY.md).
import fs from "node:fs";
import { migrate } from "./migrate.js";
import { pool } from "./db.js";
import { backupConfig, restoreLive, s3Get, s3List, readBackup } from "./backup.js";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const target = args.find((a) => !a.startsWith("--"));

async function main() {
  const cfg = backupConfig();
  if (args.includes("--list")) {
    if (!cfg.s3) throw new Error("BACKUP_S3_* variables aren't set.");
    const list = (await s3List(cfg.s3)).sort((a, b) => b.modified - a.modified);
    for (const o of list) console.log(`${o.modified?.toISOString() ?? "?"}  ${o.key}`);
    return;
  }
  let buf, label;
  if (args.includes("--latest") || args.find((a) => a.startsWith("--key="))) {
    if (!cfg.s3) throw new Error("BACKUP_S3_* variables aren't set.");
    let key = args.find((a) => a.startsWith("--key="))?.slice(6);
    if (!key) {
      const list = (await s3List(cfg.s3)).filter((o) => o.key.endsWith(".bdb")).sort((a, b) => b.modified - a.modified);
      if (!list.length) throw new Error("No backups found in storage.");
      key = list[0].key;
    }
    buf = await s3Get(cfg.s3, key);
    label = key;
  } else if (target) {
    buf = fs.readFileSync(target);
    label = target;
  } else {
    console.log("Usage: node server/restore.js <file.bdb> | --latest | --key=<object key> | --list   [--yes]");
    process.exitCode = 2;
    return;
  }
  const { header } = await readBackup(buf, cfg.passphrase);
  const rows = header.tables.reduce((s, t) => s + t.rows, 0);
  console.log(`Backup ${label}\n  made ${header.createdAt} · ${header.tables.length} tables · ${rows} rows`);
  if (!yes) {
    console.log("\nThis will REPLACE ALL DATA in the database at DATABASE_URL. Run again with --yes to go ahead.");
    return;
  }
  await migrate();
  console.log("Restoring…");
  const r = await restoreLive(buf, cfg.passphrase);
  console.log(`Done: ${r.rows} rows in ${r.tables} tables, as of ${r.createdAt}.`);
  console.log("Everyone must sign in again if JWT_SECRET changed; two-step sign-in needs the same JWT_SECRET as when it was set up.");
}

main()
  .catch((e) => { console.error("Restore failed:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
