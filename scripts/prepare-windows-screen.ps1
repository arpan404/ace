$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_OS -ne "Windows") {
  throw "Screen preparation is only for a disposable Windows Actions runner"
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AceRunnerForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@

$window = [AceRunnerForeground]::GetForegroundWindow()
[uint32]$foregroundProcessId = 0
[void][AceRunnerForeground]::GetWindowThreadProcessId($window, [ref]$foregroundProcessId)
if ($foregroundProcessId -eq 0) { return }
$foreground = [Diagnostics.Process]::GetProcessById($foregroundProcessId)
try {
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $systemHost = Join-Path $env:SystemRoot "System32\WWAHost.exe"
  if ($foreground.ProcessName -ne "WWAHost" -or
      $foreground.SessionId -ne $session -or
      $foreground.Path -ne $systemHost) { return }

  # The ARM64 runner image leaves this system app in foreground. Request normal
  # closure on the disposable runner; never change focus policy or inject input.
  Write-Host "Closing foreground system WWAHost on runner, pid=$foregroundProcessId session=$session"
  if (-not $foreground.CloseMainWindow()) {
    throw "The runner's foreground WWAHost did not accept normal window closure"
  }
  if (-not $foreground.WaitForExit(10000)) {
    throw "The runner's foreground WWAHost did not exit after normal window closure"
  }
} finally {
  $foreground.Dispose()
}
