# Installs the ace daemon for the current Windows user: no administrator rights.
# Same checks as install.sh: the archive must match the hash pinned in this file, then the
# bundled Node verifies the Ed25519 signature of the release manifest before anything runs.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$ProgressPreference = 'SilentlyContinue'
# Publication substitutes this reviewed public key and exact release base URL.
$PublicKey = @'
__ACE_RELEASE_PUBLIC_KEY__
'@
$Base = '__ACE_RELEASE_BASE_URL__'
if (-not $Base.StartsWith('https://')) { throw 'Installer has not been configured for publication' }

# The machine's own architecture, also from an emulated x64 PowerShell on ARM64.
$machine = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
switch ($machine) {
  'ARM64' { $target = 'win32-arm64'; $pinned = '__ACE_WIN32_ARM64_SHA256__' }
  'AMD64' { $target = 'win32-x64'; $pinned = '__ACE_WIN32_X64_SHA256__' }
  default { throw "Unsupported architecture $machine" }
}
if (-not $pinned) { throw "This ace release has no $target build" }

$home_ = if ($env:ACE_HOME) { $env:ACE_HOME } else { Join-Path $env:USERPROFILE '.ace' }
$home_ = [System.IO.Path]::GetFullPath($home_)
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ace-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

# Windows PowerShell 5.1 may not offer TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-ReleaseFile([string]$Name, [string]$Path, [long]$Limit) {
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name" -OutFile $Path -MaximumRedirection 5 -TimeoutSec 120
  if ((Get-Item -LiteralPath $Path).Length -gt $Limit) { throw "$Name is larger than expected" }
}

try {
  $manifest = Join-Path $scratch 'manifest.json'
  $signature = Join-Path $scratch 'signature.txt'
  $archive = Join-Path $scratch 'artifact.tar.gz'
  $artifact = Join-Path $scratch 'artifact'
  $key = Join-Path $scratch 'key.pem'
  [System.IO.File]::WriteAllText($key, $PublicKey.Trim() + "`n")
  Get-ReleaseFile "$target.json" $manifest 16384
  Get-ReleaseFile "$target.sig" $signature 128
  # Publisher emits compact JSON in this exact form; restrictive fields forbid path syntax.
  $text = [System.IO.File]::ReadAllText($manifest)
  $name = [regex]::Match($text, '"archive":"(ace-[a-z0-9.-]*\.tar\.gz)"').Groups[1].Value
  $sha = [regex]::Match($text, '"sha256":"([a-f0-9]{64})"').Groups[1].Value
  if (-not $name -or -not $sha) { throw 'Invalid release manifest' }
  Get-ReleaseFile $name $archive 268435456
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sha -or $actual -ne $pinned) { throw 'Checksum mismatch' }
  New-Item -ItemType Directory -Path $artifact | Out-Null
  # The trusted installer pins this archive independently of the downloaded manifest.
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $archive -C $artifact
  if ($LASTEXITCODE -ne 0) { throw 'Cannot unpack the release archive' }
  $node = Join-Path $artifact 'bin\node.exe'
  $verify = @'
const fs = require("node:fs"), crypto = require("node:crypto");
const [manifest, signature, key, target, sha] = process.argv.slice(2);
const bytes = fs.readFileSync(manifest), sig = Buffer.from(fs.readFileSync(signature, "utf8").trim(), "base64");
if (sig.length !== 64 || !crypto.verify(null, bytes, crypto.createPublicKey(fs.readFileSync(key)), sig)) throw new Error("Release signature rejected");
const data = JSON.parse(bytes.toString());
if (data.target !== target || data.sha256 !== sha) throw new Error("Release target or checksum mismatch");
'@
  # A file, not -e: Windows PowerShell 5.1 does not escape quotes inside native arguments.
  $verifier = Join-Path $scratch 'verify.cjs'
  [System.IO.File]::WriteAllText($verifier, $verify)
  & $node $verifier $manifest $signature $key $target $actual
  if ($LASTEXITCODE -ne 0) { throw 'Release verification failed' }
  Copy-Item -LiteralPath $manifest -Destination (Join-Path $artifact 'release.json')
  $env:ACE_HOME = $home_
  & $node (Join-Path $artifact 'ace.mjs') install-artifact $artifact
  if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

# Put <home>\bin on the user's PATH once. The desktop app adds the same entry, so an entry
# that already names it (any case, trailing slash, or written with variables) is kept as is.
$bin = Join-Path $home_ 'bin'
$normal = { param($p) [Environment]::ExpandEnvironmentVariables($p).Trim().TrimEnd('\').ToLowerInvariant() }
$environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $raw = $environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($null -ne $environment.GetValue('Path')) { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $present = @($raw -split ';' | Where-Object { $_.Trim() -and ((& $normal $_) -eq (& $normal $bin)) }).Count -gt 0
  if (-not $present) {
    $next = if ($raw.TrimEnd(';')) { $raw.TrimEnd(';') + ';' + $bin } else { $bin }
    # Writing through the registry keeps the value's type (REG_EXPAND_SZ stays expandable).
    $environment.SetValue('Path', $next, $kind)
    Add-Type -Namespace AceInstall -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
    $result = [System.UIntPtr]::Zero
    # WM_SETTINGCHANGE to every top-level window, so new terminals see the new PATH.
    [AceInstall.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
  }
} finally {
  $environment.Close()
}
if (-not (@($env:Path -split ';' | Where-Object { (& $normal $_) -eq (& $normal $bin) }).Count)) {
  $env:Path = $env:Path.TrimEnd(';') + ';' + $bin
}
Write-Output "Installed. Open a new terminal and run ace status."
