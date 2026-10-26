# Installer smoke for the Windows desktop app, on a clean runner account:
# install per user silently, launch the app and wait for its own daemon, run the `ace` command
# from a fresh PATH, update in place while the app and daemon run, uninstall, and confirm the
# data home is kept and nothing ace added stays behind.
# Usage: installer-smoke.ps1 -First <setup.exe> -Second <newer setup.exe> -SecondVersion <v>
param(
  [Parameter(Mandatory)] [string] $First,
  [Parameter(Mandatory)] [string] $Second,
  [Parameter(Mandatory)] [string] $SecondVersion
)
$ErrorActionPreference = "Stop"
# ACE_HOME, as the app and installer resolve it, lets a shared test machine use a scratch home.
$homeDir = if ($env:ACE_HOME) { $env:ACE_HOME } else { Join-Path $env:USERPROFILE ".ace" }
$binDir = Join-Path $homeDir "bin"
$shim = Join-Path $binDir "ace.cmd"
$uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

function Step($text) { Write-Host "::group::$text"; Write-Host $text }
function Done { Write-Host "::endgroup::" }
function Fail($text) { throw "installer smoke: $text" }

function InstallEntry {
  Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like "ace*" } |
    Select-Object -First 1
}

function UserPath { [string](Get-Item "HKCU:\Environment").GetValue("Path", "", "DoNotExpandEnvironmentNames") }

function OnUserPath {
  $wanted = $binDir.TrimEnd("\").ToLowerInvariant()
  foreach ($entry in (UserPath).Split(";")) {
    if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd("\").ToLowerInvariant() -eq $wanted) { return $true }
  }
  return $false
}

function RunSetup($exe, $arguments) {
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -Wait
  if ($process.ExitCode -ne 0) { Fail "$exe $arguments exited with $($process.ExitCode)" }
}

function ProcessesIn($dir) {
  $prefix = $dir.TrimEnd("\") + "\"
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

# A fresh shell's view: machine PATH then the user PATH, as Explorer gives new terminals.
function FreshPathAce {
  $path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $found = $path.Split(";") | Where-Object { $_ } | ForEach-Object { Join-Path ([Environment]::ExpandEnvironmentVariables($_)) "ace.cmd" } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $found) { Fail "a fresh PATH finds no ace.cmd" }
  return $found
}

function WaitForDaemon($installDir) {
  $deadline = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $deadline) {
    $lock = Join-Path $homeDir "daemon-lock"
    if ((Test-Path (Join-Path $homeDir "daemon-endpoint")) -and (Test-Path $lock)) {
      $output = & $shim status --json 2>$null
      if ($LASTEXITCODE -eq 0) {
        $daemonPid = (Get-Content $lock -Raw | ConvertFrom-Json).pid
        $daemon = Get-CimInstance Win32_Process -Filter "ProcessId=$daemonPid"
        if (-not $daemon) { Fail "daemon pid $daemonPid from the lock is not running" }
        if (-not $daemon.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)) {
          Fail "the daemon runs $($daemon.ExecutablePath), not the app's bundled runtime"
        }
        Write-Host "daemon ready (pid $daemonPid, $($daemon.ExecutablePath)): $output"
        return $daemonPid
      }
    }
    Start-Sleep -Seconds 2
  }
  Get-ChildItem (Join-Path $env:APPDATA "ace\logs") -Recurse -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- $($_.FullName)"; Get-Content $_.FullName -Tail 80 }
  Fail "the app's daemon did not become ready"
}

function LaunchApp($installDir) {
  $app = Start-Process -FilePath (Join-Path $installDir "ace.exe") -PassThru
  Write-Host "launched ace.exe pid $($app.Id)"
  return WaitForDaemon $installDir
}

if (Test-Path $homeDir) { Fail "the runner already has $homeDir; the smoke needs a clean account" }

Step "Install $First per user, silently"
RunSetup $First "/S"
$entry = InstallEntry
if (-not $entry) { Fail "no per-user uninstall entry" }
# electron-builder's entry names the uninstaller, not always an InstallLocation.
$installDir = if ($entry.InstallLocation) { $entry.InstallLocation } else {
  Split-Path -Parent (($entry.UninstallString -replace '^"([^"]+)".*$', '$1') -replace '\s+/.*$', '')
}
$installDir = $installDir.TrimEnd("\")
Write-Host "installed $($entry.DisplayVersion) at $installDir"
$entry | Format-List DisplayName, DisplayVersion, InstallLocation, UninstallString | Out-String | Write-Host
Get-ChildItem $installDir -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Host "  $($_.Name)" }
if (-not $installDir.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) { Fail "not a per-user install: $installDir" }
foreach ($file in @(
    "ace.exe", "resources\runtime\node.exe", "resources\daemon\ace.mjs", "resources\daemon\descriptor.node",
    "resources\daemon\node_modules\koffi\package.json", "resources\daemon\node_modules\node-pty\package.json",
    "resources\bin\rg.exe", "resources\helpers\ace-screen-helper-windows.exe", "resources\setup\ace-setup.mjs")) {
  if (-not (Test-Path (Join-Path $installDir $file))) { Fail "missing $file" }
}
if (-not (Test-Path $shim)) { Fail "the installer wrote no $shim" }
if (-not (OnUserPath)) { Fail "$binDir is not on the user PATH: $(UserPath)" }
Done

Step "The ace command runs from a fresh PATH"
$ace = FreshPathAce
$help = & $ace --help 2>&1
$code = $LASTEXITCODE
$help | Select-Object -First 3 | ForEach-Object { Write-Host $_ }
if ($code -ne 0) { Fail "ace --help exited with $code" }
Done

Step "The app starts its own daemon"
$firstDaemon = LaunchApp $installDir
Set-Content -Path (Join-Path $homeDir "smoke-marker.txt") -Value "kept"
# A login item as the app's Settings writes it, so uninstall must remove it.
New-ItemProperty -Path $runKey -Name "dev.ace.app" -Value "`"$installDir\ace.exe`" --background" -Force | Out-Null
Done

Step "Update in place to $SecondVersion while the app and daemon run"
RunSetup $Second "/S --updated"
$entry = InstallEntry
if ($entry.DisplayVersion -ne $SecondVersion) { Fail "installed version is $($entry.DisplayVersion), want $SecondVersion" }
if (Get-Process -Id $firstDaemon -ErrorAction SilentlyContinue) { Fail "the old daemon still runs after the update" }
$secondDaemon = LaunchApp $installDir
Write-Host "daemon after update: pid $secondDaemon"
Done

Step "Uninstall silently"
Get-Process ace -ErrorAction SilentlyContinue | Stop-Process -Force
RunSetup (Join-Path $installDir "Uninstall ace.exe") "/S"
$deadline = (Get-Date).AddMinutes(3)
while ((Test-Path (Join-Path $installDir "ace.exe")) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (Test-Path (Join-Path $installDir "ace.exe")) { Fail "the app is still installed" }
if (InstallEntry) { Fail "the uninstall entry is still there" }
if ((ProcessesIn $installDir).Count) { Fail "processes still run from $installDir" }
if (Test-Path $shim) { Fail "$shim is still there" }
if (OnUserPath) { Fail "$binDir is still on the user PATH" }
$left = (Get-Item $runKey).GetValueNames() | Where-Object { ([string](Get-Item $runKey).GetValue($_)).Contains($installDir) }
if ($left) { Fail "login items left: $left" }
if ((Get-Content (Join-Path $homeDir "smoke-marker.txt") -Raw).Trim() -ne "kept") { Fail "the data home was not kept" }
if (-not (Test-Path (Join-Path $homeDir "daemon-token"))) { Fail "the daemon's data was removed" }
Done
Write-Host "installer smoke passed"
