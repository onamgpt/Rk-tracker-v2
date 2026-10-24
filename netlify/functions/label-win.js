// Windows label helper (PowerShell agent + one-click .bat installer) for the PC the Zebra is plugged into.
// Polls label-queue every 15 s and sends raw ZPL to the Zebra through the Windows spooler (no driver dialogs).
function ps1(key) {
  return String.raw`$ErrorActionPreference = 'SilentlyContinue'
$m = New-Object System.Threading.Mutex($false, 'Global\OnamLabelAgent')
if (-not $m.WaitOne(0)) { exit }
$URL = 'https://rk-tracker-v2.netlify.app/.netlify/functions/label-queue'
$KEY = '` + key + String.raw`'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class OnamRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DI { [MarshalAs(UnmanagedType.LPWStr)] public string n; [MarshalAs(UnmanagedType.LPWStr)] public string o; [MarshalAs(UnmanagedType.LPWStr)] public string t; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int StartDocPrinter(IntPtr h, int l, [In] DI d);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static string Send(string p, byte[] b) {
    IntPtr h; if (!OpenPrinter(p, out h, IntPtr.Zero)) return "cannot open printer " + Marshal.GetLastWin32Error();
    DI d = new DI(); d.n = "Onam labels"; d.t = "RAW";
    if (StartDocPrinter(h, 1, d) == 0) { ClosePrinter(h); return "cannot start job " + Marshal.GetLastWin32Error(); }
    StartPagePrinter(h); int w; bool ok = WritePrinter(h, b, b.Length, out w); EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    return ok ? "" : "write failed " + Marshal.GetLastWin32Error();
  }
}
"@
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Post($b) { try { Invoke-RestMethod -Uri $URL -Method Post -ContentType 'application/json' -Headers @{ 'x-label-key' = $KEY } -Body ($b | ConvertTo-Json -Compress -Depth 5) -TimeoutSec 25 } catch { $null } }
while ($true) {
  $p = Get-Printer | Where-Object { $_.Name -match 'zebra|zdesigner|zd2' } | Select-Object -First 1
  $name = ''; $state = ''
  if ($p) { $name = $p.Name; $state = 'printer ' + $p.Name + ' ' + $p.PrinterStatus }
  $r = Post @{ action = 'pending'; printer = $name; state = $state; host = $env:COMPUTERNAME; version = 'win-1.0' }
  if ($r -and $r.jobs -and $name) {
    foreach ($j in $r.jobs) {
      $err = [OnamRaw]::Send($name, [Text.Encoding]::UTF8.GetBytes([string]$j.zpl))
      Post @{ action = 'ack'; id = $j.id; ok = ($err -eq ''); err = $err } | Out-Null
    }
  }
  Start-Sleep -Seconds 15
}
`;
}
function bat(key) {
  const b64 = Buffer.from(ps1(key), "utf8").toString("base64");
  const L = [
    "@echo off",
    "title Onam label printer helper",
    "echo.",
    "echo  Installing the Onam label printer helper...",
    'set "D=%USERPROFILE%\\onam-labels"',
    'if not exist "%D%" mkdir "%D%"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllBytes($env:USERPROFILE + \'\\onam-labels\\labels.ps1\', [Convert]::FromBase64String(\'' + b64 + '\'))"',
    'set "S=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OnamLabels.vbs"',
    '> "%S%" echo CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%D%\\labels.ps1""", 0, False',
    'start "" wscript "%S%"',
    "echo.",
    "echo  DONE. The helper is running and starts by itself whenever this PC is switched on.",
    "echo  Labels waiting in the tracker will print on the Zebra within a minute.",
    "echo.",
    "pause"
  ];
  return L.join("\r\n") + "\r\n";
}
module.exports = { ps1, bat };
