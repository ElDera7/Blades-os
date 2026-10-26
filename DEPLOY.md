# Deploying BladeOS

BladeOS is one Node.js app (API + web app together) plus a PostgreSQL 14+ database. The `Dockerfile` in this repo
builds one image that runs on any container host. Nothing in the code is tied to one provider.

| Where | What you use from this repo |
|---|---|
| **Fly.io** (recommended) | `Dockerfile` + `fly.toml` |
| **Render** | `render.yaml` (one-click Blueprint: app + database) |
| Koyeb, Northflank, DigitalOcean App Platform, Google Cloud Run | `Dockerfile` |
| Any VPS with Docker (DigitalOcean Droplet, Hetzner, Lightsail…) | `docker-compose.yml` (app + its own PostgreSQL) |
| Railway | `railway.json` (builds the Dockerfile) |
| Cloudflare | DNS, HTTPS proxy and R2 backups **in front of** one of the above — see the Cloudflare section |

Every push to GitHub is checked automatically (`.github/workflows/ci.yml`): the image is built, started on a fresh
database and signed in to. A green ✓ next to the commit on GitHub means it's safe to deploy; a red ✗ means don't.

The app waits up to 2 minutes for the database on start-up (`DB_WAIT_SECONDS`), so a database that's still starting
on a new project doesn't break the first deploy. A wrong `DATABASE_URL` stops it with a clear message in the logs.

**BladeOS needs its own PostgreSQL database.** Never point it at a database another app uses: it refuses to install
into one that already has other tables ("This database already has … table(s) from another app") rather than mixing
them. On Railway, add a new PostgreSQL service just for BladeOS and reference that one.

Whichever host: keep **exactly one** copy of the app running (the daily schedule — backup reminders, birthday
emails — runs inside it), and don't let it sleep (the till must never wait for a cold start).

## Settings (every host)

| Setting | Value |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (most hosts fill this in when you attach a database) |
| `JWT_SECRET` | `openssl rand -hex 32` — **moving host: the same value as before** (see *Moving from another host*) |
| `ADMIN_EMAIL` | the Super Admin's email (Jeffrey) |
| `ADMIN_PASSWORD` | temporary, 8+ characters — replaced at first sign-in |
| `ADMIN_NAME` | e.g. `Jeffrey` |
| `BACKUP_PASSPHRASE` | 12+ characters — encrypts the weekly backup file. Keep a copy outside the host |
| `PUBLIC_URL` | only with a custom domain, e.g. `https://pos.bladesbutchers.com` |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional — customer emails |
| `REQUIRE_TWO_STEP` | optional — `true` makes two-step sign-in mandatory for leadership (off by default) |

Do **not** set `NODE_ENV` at build time (the image sets it for running only). The full list with notes is in
`.env.example`. On start-up the app applies database migrations, creates the Super Admin on an empty database,
then answers `GET /health` (`{"status":"ok","db":"ok"}`).

## Fly.io

Install flyctl (Mac): `brew install flyctl`, then from this folder:

```bash
fly auth login
fly launch --copy-config --no-deploy
fly mpg create
fly mpg attach <CLUSTER_ID> -a <your-app-name>
fly secrets set JWT_SECRET=<value> ADMIN_EMAIL=<email> ADMIN_PASSWORD=<temporary> ADMIN_NAME=Jeffrey BACKUP_PASSPHRASE=<passphrase>
fly deploy
fly scale count 1
```

- `fly launch` asks for an app name; keep the settings from `fly.toml` (region `lhr`, always on, one machine).
- `fly mpg create` makes a Fly Managed Postgres database and prints its cluster id; `fly mpg attach` sets
  `DATABASE_URL` on the app. Any other PostgreSQL works too (Neon, Supabase…): `fly secrets set DATABASE_URL=...`.
- The app is at `https://<your-app-name>.fly.dev` — it knows its address by itself.
- Logs: `fly logs`. Shell on the server: `fly ssh console`.
- Turn on your database's daily backups as well (Fly Managed Postgres keeps them; Neon/Supabase have them too).

Custom domain: `fly certs add pos.bladesbutchers.com`, add the DNS records it prints, then
`fly secrets set PUBLIC_URL=https://pos.bladesbutchers.com`.

## Railway

1. **New Project → Deploy from GitHub repo** → pick this repo. Railway builds the `Dockerfile` (`railway.json`).
2. In the same project: **+ New → Database → PostgreSQL** — a new one, only for BladeOS. Rename it `bladeos-db`.
3. App service → **Variables**: `DATABASE_URL` = `${{bladeos-db.DATABASE_URL}}`, plus the settings above.
4. **Settings → Networking → Generate Domain**. The app knows its Railway address by itself.
5. Postgres service → **Backups**: turn on the daily schedule.

## Render

1. **New → Blueprint** → pick this repo. `render.yaml` creates the app (Docker, health check `/health`,
   1 instance, always on) and its PostgreSQL database, and generates `JWT_SECRET`.
2. Fill in `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `BACKUP_PASSPHRASE` when asked → **Apply**.
3. Moving from another host: before the first sign-in, set `JWT_SECRET` to the old value (app → Environment).
4. Address: `https://bladeos.onrender.com` (or similar) — the app knows it by itself. Custom domain: Settings →
   Custom Domains, then set `PUBLIC_URL`.

## Koyeb, Northflank, DigitalOcean App Platform, Cloud Run

1. New web service from this GitHub repo → **Dockerfile** build. Port **8080**, health check path **/health**.
2. Create a PostgreSQL database with the same provider (or Neon/Supabase) and put its connection string in `DATABASE_URL`.
3. Add the settings above. Plan: an always-on instance (no free tier that sleeps), **1 instance**.
4. Set `PUBLIC_URL` to the address they give you.

## Any VPS with Docker

```bash
git clone <this repo> bladeos && cd bladeos
cp .env.example .env
nano .env
docker compose up -d --build
```

Fill in `.env`: `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `BACKUP_PASSPHRASE`, `POSTGRES_PASSWORD`, `PUBLIC_URL`.
The app listens on port 8080. Put HTTPS in front: Cloudflare proxy (below), or Caddy
(`caddy reverse-proxy --from pos.bladesbutchers.com --to localhost:8080`). Updating: `git pull && docker compose up -d --build`.
Back up the database volume as well as the weekly download (`docker compose exec db pg_dump -U bladeos bladeos > dump.sql`).

## Cloudflare

Cloudflare Pages and Workers can't run BladeOS itself: it's a long-running Node server with a PostgreSQL connection
and a daily schedule. Use Cloudflare for what it's good at, in front of one of the hosts above:

- **Domain and HTTPS:** add the domain to Cloudflare, point `pos` (CNAME) at the host's address, proxy on
  (orange cloud), SSL mode **Full (strict)**. Set `PUBLIC_URL` on the app to the new address.
- **Off-site backups:** create an R2 bucket and set the `BACKUP_S3_*` settings (see `.env.example`) — nightly
  encrypted copies, restore-tested monthly.
- Don't cache `/api/*` (BladeOS already sends `Cache-Control: no-store` there).

## Moving from another host (e.g. off Railway)

1. On the old host, if you still can: **Administration → Backups → Download weekly backup** (a `.bdb` file), and
   copy its `JWT_SECRET` and `BACKUP_PASSPHRASE`. Otherwise use your latest weekly file.
2. Deploy on the new host with the **same** `JWT_SECRET` and `BACKUP_PASSPHRASE`, and let it start once
   (it creates the empty tables).
3. Restore the file into the new database — it replaces everything with the backup:
   - Fly.io: `fly ssh sftp shell` → `put bladeos-….bdb /tmp/backup.bdb`, then
     `fly ssh console -C "node server/restore.js /tmp/backup.bdb --yes"`
   - Docker / VPS: `docker compose cp bladeos-….bdb app:/tmp/backup.bdb` then
     `docker compose exec app node server/restore.js /tmp/backup.bdb --yes`
   - From your computer (any host whose database you can reach): `DATABASE_URL=… BACKUP_PASSPHRASE=… node server/restore.js bladeos-….bdb --yes`
4. Sign in with your usual email and password. Everyone signs in again once.
5. **Old `JWT_SECRET` lost?** Two-step sign-in codes can't be read with a new one. Set `RESET_MFA_FOR=<your email>`,
   redeploy, sign in, set up two-step sign-in again, remove `RESET_MFA_FOR`, then reset the other managers under
   *Administration → Staff Accounts* (they set it up again at their next sign-in).
6. Tills: open the new address, then account menu → **Desktop icon** → download and run the till setup again
   (it points the desktop icon and the printer helper at the new address).

## After deploying — check

```bash
curl -s https://<your-address>/health
curl -s https://<your-address>/downloads/BladeOS-Till-Setup.cmd | grep BLADEOS_BASE
```

The first prints `{"status":"ok","db":"ok",…}`; the second shows your address.
