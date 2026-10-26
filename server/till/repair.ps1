# BladeOS receipt-printer repair - run once by the till setup, as administrator (Windows asks).
# Fixes the usual reason receipts sit in the Windows queue and never print:
#   - the printer is set to a USB port that isn't the one it's plugged into (USB001 vs USB002, after a replug),
#   - the printer is marked "Use printer offline", or bidirectional support confuses a cheap driver,
#   - one stuck job blocks every receipt behind it.
# It also creates the printer if Windows never did, and lets the BladeOS page reach the till's printer helper.
# Writes what it did to -Out as JSON. With -Plan only, it prints the plan and changes nothing.
param([string]$Base, [string]$Out, [switch]$Plan)
$ErrorActionPreference = 'Continue'
$Pattern = 'LP100|LP-100|Licon|POS[- ]?80|POS[- ]?58|POS[- ]?Printer|Receipt|Thermal|80 ?mm|58 ?mm|XP-|Xprinter|TM-T|Generic / Text Only'
$Office = 'PDF|XPS|OneNote|Fax|Send To|Microsoft Print|AnyDesk|Adobe'

# USB printer ports Windows knows, and whether something is plugged into each right now.
# (usbmon keeps one entry per port under the USB-print device interface class; "Control\Linked" = 1 while connected.)
function Get-UsbPrinterPorts {
  $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\{28d78fad-5a12-11d1-ae5b-0000f803a951}'
  if (-not (Test-Path $root)) { return @() }
  foreach ($k in Get-ChildItem -Path $root -ErrorAction SilentlyContinue) {
    $inst = Join-Path $k.PSPath '#'
    $dp = Get-ItemProperty -Path (Join-Path $inst 'Device Parameters') -ErrorAction SilentlyContinue
    if (-not $dp -or $null -eq $dp.'Port Number') { continue }
    $linked = (Get-ItemProperty -Path (Join-Path $inst 'Control') -ErrorAction SilentlyContinue).Linked
    $baseName = if ($dp.'Base Name') { $dp.'Base Name' } else { 'USB' }
    [pscustomobject]@{ Port = ('{0}{1:000}' -f $baseName, [int]$dp.'Port Number'); Live = ($linked -eq 1); Description = [string]$dp.'Port Description' }
  }
}

# Decides what to do. Pure: takes what Windows has, returns the plan (tested on its own).
function Get-ReceiptPlan($Ports, $Printers, $Drivers) {
  $live = @($Ports | Where-Object { $_.Live })
  $isPos = { param($p) ($p.Name -match $Pattern -or $p.DriverName -match $Pattern) -and $p.Name -notmatch $Office }
  $livePortNames = @($live | ForEach-Object { $_.Port })
  $used = @($Printers | ForEach-Object { $_.PortName })
  $free = @($live | Where-Object { $used -notcontains $_.Port })
  $freePos = @($free | Where-Object { $_.Description -match $Pattern })
  $target = if ($freePos.Count) { $freePos[0] } elseif ($free.Count) { $free[0] } else { $null }

  # 1. A receipt printer already on a port that's plugged in.
  $ok = @($Printers | Where-Object { (& $isPos $_) -and ($livePortNames -contains $_.PortName) })
  if ($ok.Count) { return [pscustomobject]@{ Action = 'ok'; Printer = $ok[0].Name; Port = $ok[0].PortName } }
  # 2. A receipt printer on a port nothing is plugged into: move it to the port the printer is on now.
  $pos = @($Printers | Where-Object { & $isPos $_ })
  if ($pos.Count -and $target) { return [pscustomobject]@{ Action = 'repoint'; Printer = $pos[0].Name; From = $pos[0].PortName; Port = $target.Port } }
  # 3. Plugged in, but Windows has no printer for it: create one.
  if ($target) {
    $drv = @($Drivers | Where-Object { $_.Name -match $Pattern -and $_.Name -ne 'Generic / Text Only' } | Select-Object -First 1).Name
    if (-not $drv) { $drv = 'Generic / Text Only' }
    return [pscustomobject]@{ Action = 'create'; Printer = 'BladeOS Receipt Printer'; Driver = $drv; Port = $target.Port }
  }
  # 4. Some other printer is on the plugged-in USB port (named oddly): that's the one.
  $other = @($Printers | Where-Object { ($livePortNames -contains $_.PortName) -and $_.Name -notmatch $Office })
  if ($other.Count) { return [pscustomobject]@{ Action = 'ok'; Printer = $other[0].Name; Port = $other[0].PortName } }
  # 5. Nothing plugged in that Windows can see.
  if ($pos.Count) { return [pscustomobject]@{ Action = 'unplugged'; Printer = $pos[0].Name; Port = $pos[0].PortName } }
  return [pscustomobject]@{ Action = 'none' }
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by the tests: functions only

$ports = @(Get-UsbPrinterPorts)
$printers = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, DriverName, PortName)
$drivers = @(Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object Name)
$plan = Get-ReceiptPlan $ports $printers $drivers
if ($Plan) { $plan | ConvertTo-Json -Compress; return }

$result = [ordered]@{ action = $plan.Action; printer = $plan.Printer; port = $plan.Port; from = $plan.From; notes = @() }
try {
  if ($plan.Action -eq 'repoint') {
    Set-Printer -Name $plan.Printer -PortName $plan.Port -ErrorAction Stop
    $result.notes += "Moved $($plan.Printer) from $($plan.From) to $($plan.Port)"
  } elseif ($plan.Action -eq 'create') {
    if (-not (Get-PrinterDriver -Name $plan.Driver -ErrorAction SilentlyContinue)) { Add-PrinterDriver -Name $plan.Driver -ErrorAction SilentlyContinue }
    Add-Printer -Name $plan.Printer -DriverName $plan.Driver -PortName $plan.Port -ErrorAction Stop
    $result.notes += "Created $($plan.Printer) on $($plan.Port) ($($plan.Driver))"
  }
} catch { $result.notes += "Couldn't change the printer: $($_.Exception.Message)" }

if ($plan.Printer) {
  # Clear the queue (a stuck job blocks every receipt behind it) and restart the print spooler.
  Get-PrintJob -PrinterName $plan.Printer -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
  Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
  Remove-Item -Path (Join-Path $env:SystemRoot 'System32\spool\PRINTERS\*') -Force -ErrorAction SilentlyContinue
  Start-Service -Name Spooler -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  # Online, and no bidirectional chatter (cheap thermal drivers hang on it).
  $p = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $plan.Printer } | Select-Object -First 1
  if ($p) { Set-CimInstance -InputObject $p -Property @{ WorkOffline = $false; EnableBIDI = $false } -ErrorAction SilentlyContinue }
  $result.notes += 'Cleared stuck jobs, restarted the print spooler, set the printer online'
}

# Let the BladeOS page talk to the printer helper on this computer (Chrome / Edge local-network permission).
if ($Base) {
  foreach ($b in @('HKLM:\SOFTWARE\Policies\Google\Chrome', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge')) {
    foreach ($pol in @('LocalNetworkAccessAllowedForUrls', 'InsecurePrivateNetworkRequestsAllowedForUrls')) {
      $k = Join-Path $b $pol
      New-Item -Path $k -Force -ErrorAction SilentlyContinue | Out-Null
      New-ItemProperty -Path $k -Name '1' -Value $Base -PropertyType String -Force -ErrorAction SilentlyContinue | Out-Null
    }
  }
}

if ($Out) { $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $Out -Encoding ASCII }
