# CI check of install.ps1 against a locally built Windows archive, served over HTTPS from
# localhost with a throwaway certificate. Installs into a temporary ACE_HOME, then checks the
# daemon answers, the login task runs and stops, PATH gained <home>\bin with its value type
# kept, and uninstall removes the task. Runs on a disposable CI runner only: it trusts a
# local certificate machine-wide for the duration and edits the runner user's PATH.
param(
  [Parameter(Mandatory)] [string]$Dist,
  [Parameter(Mandatory)] [string]$Target,
  [Parameter(Mandatory)] [string]$PrivateKey,
  [Parameter(Mandatory)] [string]$PublicKey,
  [Parameter(Mandatory)] [string]$Work
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$port = 8443

& node (Join-Path $repo 'tools\release\src\sign.ts') (Join-Path $Dist "$Target.json") $PrivateKey (Join-Path $Dist "$Target.sig")
if ($LASTEXITCODE -ne 0) { throw 'Signing failed' }
$manifest = Get-Content -Raw (Join-Path $Dist "$Target.json") | ConvertFrom-Json

$installer = (Get-Content -Raw (Join-Path $repo 'tools\release\install.ps1')).
  Replace('__ACE_RELEASE_PUBLIC_KEY__', (Get-Content -Raw $PublicKey).Trim()).
  Replace('__ACE_RELEASE_BASE_URL__', "https://localhost:$port")
foreach ($t in 'win32-x64', 'win32-arm64') {
  $pin = if ($t -eq $Target) { $manifest.sha256 } else { '' }
  $installer = $installer.Replace("__ACE_$($t.Replace('-', '_').ToUpperInvariant())_SHA256__", $pin)
}
$script = Join-Path $Work 'install.ps1'
[System.IO.File]::WriteAllText($script, $installer)

$cert = New-SelfSignedCertificate -DnsName localhost -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable
$pfx = Join-Path $Work 'server.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString 'ace' -AsPlainText -Force) | Out-Null
$cer = Join-Path $Work 'server.cer'
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null

$server = Join-Path $Work 'serve.cjs'
[System.IO.File]::WriteAllText($server, @'
const https = require("node:https"), fs = require("node:fs"), path = require("node:path");
const [pfx, dir, port] = process.argv.slice(2);
https.createServer({ pfx: fs.readFileSync(pfx), passphrase: "ace" }, (request, response) => {
  const file = path.join(dir, path.basename(decodeURIComponent(new URL(request.url, "https://x").pathname)));
  fs.createReadStream(file).on("error", () => { response.statusCode = 404; response.end(); }).pipe(response);
}).listen(Number(port));
'@)
$serving = Start-Process -FilePath node -ArgumentList @($server, $pfx, $Dist, $port) -PassThru -WindowStyle Hidden

$environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$originalPath = $environment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$originalKind = if ($null -ne $originalPath) { $environment.GetValueKind('Path') } else { $null }
# A variable entry must survive unexpanded, and the value stay REG_EXPAND_SZ.
$seed = '%USERPROFILE%\ace-install-check'
$environment.SetValue('Path', $(if ($originalPath) { "$originalPath;$seed" } else { $seed }), [Microsoft.Win32.RegistryValueKind]::ExpandString)

$home_ = Join-Path $Work 'home'
$ace = Join-Path $home_ 'bin\ace.cmd'
$failed = $null
try {
  Start-Sleep -Seconds 2
  $env:ACE_HOME = $home_
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed with $LASTEXITCODE" }

  $raw = $environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($environment.GetValueKind('Path') -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'PATH lost REG_EXPAND_SZ' }
  if (-not $raw.Contains($seed)) { throw "PATH lost its variable entry: $raw" }
  $entries = @($raw -split ';' | Where-Object { $_.TrimEnd('\') -ieq (Join-Path $home_ 'bin') })
  if ($entries.Count -ne 1) { throw "PATH should name $home_\bin once: $raw" }

  $status = $null
  for ($i = 0; $i -lt 60 -and -not $status; $i++) {
    $out = & $ace status --json 2>$null
    if ($LASTEXITCODE -eq 0 -and "$out" -match '"version":"0\.0\.0-ci"') { $status = "$out" } else { Start-Sleep -Seconds 1 }
  }
  if (-not $status) { throw 'The installed daemon never answered ace status' }
  Write-Host "ace status: $status"

  $service = & $ace service status --json
  if ("$service" -notmatch '"active":true') { throw "Service not active: $service" }
  $stopped = & $ace service stop --json
  if ("$stopped" -notmatch '"active":false') { throw "Service did not stop: $stopped" }
  $started = & $ace service start --json
  if ("$started" -notmatch '"active":true') { throw "Service did not start: $started" }
  $removed = & $ace service uninstall --json
  if ("$removed" -notmatch '"active":false') { throw "Service did not uninstall: $removed" }
  & schtasks.exe /Query /TN ace-next-daemon *> $null
  if ($LASTEXITCODE -eq 0) { throw 'The login task is still registered after uninstall' }
  if (Test-Path (Join-Path $home_ 'releases')) { throw 'Uninstall left the releases behind' }
  Write-Host 'install.ps1 check passed'
} catch {
  $failed = $_
  Get-ChildItem (Join-Path $home_ 'logs') -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 50
  }
} finally {
  & schtasks.exe /End /TN ace-next-daemon *> $null
  & schtasks.exe /Delete /TN ace-next-daemon /F *> $null
  Stop-Process -Id $serving.Id -Force -ErrorAction SilentlyContinue
  if ($null -ne $originalPath) { $environment.SetValue('Path', $originalPath, $originalKind) } else { $environment.DeleteValue('Path', $false) }
  $environment.Close()
  Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $cert.Thumbprint | Remove-Item
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)"
}
if ($failed) { throw $failed }
