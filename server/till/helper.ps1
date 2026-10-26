# BladeOS printer helper - runs hidden on a Windows till, started by the BladeOS POS icon and at sign-in.
# Listens on 127.0.0.1:17777 only (never the network). BladeOS in the browser sends a receipt as ESC/POS
# bytes; the helper hands them RAW to the Windows printer queue, so it prints, cuts and opens the drawer
# whatever driver Windows uses, with no print dialog. Only the BladeOS address may use it.
#   GET  /status  -> {"ok":true,"printer":"POS-80C","port":"USB001","jobs":0,"offline":false,"version":1}
#   POST /print   (body: ESC/POS bytes) -> {"ok":true}
#   POST /clear   -> removes receipts stuck in this printer's queue
param([string]$Config = (Join-Path $PSScriptRoot 'till.json'))
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$test = [bool]$env:BLADEOS_PRINT_TO_FILE

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BladeRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);

  // Returns null when the job is with Windows, or why it failed.
  public static string Send(string printer, byte[] data) {
    string file = Environment.GetEnvironmentVariable("BLADEOS_PRINT_TO_FILE");
    if (!String.IsNullOrEmpty(file)) { using (var f = new FileStream(file, FileMode.Append)) f.Write(data, 0, data.Length); return null; }
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "Windows can't find the printer '" + printer + "' (error " + Marshal.GetLastWin32Error() + "). Run the BladeOS till setup again.";
    try {
      var di = new DOCINFO(); di.pDocName = "BladeOS receipt"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "The printer refused the receipt (error " + Marshal.GetLastWin32Error() + ").";
      try {
        StartPagePrinter(h);
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "Sending to the printer failed (error " + Marshal.GetLastWin32Error() + ").";
      } finally { EndDocPrinter(h); }
      return null;
    } finally { ClosePrinter(h); }
  }
}

public class BladeServer {
  public string Origin;                 // e.g. https://bladesbutchers-pos.up.railway.app
  public Func<string> Status;           // JSON
  public Func<string> Clear;            // JSON
  public Func<string> PrinterName;
  TcpListener listener;

  public bool Start(int port) {
    try { listener = new TcpListener(IPAddress.Loopback, port); listener.Start(); return true; }
    catch (SocketException) { return false; }   // already running
  }
  // One thread (the PowerShell callbacks must run on it), but never stuck on a connection that sends nothing:
  // browsers open spare connections ahead of time. Only connections with a request waiting are served.
  public void Run() {
    var pending = new List<TcpClient>();
    var since = new Dictionary<TcpClient, DateTime>();
    while (true) {
      try {
        while (listener.Pending()) { var n = listener.AcceptTcpClient(); pending.Add(n); since[n] = DateTime.UtcNow; }
        for (int i = pending.Count - 1; i >= 0; i--) {
          var c = pending[i];
          bool ready = false;
          try { ready = c.Available > 0; } catch (Exception) { }
          bool stale = (DateTime.UtcNow - since[c]).TotalSeconds > 10;
          if (!ready && !stale) continue;
          pending.RemoveAt(i); since.Remove(c);
          try { if (ready) Handle(c); } catch (Exception) { } finally { c.Close(); }
        }
      } catch (Exception) { }
      Thread.Sleep(pending.Count > 0 ? 5 : 15);
    }
  }

  static string ReadHead(NetworkStream s) {
    var buf = new List<byte>();
    int b;
    while ((b = s.ReadByte()) != -1) {
      buf.Add((byte)b);
      int n = buf.Count;
      if (n >= 4 && buf[n - 4] == 13 && buf[n - 3] == 10 && buf[n - 2] == 13 && buf[n - 1] == 10) break;
      if (n > 16384) return null;
    }
    return Encoding.ASCII.GetString(buf.ToArray());
  }

  void Reply(NetworkStream s, int code, string json, string origin) {
    string reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : "Error";
    var body = Encoding.UTF8.GetBytes(json ?? "");
    var h = new StringBuilder();
    h.Append("HTTP/1.1 ").Append(code).Append(' ').Append(reason).Append("\r\n");
    h.Append("Content-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n");
    if (origin != null) {
      h.Append("Access-Control-Allow-Origin: ").Append(origin).Append("\r\nVary: Origin\r\n");
      h.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n");
      h.Append("Access-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n");
    }
    h.Append("Content-Length: ").Append(body.Length).Append("\r\n\r\n");
    var head = Encoding.ASCII.GetBytes(h.ToString());
    s.Write(head, 0, head.Length);
    s.Write(body, 0, body.Length);
  }

  static string Esc(string v) { return (v ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

  void Handle(TcpClient c) {
    c.ReceiveTimeout = 5000; c.SendTimeout = 5000;
    var s = c.GetStream();
    string head = ReadHead(s);
    if (head == null) return;
    var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
    var first = lines[0].Split(' ');
    if (first.Length < 2) return;
    string method = first[0].ToUpperInvariant(), path = first[1].Split('?')[0];
    var hdr = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (int i = 1; i < lines.Length; i++) { int k = lines[i].IndexOf(':'); if (k > 0) hdr[lines[i].Substring(0, k).Trim()] = lines[i].Substring(k + 1).Trim(); }
    string origin; hdr.TryGetValue("Origin", out origin);
    bool allowed = origin != null && String.Equals(origin.TrimEnd('/'), Origin.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
    string echo = allowed ? origin : null;

    if (method == "OPTIONS") { Reply(s, allowed ? 204 : 403, "", echo); return; }
    // Another website may not use the till's printer. Status without an Origin is for checks on the till itself.
    if (origin != null && !allowed) { Reply(s, 403, "{\"ok\":false,\"error\":\"Not allowed from this website.\"}", null); return; }

    if (method == "GET" && path == "/status") { Reply(s, 200, Status(), echo); return; }
    if (method == "POST" && (path == "/print" || path == "/clear")) {
      if (!allowed) { Reply(s, 403, "{\"ok\":false,\"error\":\"Not allowed.\"}", null); return; }
      int len = 0; string cl; if (hdr.TryGetValue("Content-Length", out cl)) Int32.TryParse(cl, out len);
      if (len < 0 || len > 1048576) { Reply(s, 400, "{\"ok\":false,\"error\":\"Too large.\"}", echo); return; }
      var body = new byte[len]; int got = 0;
      while (got < len) { int r = s.Read(body, got, len - got); if (r <= 0) break; got += r; }
      if (path == "/clear") { Reply(s, 200, Clear(), echo); return; }
      if (got != len || len == 0) { Reply(s, 400, "{\"ok\":false,\"error\":\"Empty receipt.\"}", echo); return; }
      string err = BladeRaw.Send(PrinterName(), body);
      Reply(s, err == null ? 200 : 500, err == null ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"" + Esc(err) + "\"}", echo);
      return;
    }
    Reply(s, 404, "{\"ok\":false}", echo);
  }
}
"@

function Get-ReceiptPrinterName {
  if ($test) { return 'TEST-PRINTER' }
  if ($cfg.printer) { return [string]$cfg.printer }
  (Get-CimInstance Win32_Printer -Filter 'Default=TRUE' -ErrorAction SilentlyContinue | Select-Object -First 1).Name
}
function Get-QueueJobs([string]$name) {
  if ($test) { return @() }
  @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($name + ',*') })
}

$srv = New-Object BladeServer
$srv.Origin = [string]$cfg.base
$srv.PrinterName = [Func[string]]{ Get-ReceiptPrinterName }
$srv.Status = [Func[string]]{
  try {
    $n = Get-ReceiptPrinterName
    if ($test) { return (@{ ok = $true; printer = $n; port = 'USB001'; jobs = [int]$env:BLADEOS_TEST_JOBS; offline = $false; version = 1 } | ConvertTo-Json -Compress) }
    $p = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $n } | Select-Object -First 1
    $jobs = @(Get-QueueJobs $n | Where-Object { ((Get-Date) - $_.TimeSubmitted).TotalSeconds -gt 15 }).Count
    @{ ok = [bool]$p; printer = $n; port = [string]$p.PortName; jobs = $jobs; offline = [bool]$p.WorkOffline; version = 1 } | ConvertTo-Json -Compress
  } catch { '{"ok":false,"error":"status"}' }
}
$srv.Clear = [Func[string]]{
  try {
    if ($test) { return ('{"ok":true,"removed":' + [int]$env:BLADEOS_TEST_JOBS + '}') }
    $n = Get-ReceiptPrinterName
    $jobs = @(Get-QueueJobs $n)
    $jobs | Remove-CimInstance -ErrorAction SilentlyContinue
    @{ ok = $true; removed = $jobs.Count } | ConvertTo-Json -Compress
  } catch { '{"ok":false,"removed":0}' }
}

if (-not $srv.Start(17777)) { exit 0 }   # one helper per till
$srv.Run()
