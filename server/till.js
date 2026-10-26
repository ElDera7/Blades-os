// The till's desktop icon: one Windows setup file, downloaded from the account menu ("Desktop icon").
// Everything it installs lives in server/till/*.ps1 (tested on their own):
//   setup.ps1     run by the .cmd: finds Chrome/Edge, repairs + tests the receipt printer, checks the scanner,
//                 installs the printer helper and the BladeOS POS icon. Safe to run again.
//   repair.ps1    as administrator: puts the receipt printer on the USB port it's really plugged into (or creates
//                 it), clears stuck jobs, restarts the spooler, sets it online; lets the page reach the helper.
//   helper.ps1    the BladeOS printer helper (127.0.0.1:17777, BladeOS address only): ESC/POS from the page
//                 goes RAW to the Windows queue — cut, QR code, drawer, no dialog, whatever the driver.
//   launcher.ps1  the icon: starts the helper if needed, the POS full screen with silent printing, and the
//                 customer screen on the second monitor.
// The .cmd carries setup.ps1 (with the others inside it) after a marker line, so it's a single download.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostedUrl } from "./email.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "till");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n").trimEnd();

/** setup.ps1 with the helper, repair and launcher scripts inside it (as literal here-strings). */
export function tillSetupScript() {
  const parts = { __HELPER__: read("helper.ps1"), __REPAIR__: read("repair.ps1"), __LAUNCHER__: read("launcher.ps1") };
  for (const [k, v] of Object.entries(parts)) {
    if (/^'@/m.test(v)) throw new Error(`${k}: a line starts with '@, which would end the here-string`);
  }
  let s = read("setup.ps1");
  for (const [k, v] of Object.entries(parts)) s = s.split(k).join(v);
  return s;
}

/** The public address tills open. Set PUBLIC_URL for a custom domain. */
export function publicBase(req) {
  return hostedUrl() || `${req.protocol}://${req.get("host")}`;
}

export function tillSetupCmd(base) {
  const safe = String(base).replace(/[^A-Za-z0-9:/._-]/g, "");     // nothing cmd could treat as a command
  const lines = [
    "@echo off",
    "setlocal",
    "title BladeOS till setup",
    `set "BLADEOS_BASE=${safe}"`,
    'set "BLADEOS_SELF=%~f0"',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = Get-Content -LiteralPath $env:BLADEOS_SELF -Raw; $m = '::' + ' POWERSHELL'; $i = $t.IndexOf($m); $j = $t.IndexOf([char]10, $i); Invoke-Expression $t.Substring($j + 1)"`,
    "exit /b",
    ":: POWERSHELL (everything below runs in PowerShell)",
    ...tillSetupScript().split("\n"),
  ];
  const out = lines.join("\r\n") + "\r\n";
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(out)) throw new Error("till setup must be plain ASCII");
  return out;
}

export function tillRoutes(app) {
  app.get("/downloads/BladeOS-Till-Setup.cmd", (req, res) => {
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="BladeOS-Till-Setup.cmd"',
      "Cache-Control": "no-store",
    }).send(tillSetupCmd(publicBase(req)));
  });
}
