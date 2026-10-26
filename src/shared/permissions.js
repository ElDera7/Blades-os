// Shared between server (enforcement) and client (navigation/visibility).
//
// Design principles (standard internal-control practice for retail and food businesses):
//   • Least privilege — each role gets only what its job needs.
//   • Segregation of duties — whoever handles goods or cash can't also approve losses or refunds
//     against them; system administration is kept apart from commercial authority.
//   • Maker-checker — write-offs, stock corrections and refunds are requested by one person and
//     approved by another. Nobody can approve their own request. Only Owner/MD post directly.

export const ROLES = [
  "Super Admin",
  "Owner",
  "Managing Director",
  "Operations Manager",
  "Ranch Manager",
  "Production Manager",
  "Storekeeper",
  "Cashier",
  "Delivery Manager",
  "Marketing Manager",
  "Administrator",
];

/** Roles that can't be combined with others, and that only an Owner can grant. */
export const LEADERSHIP_ROLES = ["Super Admin", "Owner", "Managing Director", "Administrator"];
/** The platform's system owner: sees and can do everything, and is the only one who sees the System section
 *  (Business Setup, Roadmap, Administration) besides the Administrator. Only a Super Admin grants leadership roles. */
export const SUPER_ADMIN = "Super Admin";
/** Roles that can be held together on one account (e.g. Cashier + Storekeeper). */
export const COMBINABLE_ROLES = ROLES.filter((r) => !LEADERSHIP_ROLES.includes(r));

const EXEC = ["Owner", "Managing Director"];           // commercial authority
const MGMT = [...EXEC, "Operations Manager"];          // + day-to-day management

export const PERMISSIONS = {
  // Overview
  "dashboard.view":         MGMT,
  "reports.view":           MGMT,
  "ai.use":                 MGMT,
  "costs.view":             MGMT,   // cost prices, stock value at cost, livestock purchase cost, margins

  // Ranch & processing
  "ranch.view":             [...MGMT, "Ranch Manager", "Production Manager"],
  "ranch.edit":             [...MGMT, "Ranch Manager"],
  "processing.view":        [...MGMT, "Production Manager", "Ranch Manager", "Storekeeper"],
  "processing.edit":        [...MGMT, "Production Manager"],

  // Inventory
  "inventory.view":         [...MGMT, "Storekeeper", "Production Manager", "Cashier"],
  "stock.receive":          [...MGMT, "Storekeeper"],                  // goods received, with a delivery reference
  "stock.transfer":         [...MGMT, "Storekeeper"],
  "stock.adjust.request":   ["Operations Manager", "Storekeeper"],     // request a write-off / count correction
  "stock.adjust.approve":   MGMT,                                      // never your own request
  "stock.adjust.direct":    EXEC,                                      // post without a second approver
  "products.edit":          EXEC,                                      // products, prices, costs, shelf life
  "temps.record":           [...MGMT, "Storekeeper", "Production Manager"], // cold-chain readings
  "counts.schedule":        MGMT,                                      // schedule blind stock counts
  "counts.perform":         [...MGMT, "Storekeeper"],                  // count without seeing the system figure
  "trace.view":             MGMT,                                      // batch recall trace (shows customers)
  "haccp.complete":         [...MGMT, "Storekeeper", "Production Manager", "Cashier"], // food-safety checklists
  "haccp.verify":           MGMT,                                      // manager verifies (never their own)

  // Sales
  "pos.use":                [...MGMT, "Cashier"],
  "pos.discount":           MGMT,                                      // give / authorise discounts (manager PIN at the till), up to limit
  "till.use":               [...MGMT, "Cashier", "Delivery Manager"],  // open/close own till or cash bag
  "till.review":            MGMT,                                      // sign off other people's cash-ups
  "orders.view":            [...MGMT, "Cashier", "Delivery Manager", "Marketing Manager"],
  "orders.edit":            [...MGMT, "Cashier", "Delivery Manager"],  // status, paid, cancel before delivery
  "refunds.request":        ["Operations Manager", "Cashier"],
  "refunds.approve":        MGMT,                                      // never your own request
  "refunds.direct":         EXEC,
  "customers.view":         [...MGMT, "Cashier", "Delivery Manager", "Marketing Manager"],
  "customers.edit":         [...MGMT, "Cashier", "Marketing Manager"],
  "customers.erase":        EXEC,     // erase a customer's personal data on request (NDPA 2023); sales stay
  "delivery.view":          [...MGMT, "Delivery Manager"],

  // Procurement
  "procurement.view":       MGMT,
  "procurement.edit":       MGMT,     // suppliers and their invoices
  "payables.pay":           EXEC,     // the person recording invoices can't also pay them
  "purchasing.view":        [...MGMT, "Storekeeper"],                  // storekeepers see what to receive, never prices
  "purchasing.create":      MGMT,     // raise purchase orders (Owner/MD's are approved on creation)
  "purchasing.approve":     MGMT,     // never your own; Operations Manager up to the purchase limit

  // Money
  "payments.reconcile":     MGMT,     // match transfers / card takings to the bank and terminal statements

  // Marketing
  "marketing.view":         [...EXEC, "Marketing Manager"],
  "marketing.edit":         [...EXEC, "Marketing Manager"],

  // System — the System section (Business Setup, Roadmap, Administration) is for the Super Admin and the Administrator,
  // not the Owner or MD. Owner/MD still change prices (Inventory → Edit product) and approve above every limit.
  "setup.manage":           ["Administrator"],                          // Business Setup: products, locations, ranches, receipt, limits
  "users.manage":           ["Administrator"],                          // staff accounts (leadership roles: Super Admin only)
  "audit.view":             ["Administrator"],
  "controls.manage":        EXEC,                                      // approve above every limit (limits are set in Business Setup)
  "backups.manage":         ["Administrator"],                          // backup status, back up now, restore test
  "backups.download":       [],                                         // a full copy of the data leaves the building (Super Admin)
  "system.roadmap":         [],                                         // Roadmap (Super Admin)
};
// The Super Admin holds every permission.
for (const k of Object.keys(PERMISSIONS)) PERMISSIONS[k] = [SUPER_ADMIN, ...PERMISSIONS[k]];

/** `roles` may be one role or an array of roles; any of them granting `perm` is enough. */
export function can(roles, perm) {
  const list = Array.isArray(roles) ? roles : roles ? [roles] : [];
  const allowed = PERMISSIONS[perm] || [];
  return list.some((r) => allowed.includes(r));
}

export const canAny = (roles, perms) => perms.some((p) => can(roles, p));

export const APPROVAL_PERMS = ["stock.adjust.request", "stock.adjust.approve", "stock.adjust.direct", "refunds.request", "refunds.approve", "refunds.direct", "till.review"];
/** Approvals above the Operations Manager's limits (and any limit-free sign-off) need one of these. */
export const UNLIMITED_APPROVER = "controls.manage";

// Which permission (or any of a list) unlocks each screen in the app. null = everyone.
export const ROUTE_PERMS = {
  dashboard: "dashboard.view",
  approvals: APPROVAL_PERMS,
  ranch: "ranch.view",
  processing: "processing.view",
  inventory: "inventory.view",
  pos: "pos.use",
  orders: "orders.view",
  cashiers: "till.review",
  customers: "customers.view",
  delivery: "delivery.view",
  procurement: "procurement.view",
  purchases: "purchasing.view",
  payments: "payments.reconcile",
  foodsafety: ["haccp.complete", "haccp.verify"],
  marketing: "marketing.view",
  reports: "reports.view",
  setup: "setup.manage",
  roadmap: "system.roadmap",
  admin: ["audit.view", "users.manage"],
};

export const routeAllowed = (roles, route) => {
  const p = ROUTE_PERMS[route];
  if (p === undefined) return false;
  if (p === null) return true;
  return Array.isArray(p) ? canAny(roles, p) : can(roles, p);
};

export const ORDER_FLOW = ["New", "Confirmed", "Processing", "Out for Delivery", "Delivered"];

// Processing batches write into these products, so they can be renamed and repriced but never retired.
export const PROCESSING_SKUS = ["PB-BEEF", "STEW-BEEF", "BL-BEEF", "MINCE-BEEF", "OTH-BEEF", "GOAT-MEAT", "RAM-MEAT", "KPOMO"];

export const CONTENT_STATUSES = ["Draft", "Pending Approval", "Approved", "Scheduled", "Published"];

// Reason codes keep write-offs and refunds analysable.
export const WASTAGE_REASONS = ["Spoilage / expired", "Trim loss", "Damaged packaging", "Temperature breach", "Theft / unexplained loss"];
export const CORRECTION_REASONS = ["Stock count variance", "Data entry error", "Unrecorded delivery"];
// Food safety: meat that has left the shop is never resold. Only goods that never left the counter go back into stock.
export const RESTOCK_REASON = "Rung up in error — goods never left the counter";
export const REFUND_REASONS = [RESTOCK_REASON, "Quality complaint", "Short weight / overcharged", "Wrong item supplied", "Late or failed delivery"];

export const PASSWORD_MIN = 10;
/** Passwords attackers try first (NIST SP 800-63B: refuse common, guessable and context-specific passwords). */
const COMMON = ["1234567890", "0123456789", "12345678910", "qwertyuiop", "1q2w3e4r5t", "abcdefghij", "iloveyou12", "football12", "welcome123", "admin12345", "nigeria123", "abuja12345", "lagos12345", "changeme123", "letmein123", "trustno1234", "monkey12345", "princess12", "sunshine12", "superman12", "qwerty1234", "qwerty12345", "asdfghjkl1", "zaq12wsxcde", "1qaz2wsx3edc"];
/** Returns why a password is too easy to guess, or null when it's fine. */
export function weakPassword(pw = "", email = "") {
  const p = pw.toLowerCase();
  const letters = p.replace(/[^a-z]/g, "");
  const local = email.toLowerCase().split("@")[0];
  if (/^(.)\1+$/.test(p) || "01234567890123456789".includes(p) || "abcdefghijklmnopqrstuvwxyz".includes(p)) return "is a simple run of characters";
  if (COMMON.includes(p) || p.includes("password") || p.includes("passw0rd")) return "is one of the most commonly used passwords";
  if (["bladesbutchers", "bladesandbutchers", "bladeos", "butcher", "butchers"].includes(letters)) return "is just the business name";
  if (local && local.length >= 4 && (p === local || p.includes(local) && letters.length - local.replace(/[^a-z]/g, "").length < 3)) return "is too close to the email address";
  return null;
}

// POS
export const DISCOUNT_REASONS = ["Loyal customer", "Bulk purchase", "Short-dated stock", "Price match", "Staff purchase", "Service recovery"];
export const QUICK_CASH = [500, 1000, 2000, 5000, 10000, 20000];   // naira notes for fast cash tender
/** A manager PIN can't be all one digit or a straight run. */
export const weakPin = (p) => /^(\d)\1+$/.test(p) || "0123456789".includes(p) || "9876543210".includes(p);

/** Two-step sign-in is mandatory for these roles. */
export const MFA_REQUIRED_ROLES = LEADERSHIP_ROLES;
export const EXPIRY_WARN_DAYS = 2;

/** Weighed goods may arrive up to this much over the ordered quantity (KG lines only). */
export const PO_OVER_RECEIPT_PCT = 5;
/** Supplier invoice vs goods received: differences within this are treated as matched. */
export const PO_MATCH_TOLERANCE_PCT = 0.5;
export const PO_STATUSES = ["Pending Approval", "Approved", "Partly Received", "Received", "Closed", "Rejected", "Cancelled"];
export const RECON_METHODS = ["Transfer", "POS Card"];
