# BladeOS POS launcher (the desktop icon): starts the printer helper if it isn't running, then the POS full screen
# with silent printing, and the customer screen on the second monitor when there is one.
$cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'till.json') -Raw | ConvertFrom-Json
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$q = [char]34

$up = $false
try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 17777); $up = $c.Connected; $c.Close() } catch { }
if (-not $up) {
  Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + $q + (Join-Path $PSScriptRoot 'helper.ps1') + $q)
}

$common = @('--user-data-dir=' + $q + (Join-Path $PSScriptRoot 'profile') + $q, '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests')
Start-Process -FilePath $cfg.browser -ArgumentList ($common + @('--kiosk-printing', '--start-fullscreen', ('--app=' + $cfg.base + '/#pos')))
Add-Type -AssemblyName System.Windows.Forms
$second = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if ($second) {
  Start-Sleep -Seconds 5
  Start-Process -FilePath $cfg.browser -ArgumentList ($common + @(('--app=' + $cfg.base + '/#customer-display'), ('--window-position=' + $second.Bounds.X + ',' + $second.Bounds.Y), '--start-fullscreen'))
}
