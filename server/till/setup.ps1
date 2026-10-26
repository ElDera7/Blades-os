# BladeOS till setup (runs from BladeOS-Till-Setup.cmd). No admin rights needed, except the printer repair,
# which Windows asks permission for. Safe to run again at any time: it repairs and re-tests.
$ErrorActionPreference = 'Continue'
$base = $env:BLADEOS_BASE
$dir = Join-Path $env:LOCALAPPDATA 'BladeOS'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }
$q = [char]34
Write-Host ''
Write-Host '  BladeOS till setup' -ForegroundColor Yellow
Write-Host '  Desktop icon, receipt printer repair and test, barcode scanner check.'
Write-Host ''

# ---- browser
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
$browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $browser) {
  Write-Host '  Google Chrome or Microsoft Edge is needed. Install Google Chrome, then run this file again.' -ForegroundColor Red
  Read-Host '  Press Enter to close' | Out-Null
  exit 1
}
Write-Host "  [OK] Browser: $browser"

$ico = Join-Path $dir 'bladeos.ico'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri "$base/icons/bladeos.ico" -OutFile $ico
} catch { }
if (-not (Test-Path -LiteralPath $ico)) { $ico = "$browser,0" }

# ---- the till's own files
$helperCode = @'
__HELPER__
'@
$repairCode = @'
__REPAIR__
'@
$launcherCode = @'
__LAUNCHER__
'@
$helper = Join-Path $dir 'helper.ps1'; $repair = Join-Path $dir 'repair.ps1'; $launcher = Join-Path $dir 'BladeOS-POS.ps1'
Set-Content -LiteralPath $helper -Value $helperCode -Encoding ASCII
Set-Content -LiteralPath $repair -Value $repairCode -Encoding ASCII
Set-Content -LiteralPath $launcher -Value $launcherCode -Encoding ASCII
$tillJson = Join-Path $dir 'till.json'
function Save-Till([string]$printer) { @{ browser = $browser; base = $base; printer = $printer } | ConvertTo-Json | Set-Content -LiteralPath $tillJson -Encoding ASCII }
Save-Till ''

# ---- stop an old helper so the new one (and the repaired printer) take over
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*BladeOS*helper.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ---- receipt printer: repair (as administrator) and choose it
Write-Host '  ...  Checking the receipt printer. Windows asks for permission to repair it: click Yes.'
$outFile = Join-Path $dir 'repair.json'
Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
try {
  $p = Start-Process -FilePath $ps -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File ' + $q + $repair + $q + ' -Base ' + $q + $base + $q + ' -Out ' + $q + $outFile + $q)
  $p.WaitForExit()
} catch { Write-Host '  [!]  Printer repair skipped (permission not given). Run this file again and click Yes to repair it.' -ForegroundColor Yellow }
$fix = $null
if (Test-Path -LiteralPath $outFile) { $fix = Get-Content -LiteralPath $outFile -Raw | ConvertFrom-Json }
if (-not $fix) { $fix = & $ps -NoProfile -ExecutionPolicy Bypass -File $repair -Plan | ConvertFrom-Json }
foreach ($n in @($fix.notes)) { if ($n) { Write-Host "  [OK] $n" } }

$printer = [string]$fix.printer
if ($fix.action -eq 'unplugged') {
  Write-Host "  [!]  $printer is installed but Windows can't see it. Switch the printer on and check the USB cable (into the till itself, not a hub), then run this file again." -ForegroundColor Yellow
} elseif (-not $printer) {
  Write-Host '  [!]  No receipt printer found. Switch the LP100 on, plug its USB cable into the till, wait 30 seconds, then run this file again.' -ForegroundColor Yellow
}
if ($printer) {
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name LegacyDefaultPrinterMode -Value 1 -PropertyType DWord -Force | Out-Null
  $wp = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $printer } | Select-Object -First 1
  if ($wp) { Invoke-CimMethod -InputObject $wp -MethodName SetDefaultPrinter | Out-Null }
  Write-Host "  [OK] Receipt printer: $printer ($($fix.port)) - default printer"
  Save-Till $printer
}

# ---- printer helper: start it, and at every sign-in
$helperArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + $q + $helper + $q
Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList $helperArgs
$ready = $false
for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
  Start-Sleep -Milliseconds 500
  try { $s = Invoke-RestMethod -Uri 'http://127.0.0.1:17777/status' -TimeoutSec 2; $ready = [bool]$s } catch { }
}
if ($ready) { Write-Host '  [OK] BladeOS printer helper running' } else { Write-Host '  [!]  The printer helper did not start. Restart the computer, then open BladeOS POS.' -ForegroundColor Yellow }

# ---- test receipt, and check it really left the Windows queue
if ($ready -and $printer) {
  $e = [byte]27; $g = [byte]29
  $text = [Text.Encoding]::ASCII.GetBytes("BladeOS printer test`n$printer`n" + (Get-Date -Format 'dd MMM yyyy HH:mm') + "`nIf you can read this, receipts will print.`n`n`n`n")
  $bytes = [byte[]](@($e, 64, $e, 97, 1, $e, 33, 16) + [Text.Encoding]::ASCII.GetBytes("Blades & Butchers`n") + @($e, 33, 0) + $text + @($g, 86, 66, 0))
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:17777/print' -Headers @{ Origin = $base } -ContentType 'application/octet-stream' -Body $bytes -TimeoutSec 10
    Start-Sleep -Seconds 8
    $stuck = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($printer + ',*') })
    if ($stuck.Count) {
      Write-Host '  [!]  The test receipt is stuck in the Windows queue. Check the printer is switched on, has paper and the lid is shut,' -ForegroundColor Yellow
      Write-Host '       and the USB cable goes into the till itself. Then run this file again.' -ForegroundColor Yellow
      $stuck | Remove-CimInstance -ErrorAction SilentlyContinue
    } else { Write-Host '  [OK] Test receipt sent - it should be printing now' -ForegroundColor Green }
  } catch { Write-Host "  [!]  Test receipt failed: $($_.Exception.Message)" -ForegroundColor Yellow }
}

# ---- barcode scanner
$scanner = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'barcode|scanner|honeywell|zebra|symbol|datalogic|newland|netum|licon' -and $_.Class -match 'Keyboard|HIDClass|Ports' } |
  Select-Object -First 1
if ($scanner) { Write-Host "  [OK] Barcode scanner: $($scanner.FriendlyName)" }
else { Write-Host '  [OK] Barcode scanner: nothing to install - it types like a keyboard. BladeOS spots it on the first scan.' }

# ---- icons
$ws = New-Object -ComObject WScript.Shell
function Add-Shortcut([string]$folder, [string]$name, [string]$file, [string]$why) {
  if (-not $folder) { return }
  $s = $ws.CreateShortcut((Join-Path $folder $name))
  $s.TargetPath = $ps
  $s.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + $q + $file + $q
  $s.WorkingDirectory = $dir
  $s.WindowStyle = 7
  $s.IconLocation = $ico
  $s.Description = $why
  $s.Save()
}
Add-Shortcut ([Environment]::GetFolderPath('Desktop')) 'BladeOS POS.lnk' $launcher 'BladeOS POS - Blades and Butchers'
Add-Shortcut ([Environment]::GetFolderPath('Programs')) 'BladeOS POS.lnk' $launcher 'BladeOS POS - Blades and Butchers'
Add-Shortcut ([Environment]::GetFolderPath('Startup')) 'BladeOS printer helper.lnk' $helper 'Prints BladeOS receipts'
Write-Host '  [OK] "BladeOS POS" icon added to the desktop and the Start menu'
$a = Read-Host '  Open BladeOS automatically when this computer starts? (Y/N)'
if ($a -match '^[Yy]') { Add-Shortcut ([Environment]::GetFolderPath('Startup')) 'BladeOS POS.lnk' $launcher 'BladeOS POS - Blades and Butchers'; Write-Host '  [OK] BladeOS will open at start-up' }

Write-Host ''
Write-Host '  Done. Opening BladeOS - sign in once. (Alt+F4 closes the till window.)' -ForegroundColor Green
Write-Host '  If Chrome asks to let BladeOS use devices on this computer, click Allow.'
Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + $q + $launcher + $q)
Start-Sleep -Seconds 6
