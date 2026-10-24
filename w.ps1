# Onam Tracker — Zebra label printer agent for a Windows PC.
# Run once in PowerShell:   $env:OK='<key>'; irm rk-tracker-v2.netlify.app/w.ps1 | iex
# Installs a small hidden program that every 15 s asks the tracker for labels and sends them to the Zebra (raw ZPL).
# It starts by itself whenever this user logs in. Safe to run again.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host ""
Write-Host "== Onam label printer setup ==" -ForegroundColor Cyan
if (-not $env:OK) { Write-Host "Key missing - copy the full command from the guide (it starts with `$env:OK=)." -ForegroundColor Red; return }
$dir = Join-Path $env:USERPROFILE 'OnamLabels'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -Path (Join-Path $dir 'key.txt') -Value $env:OK.Trim() -NoNewline

$zebra = Get-Printer | Where-Object { $_.Name -match 'zebra|zdesigner|zd2' } | Select-Object -First 1
if (-not $zebra) {
  Write-Host ""
  Write-Host "No Zebra printer found yet." -ForegroundColor Yellow
  Write-Host "Plug in the Zebra, wait 1 minute for Windows to install it (or install the ZDesigner driver from the guide), then run the same command again."
  return
}
Write-Host ("Zebra printer found: " + $zebra.Name) -ForegroundColor Green

$agent = @'
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Join-Path $env:USERPROFILE 'OnamLabels'
$key = (Get-Content (Join-Path $dir 'key.txt') -Raw).Trim()
$url = 'https://rk-tracker-v2.netlify.app/.netlify/functions/label-queue'
$log = Join-Path $dir 'labels.log'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class OnamRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int StartDocPrinter(IntPtr h, int l, DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static string Send(string printer, byte[] data, string name) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "open failed " + Marshal.GetLastWin32Error();
    try {
      var di = new DOCINFO(); di.pDocName = name; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "startdoc failed " + Marshal.GetLastWin32Error();
      StartPagePrinter(h); int w; bool ok = WritePrinter(h, data, data.Length, out w); EndPagePrinter(h); EndDocPrinter(h);
      return ok && w == data.Length ? "" : "write failed " + Marshal.GetLastWin32Error();
    } finally { ClosePrinter(h); }
  }
}
"@
function Post($body) {
  try { return Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers @{ 'x-label-key' = $key } -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 25 }
  catch { return $null }
}
while ($true) {
  try {
    $p = Get-Printer | Where-Object { $_.Name -match 'zebra|zdesigner|zd2' } | Select-Object -First 1
    $name = ''; $state = ''
    if ($p) { $name = $p.Name; $state = "printer $($p.Name) status $($p.PrinterStatus)"; if ($p.WorkOffline) { $state += ' offline' } }
    $r = Post @{ action = 'pending'; printer = $name; state = $state; host = $env:COMPUTERNAME; version = 'win-1.0' }
    if ($r -and $r.jobs -and $name) {
      foreach ($j in $r.jobs) {
        $err = [OnamRaw]::Send($name, [Text.Encoding]::UTF8.GetBytes([string]$j.zpl), ('Onam ' + $j.title))
        Post @{ action = 'ack'; id = $j.id; ok = ($err -eq ''); err = $err } | Out-Null
        Add-Content $log ((Get-Date -Format 'dd-MM HH:mm') + ' ' + ($(if ($err -eq '') {'printed'} else {'FAILED ' + $err})) + ' ' + $j.n + ' ' + $j.title)
      }
    }
  } catch { Add-Content $log ((Get-Date -Format 'dd-MM HH:mm') + ' error ' + $_.Exception.Message) }
  Start-Sleep -Seconds 15
}
'@
$agentPath = Join-Path $dir 'onam-label-agent.ps1'
Set-Content -Path $agentPath -Value $agent -Encoding UTF8

# start with Windows (this user), hidden
$startup = [Environment]::GetFolderPath('Startup')
$cmd = "@echo off`r`nstart `"`" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agentPath`"`r`n"
Set-Content -Path (Join-Path $startup 'OnamLabels.cmd') -Value $cmd -Encoding ASCII

# stop an older copy, start now
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'onam-label-agent' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',"`"$agentPath`"")

# test label
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class OnamRawT {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DI { public string a; public string b; public string c; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv")] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] static extern int StartDocPrinter(IntPtr h, int l, DI di);
  [DllImport("winspool.drv")] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv")] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static bool Send(string p, byte[] d) { IntPtr h; if (!OpenPrinter(p, out h, IntPtr.Zero)) return false; var di = new DI(); di.a = "Onam test"; di.c = "RAW"; StartDocPrinter(h, 1, di); int w; bool ok = WritePrinter(h, d, d.Length, out w); EndDocPrinter(h); ClosePrinter(h); return ok; }
}
"@
$test = '^XA^CI28^PW799^LL400^FO10,10^GB779,380,4^FS^FO40,60^A0N,44,44^FDONAM LABEL PRINTER^FS^FO40,140^A0N,34,34^FDSetup OK - auto-print is ON^FS^FO560,170^BQN,2,6^FDMA,ONAM-TEST^FS^XZ'
if ([OnamRawT]::Send($zebra.Name, [Text.Encoding]::UTF8.GetBytes($test))) { Write-Host "Test label sent to the Zebra." -ForegroundColor Green }
Write-Host ""
Write-Host "DONE. Labels now print by themselves whenever this PC is on and Prakash is logged in. You can close this window." -ForegroundColor Green
