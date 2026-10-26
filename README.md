# BladeOS — Blades & Butchers

Digital operations platform: ranch → processing → cold room → POS → delivery → reports.

**Stack:** React 18 + Vite + Tailwind (frontend) · Node 20+/Express (API) · PostgreSQL via `pg` with SQL migrations.
One app serves both the API (`/api`) and the web app; it needs a PostgreSQL 14+ database.

## Deploy

Runs on any container host from the `Dockerfile` — **Fly.io** (`fly.toml`), Render, Koyeb, DigitalOcean, Cloud Run,
any VPS (`docker-compose.yml`), or Railway (`railway.json`). Step-by-step for each host, the settings, Cloudflare
(domain, HTTPS, R2 backups) and **moving your data from one host to another** are in **[DEPLOY.md](DEPLOY.md)**.

Settings: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `BACKUP_PASSPHRASE`, and
`PUBLIC_URL` for a custom domain (full list in `.env.example`). On boot the server runs migrations, creates reference
data and the Super Admin account, then listens. `/health` checks the database.

### First sign-in checklist
A new install has the shop's range from bladesbutchers.com — 19 products, 16 with photos on the POS tiles (beef cuts, goat,
ram, chicken, whole bird, turkey, eggs, sausages, marinated meat, frozen packs, kpomo and 4 packaging items) — plus 6 storage
locations and 2 ranches. Prices are starting prices: set the real ones in Business Setup → Products. Packaging items aren't
stock-counted (always sellable); everything else needs stock received before it can be sold.
The dashboard shows a *Getting started* card that ticks these off:
1. Sign in — BladeOS asks the Super Admin to replace the temporary `ADMIN_PASSWORD`. Two-step sign-in is optional: account menu →
   *Turn on two-step sign-in* (Google Authenticator / Microsoft Authenticator / Authy, plus 10 recovery codes).
2. *Business Setup*: check every price and cost, add products, rename locations and ranches to match the site.
3. *Suppliers*: add suppliers and any balance you already owe (as an invoice).
4. *Inventory → Receive / Adjust*: opening stock per location.
5. *Livestock → Add Animal*: the herd.
6. *Administration → Add User*: staff accounts. Each person gets a temporary password and must choose their own at first sign-in.

## Local development

```bash
cp .env.example .env        # fill in DATABASE_URL etc.
npm install
npm run dev:api             # API on :3000 (auto-restarts)
npm run dev                 # app on :5173, proxies /api
```
Scripts: `npm run db:migrate`, `npm run db:seed` (reference data + Super Admin).

## How it works

- **Auth:** email + password (bcrypt), a 12-hour signed cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) naming a server-side session that can be ended at any time. Mutations must be JSON
  (CSRF guard). 10 failed logins per 15 min → locked out temporarily. Passwords are 10+ characters; any password set by
  someone else is temporary and must be replaced at first sign-in. Idle sessions sign out after 30 minutes (shared tills).
- **Roles & controls** (`src/shared/permissions.js`, enforced by the API, mirrored in the menu):
  - *Super Admin* (Jeffrey): sees and does everything, and is the only role that sees **System** — Business Setup,
    Roadmap and Administration — and downloads the weekly backup. There is always at least one active Super Admin.
  - *Least privilege:* 11 roles; staff covering two jobs get extra roles on one account (leadership roles stand alone).
    Only the Super Admin can grant Super Admin, Owner, Managing Director or Administrator.
  - *Owner and MD* run the business (dashboard, reports, approvals above every limit, prices via Inventory, sales,
    marketing) but don't see System: no Business Setup, Roadmap, staff accounts, audit trail or backups.
  - *Administrator is a system role:* staff accounts, locations/ranches, audit trail — no prices, money or sales.
  - *Cost visibility:* cost prices, stock value at cost and livestock purchase costs only reach Owner, MD and Operations Manager.
    Ranch staff register animals without a cost; management records it (flagged until done).
  - *Maker-checker* (`server/controls.js`): write-offs, count corrections and refunds are requests; a different manager
    approves on the **Approvals** screen. Nobody approves their own. Owner/MD post directly (recorded). Storekeepers can
    receive (with a delivery reference) and transfer stock, but never write off or correct it.
  - *Refunds:* item-level, with reason codes. Delivered orders can't be cancelled — only refunded. Food safety: returned meat
    is written off; only a same-day counter sale rung up in error goes back into stock. All revenue figures are net of refunds.
- **Operations controls** (`server/operations.js`):
  - *Two-step sign-in* (TOTP, `server/totp.js`): optional for everyone — each person turns it on or off from the account menu (turning it off needs a
    current code or a recovery code). `REQUIRE_TWO_STEP=true` makes it mandatory for Super Admin, Owner, MD and Administrator. Secrets are
    AES-256-GCM encrypted (key from `JWT_SECRET` — rotating it means re-enrolling). Codes can't be replayed; 10 single-use
    recovery codes. The Super Admin/Administrator resets a lost phone under *Staff Accounts*; break-glass for the last Super Admin:
    set `RESET_MFA_FOR=<email>`, redeploy, sign in, then remove the variable.
  - *Batches & use-by:* every unit of stock belongs to a lot (processing batch, supplier delivery). Sales take the counter
    first, then the earliest use-by date; expired stock can't be sold. *Trace Batch* lists where a batch is and every
    customer who bought it, with a recall CSV. Shelf life per product in Business Setup.
  - *No till to open:* cashiers sign in and sell; managers set nothing up. The first sale records a till session for that
    cashier behind the scenes (no float — change money stays outside the system). At closing the cashier taps **End day**
    and counts the cash taken (a blind count); the system compares it with their cash sales less cash refunds.
    Cashier-only accounts get a full-screen POS (menu behind ☰).
  - *Cashier Sales* (managers, under Sales): each cashier's sales for any day — number of sales, net, cash / transfer /
    card, unpaid, refunds and their End day result — with totals, CSV export and print.
    Closing is a blind count; a different manager signs off, with an explanation for any variance.
    Delivery Managers use the same flow as a cash bag for cash on delivery.
  - *Cold chain:* safe range per location; readings out of range need a corrective action; alerts for breaches and
    checks overdue by 12 hours.
  - *Blind stock counts:* managers schedule; the counter never sees system figures; differences become correction
    requests for approval.
  - *Approval limits* (Business Setup → Controls, set by the Super Admin): what an Operations Manager may approve for write-offs,
    refunds and till variances; above that, Owner or MD.
- **Point of sale** (`server/pos.js`, `src/views/POS.jsx`) — built to the standard of retail POS systems:
  - *Scan or search:* one box takes a product barcode (EAN/UPC), a PLU, a name, or a **scale-printed label** (EAN-13
    starting with 2: PLU + weight in grams, or price — set under *Business Setup → Receipt & Till*). A USB barcode scanner
    works anywhere on the screen. Starting products have PLUs 1–11; new products get the next PLU.
  - *Ticket:* weighed items go through a weight screen (or the scale); tap any line to change quantity, add a line discount
    or remove it. Totals show subtotal, discount and VAT (per product, prices include VAT; basic food is 0%).
  - *Discounts:* always with a reason. Operations Managers discount up to the *discount* limit (default 10%); cashiers need a
    manager to approve on their till with **email + till PIN** (set from the account menu). Above the limit: Owner or MD.
    5 wrong PINs lock that PIN for 15 minutes; every approval and wrong PIN is in the audit trail.
  - *Tender:* Cash / Transfer / Card, any mix (split payment), on-screen keypad and quick-cash buttons, change due shown
    before completing. Transfers and card payments take a sender or slip reference. Delivery or account customers can pay later.
  - *Safe retries:* every ticket carries a unique reference, so a double tap or a dropped connection never charges twice.
  - *Hold / recall:* park a ticket (any till can recall it). *Clear* needs a reason and is counted on the till report.
  - *Receipt:* 80 mm, with business name, address, TIN, lines, discounts, VAT, tenders, change and a QR code of the order
    number. Orders → *Reprint receipt* prints a marked COPY.
  - *X / Z reports:* managers print an X report mid-shift (from the POS or Approvals → cash-ups); the cashier gets the Z report
    after the blind close. Both show sales, discounts by reason, tenders, refunds, cleared tickets and cash.
  - *Shortcuts:* F2 search · F4 pay · F8 hold · F9 discount · Enter = next sale.
  - *Hardware* (`src/lib/hardware.js`, **POS → Devices**, setup guide in `pos-setup/README.md`): the receipt printer is
    **found automatically**, in this order — the **BladeOS printer helper** on a Windows till (`server/till/helper.ps1`:
    127.0.0.1:17777, BladeOS origin only; ESC/POS goes RAW to the Windows queue, whatever the driver), ESC/POS over USB
    (WebUSB, allowed once with *Find printer*), a COM port (Web Serial), or browser printing to the Windows default
    printer. Direct printing cuts, prints the QR code and kicks the drawer on cash sales. The POS header shows printer and
    scanner status, and turns red when receipts are stuck in the Windows queue (Devices → *Clear stuck receipts*).
    The till's **desktop icon** comes from *account menu → Desktop icon* (`server/till.js` + `server/till/*.ps1`): one
    Windows setup file that repairs the receipt printer as administrator (moves it to the USB port it's really on, or
    creates it; clears stuck jobs; restarts the spooler; online; default), installs the helper, prints a test receipt
    and checks it left the queue, and adds a full-screen, silent-printing *BladeOS POS* shortcut with the customer
    screen on the second monitor. 80 or 58 mm; auto-print and copies; USB/Bluetooth barcode scanners (Enter, Tab or no
    suffix) with a scanner test; scale on its own port; and a customer screen on the terminal's second display showing
    items, total and change. Settings are per till.
  - Refunds give back what was actually paid per item (after discounts). Till cash-up and bank reconciliation count each
    tender of a split payment separately.
- **Installable app + offline till** (`src/lib/offline.js`, `src/views/Offline.jsx`, `src/sw-template.js`):
  - Installs from Chrome/Edge (account menu → *Install BladeOS app*) with its own icon and window; a service worker keeps
    the app files on the device so it opens with no internet. New versions download in the background and apply between
    sales ("A new version is ready").
  - Offline, the till sells (cash, card, transfer), holds and clears tickets, and records temperatures and checklists. Each
    item goes into an upload queue in IndexedDB that survives restarts and power cuts, and uploads in order when the internet
    returns (`POST /api/pos/offline-sales` keeps the sale time, price charged and offline receipt number T1-000123;
    repeats are ignored). Stock the system didn't have is recorded as a shortfall to count, never refused.
  - Offline sign-in and the idle lock use a per-till **Offline PIN** (PBKDF2, stored only on that till).
  - Limits: warning after 24 h offline, selling paused after 72 h; the till can't close while its sales are unsent.
- **Business controls** (`server/business.js`):
  - *Purchase orders:* raise → a different manager approves (Operations Managers up to the *purchase* limit; Owner/MD orders
    are approved on creation) → storekeepers receive deliveries only against an approved PO (weighed lines up to 5% over;
    each delivery becomes a lot with the supplier's batch number and use-by) → the supplier invoice is recorded against the PO
    and **3-way matched** (ordered / received / invoiced). A mismatch alerts whoever pays suppliers. Storekeepers never see prices.
  - *Payment reconciliation:* each sale records when it was paid and, for transfers / card, the sender or slip reference.
    Each day's transfer and card takings (less refunds) are compared with the bank statement and terminal settlement;
    differences need an explanation and a second manager's sign-off (above the *payment variance* limit: Owner/MD).
    If takings for a day change after it was recorded, sign-off is blocked until it's recorded again.
  - *Food safety (HACCP):* daily and weekly checklists (opening checks, closing clean-down, pest control, equipment &
    calibration — editable in *Food Safety → Edit checklists*). Every item answered; any "No" needs the corrective action;
    a manager who didn't do it verifies. Records export to CSV for inspections. Cold-chain readings sit alongside.
  - *Digital scale:* the POS and processing screens read weight straight from a USB / RS-232 scale (Web Serial — Chrome or
    Edge on a computer, over HTTPS). Only a *stable* reading can be used; overload and moving weights are refused.
    Sales record whether each KG line came off the scale; *Reports* shows the share. Settings (baud rate, poll command)
    under the ⚙ next to *Connect scale*, saved per computer. Tested against a simulated scale — confirm with yours.
  - *Backups* (`server/backup.js`): see below.
- **Product photos** live in `public/products/` and show on the POS tiles (Business Setup → Products → Edit → Photo:
  `/products/<file>` or an `https://` link). Items with *Count stock* unticked (services, packaging) are always sellable
  and don't appear on the stock screens.
- **Stock** is held per product *per location*, broken down by lot. Every change writes a `stock_movements` row.
  Sales, transfers, adjustments, processing and cancellations run in transactions with row locks,
  and the database refuses negative stock — concurrent tills can't oversell.
  Cancelling or a rung-up-in-error refund puts stock back into the exact lots it came from.
- **Processing** only accepts animals marked *Ready for Processing*; outputs can't exceed live weight.
  Cattle cuts go to the beef SKUs; goat → Goat Meat; sheep → Ram Meat.
- **Dashboards, reports, notifications, ButcherAI** are computed from live data in Lagos time
  (`server/state.js`).
- **Business Setup** (Super Admin, Administrator): products, storage locations and ranches. Nothing is deleted — items are *retired*,
  which hides them from pickers while history keeps them. A product retires once its stock is zero; a location once it's
  empty; a ranch once its animals are moved or processed. The 8 products that receive processing output can be renamed and
  repriced but not retired. A product's unit locks once stock has moved. The starting catalogue is created once,
  so renames and retirements survive redeploys.
- **Suppliers:** a ledger of invoices and payments per supplier (balance, invoiced and paid this year, last 10 entries).
  Operations Managers can add suppliers and record invoices; only Owner/MD/Administrator can record payments, and never more than is owed.
- **Customers & email marketing:** the customer form takes phone, email, birthday (day + month), area, delivery address and
  marketing consent; details can be edited from the profile. *Marketing* shows today's and this month's birthdays and
  **Customer emails**: write once, send to a group (everyone who agreed, birthdays today / this month, bought in the last
  30 days, not in 60 days) with each first name filled in, or *Send me a test*. Birthday greetings can go out
  automatically at 8:00 (once a year each). Only customers who agreed and haven't unsubscribed are ever emailed; every
  email has an unsubscribe link and one-click unsubscribe headers, and unsubscribing is recorded in the audit trail.
  Sending uses [Resend](https://resend.com): set `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `Blades & Butchers <hello@bladesbutchers.com>`,
  on a domain verified in Resend) — and `PUBLIC_URL` if the app has a custom domain. Without them, *Copy emails* gives the list for any email app.
- **Marketing:** campaigns (spend, leads, orders, revenue → ROAS, feeding Reports and ButcherAI) and a dated content calendar.
- **POS counter:** locations ticked *POS sells first* (Business Setup → Storage Locations) are drawn from before any
  other location, so renaming the shop counter doesn't change where sales come from.
- **Audit trail** records sign-ins, sales, price changes, transfers, batches, order and user changes.

## Layout
```
pos-setup/  BladeOS-POS.bat (manual alternative to account menu → Desktop icon) · README.md (Licon / till hardware setup)
server/   index.js · pos.js (sales, discounts, tender, held tickets, X/Z) · routes.js (writes) · controls.js (approvals, refunds) · operations.js (tills, temps, counts, trace, limits)
          business.js (purchase orders, payment reconciliation, HACCP) · backup.js + restore.js (backups)
          state.js (reads/KPIs) · stock.js (lots, FEFO) · auth.js + totp.js (sign-in, sessions) · seed.js · migrate.js
migrations/  numbered .sql files, applied once each on boot
src/      App.jsx (shell) · views/ · components/ · lib/ · shared/permissions.js
```

## Speed and reliability

- The till and sign-in load only what they need (≈150 KB compressed); chart screens (dashboard, reports, livestock)
  load on first use. Everything is still stored on the device for offline use.
- A new version installs in the background and switches over by itself as soon as nobody is mid-task.
- No request can hang the app: calls give up after 30 s like a dropped connection (sales can't double-charge —
  each carries a unique reference), device storage that doesn't answer within 4 s is bypassed, and if start-up takes
  over 10 s the screen offers **Reload** and **Repair app** (clears this device's cached copy; offline sales are kept).
- Phones: every table turns into readable cards — nothing scrolls sideways.

## Security, privacy and accessibility

- **Sign-in only:** BladeOS is internal, so nothing about the business, its controls or its set-up is shown before
  signing in — just the sign-in form and a short *Privacy notice* (staff and customer data, NDPA 2023). The customer-facing
  privacy notice belongs on the public Blades & Butchers website and at the counter.
- **Sessions:** every sign-in is recorded server-side. Signing out ends it for real; changing a password signs you out
  everywhere else; a password reset, role change, two-step reset or deactivation by an administrator ends all of that
  person's sessions at once. *Account menu → Signed-in devices* lists them and can sign out every other device.
  Sessions last 12 hours at most; idle screens sign out after 30 minutes.
- **Passwords:** at least 10 characters, and common passwords, simple runs, the business name or the person's email are refused.
- **Audit trail** is append-only: the database refuses any edit or deletion of it, even directly.
- **Requests from other websites** that try to change data are refused (Origin check, JSON-only, SameSite cookies).
  API answers are never cached. Headers: CSP, HSTS (1 year), nosniff, frame protection, Permissions-Policy
  (USB serial for the till only). Every response carries an `X-Request-Id`; server errors show the first 8 characters
  so a report from the shop floor can be found in the host's logs (e.g. `fly logs`), which hold one JSON line per error or slow request.
- **Customer data (Nigeria Data Protection Act 2023):** marketing consent is recorded when a customer is added and can be
  withdrawn from their profile; *Download their data* gives them everything held; the Owner or MD can *Erase personal data*
  (name, phone, area, order notes) — the sales stay in the accounts as "Erased customer". Card numbers are never stored.
- **Accessibility:** every main screen passes an automated WCAG 2.1 AA scan (axe-core) — colour contrast, labels on
  icon-only buttons, heading structure.

## Operations
- **Backups (chosen set-up: the host's database backups + weekly download):**
  1. *The database host's own backups* — turn on its daily backups (Fly Managed Postgres, Neon, Supabase, Railway). Covers
     mistakes, bad updates and accidental deletion.
  2. *A weekly copy kept elsewhere* — every Monday the Super Admin opens *Administration → Backups → Download weekly backup*.
     BladeOS makes a consistent copy of every table, encrypts it (AES-256-GCM, key from `BACKUP_PASSPHRASE`, 12+
     characters), **restore-tests that exact file** in a throw-away schema (every row and link checked), and only then
     hands it over, with its fingerprint (sha256) recorded in the audit trail. Keep each file in two places (office laptop +
     Google Drive) and keep the last 8. A reminder appears for the Super Admin after 7 days, and for Administrators after 14.
  Set only `BACKUP_PASSPHRASE` on the host, and keep it written down somewhere safe away from the host — without it the
  files can't be opened. (Optional later: add the `BACKUP_S3_*` variables to switch to automatic nightly off-site copies
  with monthly restore tests — the screen changes to *Back up now / Run restore test*.)
- **Restoring** (and moving host — step by step in [DEPLOY.md](DEPLOY.md)): `node server/restore.js --latest` on the server shows what it would restore; add `--yes` to replace all data
  (`--list` lists copies, `--key=<name>` picks one, or pass a downloaded weekly `.bdb` file — the usual case). Restore into a new database
  first if you want to inspect before switching over. Keep the same `JWT_SECRET`, or everyone re-enrols two-step sign-in.
- **Schema changes:** add `migrations/002_*.sql`; it runs automatically on next deploy.
- **Forgotten password / lost phone:** the Super Admin or an Administrator resets it under *Administration → Staff Accounts*
  (Administrators can't reset leadership accounts — only the Super Admin can).
- **Daily routine:** managers set a till approval PIN once (account menu); opening checks before trading;  log cold-room and freezer temperatures twice a
  day; reconcile yesterday's transfers and card takings to the bank and terminal; receive deliveries against purchase orders;
  closing clean-down; close tills and sign off cash-ups; write off anything past its use-by date.
  **Weekly:** blind count per location, pest-control and equipment checklists, verify the week's food-safety records.
  **Weekly (Monday):** Super Admin downloads the weekly backup and files it in two places.
