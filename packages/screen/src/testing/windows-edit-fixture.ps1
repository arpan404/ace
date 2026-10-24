Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$title = $env:ACE_OWNED_TITLE
if ([string]::IsNullOrEmpty($title)) {
  $title = $args[0]
}
if ([string]::IsNullOrEmpty($title)) {
  exit 1
}
$form = New-Object System.Windows.Forms.Form
$form.Text = $title
$form.Width = 420
$form.Height = 220
$box = New-Object System.Windows.Forms.TextBox
$box.AccessibleName = "OwnedEdit"
$box.Text = "ace-initial"
$box.Left = 20
$box.Top = 20
$box.Width = 340
$form.Controls.Add($box)
$form.Add_Shown({
  $line = (@{ hwnd = $form.Handle.ToInt64() } | ConvertTo-Json -Compress)
  [Console]::WriteLine($line)
  [Console]::Out.Flush()
})
[void][System.Windows.Forms.Application]::Run($form)
