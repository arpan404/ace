Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AceInputFixture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
$mainTitle = $env:ACE_OWNED_TITLE
if ([string]::IsNullOrEmpty($mainTitle)) { $mainTitle = $args[0] }
if ([string]::IsNullOrEmpty($mainTitle)) { exit 1 }
$decoyTitle = $env:ACE_OWNED_DECOY
if ([string]::IsNullOrEmpty($decoyTitle)) { $decoyTitle = "$mainTitle-decoy" }
$main = New-Object System.Windows.Forms.Form
$main.Text = $mainTitle
$main.Width = 480
$main.Height = 320
$box = New-Object System.Windows.Forms.TextBox
$box.AccessibleName = "OwnedEdit"
$box.Text = "ace-initial"
$box.Left = 20
$box.Top = 20
$box.Width = 400
$main.Controls.Add($box)
$button = New-Object System.Windows.Forms.Button
$button.AccessibleName = "OwnedButton"
$button.Text = "Increment"
$button.Left = 20
$button.Top = 60
$button.Width = 120
$main.Controls.Add($button)
$count = New-Object System.Windows.Forms.TextBox
$count.AccessibleName = "OwnedCount"
$count.ReadOnly = $true
$count.Text = "0"
$count.Left = 160
$count.Top = 65
$count.Width = 100
$main.Controls.Add($count)
$button.Add_Click({ $count.Text = ([int]$count.Text + 1).ToString() })
$decoy = New-Object System.Windows.Forms.Form
$decoy.Text = $decoyTitle
$decoy.Width = 300
$decoy.Height = 200
$decoyLabel = New-Object System.Windows.Forms.TextBox
$decoyLabel.AccessibleName = "OwnedDecoy"
$decoyLabel.Text = "decoy"
$decoyLabel.Left = 20
$decoyLabel.Top = 20
$decoyLabel.Width = 200
$decoy.Controls.Add($decoyLabel)
function Write-State($which) {
  $actual = [AceInputFixture]::GetForegroundWindow().ToInt64()
  $line = (@{ foreground = $actual; which = $which; mainText = $box.Text; decoyText = $decoyLabel.Text; count = $count.Text } | ConvertTo-Json -Compress)
  [Console]::WriteLine($line)
  [Console]::Out.Flush()
}
function Write-Foreground($handle, $which) {
  [void][AceInputFixture]::ShowWindow($handle, 9)
  [void][AceInputFixture]::SetForegroundWindow($handle)
  if ($which -eq "main") { $main.Activate() } else { $decoy.Activate(); [void]$decoyLabel.Focus() }
  Write-State $which
}
$script:pending = [Console]::In.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  if ($null -eq $script:pending) { return }
  if (-not $script:pending.IsCompleted) { return }
  $line = $script:pending.Result
  $script:pending = [Console]::In.ReadLineAsync()
  if ($null -eq $line) { return }
  $cmd = $line.Trim().ToLowerInvariant()
  if ($cmd -eq "main") { Write-Foreground $main.Handle "main" }
  elseif ($cmd -eq "decoy") { Write-Foreground $decoy.Handle "decoy" }
  elseif ($cmd -eq "snapshot") { Write-State "snapshot" }
})
$timer.Start()
$main.Add_Shown({
  $decoy.Show()
  $startup = (@{ main = $main.Handle.ToInt64(); decoy = $decoy.Handle.ToInt64(); visible = [AceInputFixture]::IsWindowVisible($main.Handle); session = [Diagnostics.Process]::GetCurrentProcess().SessionId } | ConvertTo-Json -Compress)
  [Console]::WriteLine($startup)
  [Console]::Out.Flush()
})
[void][System.Windows.Forms.Application]::Run($main)
