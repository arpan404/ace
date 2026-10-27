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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)] public static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
}
'@

$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$systemHosts = @{
  WWAHost = (Join-Path $env:SystemRoot "System32\WWAHost.exe")
  SearchHost = (Join-Path $env:SystemRoot "SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\SearchHost.exe")
}

# The ARM64 runner image can leave these shell overlays in foreground. Request
# normal closure only; never change focus policy, kill processes or inject input.
for ($attempt = 0; $attempt -lt 4; $attempt++) {
  $window = [AceRunnerForeground]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  [void][AceRunnerForeground]::GetWindowThreadProcessId($window, [ref]$foregroundProcessId)
  if ($foregroundProcessId -eq 0) { return }
  $foreground = [Diagnostics.Process]::GetProcessById($foregroundProcessId)
  try {
    $name = $foreground.ProcessName
    if (-not $systemHosts.ContainsKey($name) -or
        $foreground.SessionId -ne $session -or
        $foreground.Path -ne $systemHosts[$name]) { return }

    Write-Host "Requesting WM_CLOSE for runner $name, pid=$foregroundProcessId session=$session hwnd=$window main=$($foreground.MainWindowHandle) visible=$([AceRunnerForeground]::IsWindowVisible($window)) enabled=$([AceRunnerForeground]::IsWindowEnabled($window))"
    [uint32]$currentOwner = 0
    [void][AceRunnerForeground]::GetWindowThreadProcessId($window, [ref]$currentOwner)
    if ($currentOwner -ne $foregroundProcessId) {
      throw "Foreground window ownership changed during runner preparation"
    }
    # CloseMainWindow may not discover a CoreWindow. Address the observed HWND;
    # WM_CLOSE still lets the app refuse, and UIPI remains enforced.
    if (-not [AceRunnerForeground]::PostMessage($window, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)) {
      throw "The runner's $name close request failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ([AceRunnerForeground]::GetForegroundWindow() -eq $window) {
      if ($deadline.ElapsedMilliseconds -ge 10000) {
        throw "The runner's $name retained foreground after WM_CLOSE"
      }
      Start-Sleep -Milliseconds 50
    }
  } finally {
    $foreground.Dispose()
  }
}
throw "Runner shell overlays did not clear within four close requests"
