# State lines carry the form's Unicode text; the test reads UTF-8, whatever the console code page.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AceInputFixture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int capacity);
  private static readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
  public static void StartReader() {
    var reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();
  }
  private static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Length <= 32 && commands.Count < 16) commands.Enqueue(line);
    }
  }
  public static string ReadCommand() {
    string line;
    return commands.TryDequeue(out line) ? line : null;
  }
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
$script:selectAllCount = 0
# Define the fixture's shortcut explicitly; it must receive the real Ctrl+A event.
$box.Add_KeyDown({
  param($sender, $key)
  if ($key.Control -and $key.KeyCode -eq [System.Windows.Forms.Keys]::A) {
    $box.SelectAll()
    $script:selectAllCount += 1
    $key.SuppressKeyPress = $true
  }
})
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
  $window = [AceInputFixture]::GetForegroundWindow()
  [uint32]$foregroundProcess = 0
  [void][AceInputFixture]::GetWindowThreadProcessId($window, [ref]$foregroundProcess)
  $foregroundName = "unavailable"
  $foregroundSession = -1
  $observed = $null
  try {
    $observed = [Diagnostics.Process]::GetProcessById($foregroundProcess)
    $foregroundName = $observed.ProcessName
    $foregroundSession = $observed.SessionId
  } catch {
    # Failure to inspect another process must not change foreground behavior.
  } finally {
    if ($null -ne $observed) { $observed.Dispose() }
  }
  $class = New-Object System.Text.StringBuilder 256
  [void][AceInputFixture]::GetClassName($window, $class, $class.Capacity)
  $line = (@{ foreground = $window.ToInt64(); foregroundPid = $foregroundProcess; foregroundName = $foregroundName; foregroundSession = $foregroundSession; foregroundClass = $class.ToString(); main = $main.Handle.ToInt64(); decoy = $decoy.Handle.ToInt64(); pid = [Diagnostics.Process]::GetCurrentProcess().Id; which = $which; mainText = $box.Text; decoyText = $decoyLabel.Text; count = $count.Text; selectAllCount = $script:selectAllCount } | ConvertTo-Json -Compress)
  [Console]::WriteLine($line)
  [Console]::Out.Flush()
}
function Write-Foreground($handle, $which) {
  [void][AceInputFixture]::ShowWindow($handle, 9)
  [void][AceInputFixture]::SetForegroundWindow($handle)
  if ($which -eq "main") { $main.Activate() } else { $decoy.Activate(); [void]$decoyLabel.Focus() }
  Write-State $which
}
# Console.In's synchronized reader blocks even for ReadLineAsync on .NET Framework.
# Keep reads off the WinForms thread; only its timer handles owned-window commands.
[AceInputFixture]::StartReader()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  $line = [AceInputFixture]::ReadCommand()
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
