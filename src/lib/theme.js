export const C = {
  charcoal: "#1C1815",
  charcoal2: "#262019",
  charcoal3: "#332B24",
  cream: "#F7F3EC",
  cream2: "#EFE8DB",
  burgundy: "#7A2331",
  burgundyDark: "#591A24",
  burgundyLight: "#9C3A49",
  gold: "#8A6528",   // deepened from #B8863E so gold text and white-on-gold pass WCAG AA
  goldLight: "#D4A85F",
  ink: "#221C17",
  muted: "#6B6358",   // WCAG AA (4.5:1+) on cream, parchment and white
  mutedLight: "#B5AC9E",
  ok: "#3E6B4A",
  warn: "#8A6528",
  danger: "#A3372F",
  border: "#E7E0D3",
  line: "#EEE7D9",
  rowLine: "#F3EEE3",
  input: "#DED4C2",
};

export const nairaFmt = (n) => "₦" + Math.round(n || 0).toLocaleString("en-NG");
export const kgFmt = (n) => `${Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 })} KG`;
export const qtyFmt = (n, unit) => (unit === "KG" ? kgFmt(n) : `${Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 })} ${unit}`);
export const longToday = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
export const greeting = () => {
  const h = Number(new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};
export const initials = (name = "") => name.split(" ").filter(Boolean).slice(0, 2).map((n) => n[0]).join("").toUpperCase();
export const stockStatus = (item) => (item.qty < item.min ? "Critical" : item.qty < item.min * 1.4 ? "Low" : "Healthy");

export function exportCsv(filename, rows) {
  if (!rows || rows.length === 0) return false;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  return true;
}
