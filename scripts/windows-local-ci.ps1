# Local Windows CI: runs the checks of .github/workflows/windows-native.yml and windows-desktop.yml
# on a Windows machine you control (the shared ARM64 test VM), instead of GitHub Actions.
#
# Usage (from the repo root, after `bun install --frozen-lockfile`):
#   ./scripts/windows-local-ci.ps1 [-Stage native|screen|browser|standalone|desktop|installer|git|all]
#                                  [-Files <test files>] [-Shard <i>/<n>] [-Work C:\ace\ci]
#                                  [-Install] [-Reports] [-MachineChanges]
#
# Stages (`all` runs every stage but `git`, in this order):
#   native      descriptor.node + screen helper build and cargo tests, then the bounded native suite
#   screen      screen helper pipe, owned capture, UIA, input and the computer-use engine
#   browser     every browser workflow's tests against a real Chrome (-Reports adds the
#               report-only video profile and streaming observation)
#   standalone  login task and update tests, the daemon archive build and its smoke check
#               (-MachineChanges adds install.ps1 end to end, which trusts a local certificate
#               machine-wide for its duration)
#   desktop     the desktop's Windows unit tests and the Electron window-chrome e2e
#   installer   install unit tests, two NSIS packages, install/run/update/uninstall smoke
#   git         the Git, forge and review suites (dispatch-only on GitHub; not part of `all`)
#
# -Files narrows the native, screen, browser or git suite to those test files (the native suite
# alone takes about half an hour on the ARM64 VM, longer than one locked VM session should). It
# needs exactly one of those stages: the files belong to one suite's config. -Shard i/n runs that
# suite's i-th of n parts (Vitest --shard), e.g. the native suite as 1/2 and 2/2 in two sessions.
# screen, browser, desktop and installer need the logged-in desktop (not an SSH session 0).
# Each stage logs to <Work>\<stage>.log; <Work>\summary.txt and summary.json hold pass/fail per
# stage. The exit code is non-zero when any stage failed.
param(
  [ValidateSet("native", "screen", "browser", "standalone", "desktop", "installer", "git", "all")]
  [string[]] $Stage = @("all"),
  [string[]] $Files = @(),
  [ValidatePattern('^\d+/\d+$')] [string] $Shard = "",
  [string] $Work = "C:\ace\ci",
  [switch] $Install,
  [switch] $Reports,
  [switch] $MachineChanges
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repo
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$tmp = Join-Path $Work "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
# Tests refuse temp folders inside the real home; CI points TEMP at the runner's temp.
$env:TEMP = $tmp; $env:TMP = $tmp; $env:TMPDIR = $tmp
# GitHub sets CI=true; several native tests run only under it.
$env:CI = "true"
# GitHub's images have OpenSSL on PATH (the Tailscale HTTPS tests make certificates with it).
# Elsewhere use the one Git for Windows ships, appended so Windows' own tools still come first.
if (!(Get-Command openssl -ErrorAction SilentlyContinue)) {
  $gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
  $candidates = @()
  # git.exe sits in <Git>\cmd or <Git>\bin; OpenSSL ships in <Git>\usr\bin.
  if ($gitExe) { $candidates += Join-Path (Split-Path (Split-Path $gitExe)) "usr\bin\openssl.exe" }
  $candidates += Join-Path $env:ProgramFiles "Git\usr\bin\openssl.exe"
  $gitOpenssl = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($gitOpenssl) { $env:Path = "$env:Path;$(Split-Path $gitOpenssl)" }
}

$arch = (node -p "process.arch").Trim()
if ($arch -notin @("x64", "arm64")) { throw "Unsupported Node arch: $arch" }
$rustTarget = if ($arch -eq "arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
$helper = Join-Path $repo "native\screen-helper-windows\target\$rustTarget\debug\ace-screen-helper-windows.exe"
$desktopSession = [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0
$vitest = Join-Path $repo "node_modules\vitest\vitest.mjs"

function Use-Msvc {
  if (Get-Command cl -ErrorAction SilentlyContinue) { return }
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vs = (& $vswhere -latest -products * -property installationPath).Trim()
  $devcmd = Join-Path $vs "Common7\Tools\VsDevCmd.bat"
  cmd /c "`"$devcmd`" -arch=$arch -host_arch=$arch >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
  }
  if (!(Get-Command cl -ErrorAction SilentlyContinue)) { throw "MSVC cl.exe not found" }
}

# The official, checksum-verified Node headers and node.lib the native add-on links against.
function Use-NodeHeaders {
  if ($env:ACE_WINDOWS_HEADERS_DIR -and $env:ACE_WINDOWS_NODE_LIB) { return }
  $version = (node -p "process.versions.node").Trim()
  $dist = "https://nodejs.org/dist/v$version"
  $dir = Join-Path $Work "node-headers-$version-$arch"
  $sums = Join-Path $dir "SHASUMS256.txt"; $tar = Join-Path $dir "headers.tar.gz"; $lib = Join-Path $dir "node.lib"
  if (!(Test-Path $lib)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Invoke-WebRequest -Uri "$dist/SHASUMS256.txt" -OutFile $sums
    Invoke-WebRequest -Uri "$dist/node-v$version-headers.tar.gz" -OutFile $tar
    Invoke-WebRequest -Uri "$dist/win-$arch/node.lib" -OutFile $lib
    $wantHeaders = ((Select-String -Path $sums -Pattern "node-v$version-headers.tar.gz").Line -split '\s+')[0]
    $wantLib = ((Select-String -Path $sums -Pattern "win-$arch/node.lib").Line -split '\s+')[0]
    if ((Get-FileHash $tar -Algorithm SHA256).Hash.ToLower() -ne $wantHeaders) { Remove-Item -Recurse $dir; throw "headers SHA256 mismatch" }
    if ((Get-FileHash $lib -Algorithm SHA256).Hash.ToLower() -ne $wantLib) { Remove-Item -Recurse $dir; throw "node.lib SHA256 mismatch" }
    tar -xzf $tar -C $dir
  }
  $env:ACE_WINDOWS_HEADERS_DIR = (Get-ChildItem -Path $dir -Filter "node_api.h" -Recurse | Select-Object -First 1).DirectoryName
  $env:ACE_WINDOWS_NODE_LIB = $lib
}

# Runs a native command and throws when it fails, so a stage stops at its first broken step.
function Invoke-Step([string] $name, [scriptblock] $block) {
  Write-Host "--- $name"
  $global:LASTEXITCODE = 0
  # Windows PowerShell turns a native tool's stderr into errors; the exit code decides instead.
  $ErrorActionPreference = "Continue"
  & $block 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($code -ne 0) { throw "$name failed (exit $code)" }
}

# Every stage runs on the Node the release ships (tools/release/src/node-runtime.ts), as the
# workflows pin NODE_VERSION for every job; release builds refuse any other. Use a
# checksum-verified copy of it in the work folder, never the system's.
function Use-ReleaseNode {
  $version = (Select-String -Path tools/release/src/node-runtime.ts -Pattern 'export const nodeVersion = "([^"]+)"').Matches[0].Groups[1].Value
  if ((node -p "process.versions.node").Trim() -eq $version) { return }
  $name = "node-v$version-win-$arch"
  $dir = Join-Path $Work $name
  if (!(Test-Path (Join-Path $dir "node.exe"))) {
    $zip = Join-Path $Work "$name.zip"; $sums = Join-Path $Work "SHASUMS256-$version.txt"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$version/SHASUMS256.txt" -OutFile $sums
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$version/$name.zip" -OutFile $zip
    $want = ((Select-String -Path $sums -Pattern " $name.zip$").Line -split '\s+')[0]
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want) { Remove-Item $zip; throw "$name.zip SHA256 mismatch" }
    Expand-Archive -Path $zip -DestinationPath $Work -Force
    Remove-Item $zip
  }
  $env:Path = "$dir;$env:Path"
  Write-Host "--- using Node $version from $dir"
}
Use-ReleaseNode

function Invoke-Vitest([string[]] $arguments) {
  Invoke-Step "vitest $($arguments -join ' ')" { node $vitest run @arguments }
}

function Require-Desktop {
  if (!$desktopSession) { throw "This stage needs the logged-in desktop (run it with winvm-run --desktop)" }
}

$helperBuilt = $false
function Build-Native {
  if ($script:helperBuilt) { return }
  Use-Msvc
  Use-NodeHeaders
  Invoke-Step "build descriptor.node" { node packages/workspace/build.ts }
  Invoke-Step "descriptor.node exports" {
    node -e "const a=require('./packages/workspace/dist/descriptor.node');if(typeof a.openRoot!=='function'||typeof a.statFd!=='function')throw new Error('descriptor.node exports missing');console.log('descriptor.node exports ok')"
  }
  Push-Location native\screen-helper-windows
  try {
    Invoke-Step "cargo build" { cargo build --locked --target $rustTarget }
    Invoke-Step "cargo build computer_fixture" { cargo build --locked --target $rustTarget --example computer_fixture }
    Invoke-Step "cargo test" { cargo test --locked --target $rustTarget }
  } finally { Pop-Location }
  $script:helperBuilt = $true
}

function Use-Chromium {
  if ($env:ACE_CHROMIUM_PATH -and (Test-Path $env:ACE_CHROMIUM_PATH)) { return }
  # prepare-windows-test.ts reports the browser through a GitHub-style env file.
  $env:RUNNER_TEMP = Join-Path $Work "browser"
  New-Item -ItemType Directory -Force -Path $env:RUNNER_TEMP | Out-Null
  $env:GITHUB_ENV = Join-Path $Work "browser.env"
  Set-Content -Path $env:GITHUB_ENV -Value ""
  Invoke-Step "prepare Windows browser" { node packages/browser/scripts/prepare-windows-test.ts }
  foreach ($line in Get-Content $env:GITHUB_ENV) {
    if ($line -match '^ACE_CHROMIUM_PATH=(.+)$') { $env:ACE_CHROMIUM_PATH = $matches[1] }
  }
  Remove-Item Env:GITHUB_ENV
  if (!$env:ACE_CHROMIUM_PATH) { throw "Browser preparation reported no executable" }
}

$stages = [ordered]@{
  native = {
    Build-Native
    Invoke-Vitest (@("--config", "scripts/vitest-windows-native.config.ts") + $narrowed)
  }
  screen = {
    Require-Desktop
    Build-Native
    $env:ACE_WINDOWS_SCREEN_HELPER = $helper
    try { Invoke-Vitest (@("--config", "scripts/vitest-windows-screen.config.ts") + $narrowed) }
    finally { Remove-Item Env:ACE_WINDOWS_SCREEN_HELPER -ErrorAction SilentlyContinue }
  }
  browser = {
    Require-Desktop
    Use-Chromium
    Invoke-Vitest (@("--config", "scripts/vitest-windows-browser.config.ts") + $narrowed)
    if ($Reports) {
      Invoke-Step "browser video profile (report only)" { node packages/browser/bench/video-profile.ts }
      $env:ACE_VIDEO_LINK_REPORT_ONLY = "1"; $env:ACE_VIDEO_LINK_BASELINE_SECONDS = "10"
      Invoke-Step "browser streaming performance (report only)" { node packages/browser/bench/video-link.ts }
    }
  }
  standalone = {
    Use-Msvc
    Use-NodeHeaders
    if (!(Test-Path packages\workspace\dist\descriptor.node)) { Invoke-Step "build descriptor.node" { node packages/workspace/build.ts } }
    Invoke-Vitest @("--config", "scripts/vitest-windows-native.config.ts", "packages/service/src/task.process.test.ts", "tools/release/src/task-supervisor.test.ts")
    $key = Join-Path $Work "ace-key.pem"; $public = Join-Path $Work "ace-public.pem"
    Invoke-Step "throwaway release key" {
      node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync(process.argv[1],k.privateKey.export({type:'pkcs8',format:'pem'}));f.writeFileSync(process.argv[2],k.publicKey.export({type:'spki',format:'pem'}))" $key $public
    }
    Invoke-Step "build win32-$arch daemon archive" { node tools/release/src/build.ts 0.0.0-ci "win32-$arch" $public }
    Invoke-Step "smoke the archive" { node tools/release/src/smoke.ts "tools/release/dist/win32-$arch" }
    if ($MachineChanges) {
      $check = Join-Path $Work "install-check"
      Invoke-Step "install.ps1 end to end" {
        & ./tools/release/verification/install-ps1-check.ps1 -Dist tools/release/dist -Target "win32-$arch" -PrivateKey $key -PublicKey $public -Work $check
      }
    } else { Write-Host "--- install.ps1 end to end skipped (needs -MachineChanges)" }
  }
  desktop = {
    Require-Desktop
    Invoke-Vitest @(
      "apps/web/src/lib/keymap.test.ts", "apps/web/initial-preloads.test.ts",
      "apps/web/src/boot/desktop-color-scheme.test.ts", "apps/web/src/boot/help-actions.test.ts",
      "apps/desktop/src/main/window/options.test.ts", "apps/desktop/src/main/paths.test.ts",
      "apps/desktop/src/main/notifications/activation.test.ts", "apps/desktop/src/main/deep-link.test.ts"
    )
    $env:ACE_E2E_ELECTRON = "1"; $env:ACE_E2E_SCALES = "1,1.5"
    Push-Location apps\desktop
    try { Invoke-Step "desktop window chrome e2e" { node ../../node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/desktop-chrome.e2e.ts } }
    finally { Pop-Location; Remove-Item Env:ACE_E2E_ELECTRON, Env:ACE_E2E_SCALES -ErrorAction SilentlyContinue }
  }
  installer = {
    Require-Desktop
    Use-Msvc
    Invoke-Vitest @(
      "apps/desktop/src/packaging/setup.test.ts", "apps/desktop/src/packaging/user-path.test.ts",
      "apps/desktop/src/main/os/cli-path.test.ts", "apps/desktop/src/main/daemon/target.test.ts"
    )
    $first = "0.0.1-ci.1"; $second = "0.0.1-ci.2"
    $release = "apps/desktop/dist/release"
    $installers = Join-Path $Work "installers"
    New-Item -ItemType Directory -Force -Path $installers | Out-Null
    $env:ACE_VERSION = $first
    Invoke-Step "package $first" { node apps/desktop/scripts/package.ts --full --unsigned --arch $arch }
    Move-Item -Force "$release/ace-$first-$arch-setup.exe" $installers
    foreach ($file in @("apps/desktop/dist/app/package.json", "apps/desktop/dist/daemon/desktop-app.json")) {
      $json = Get-Content $file -Raw | ConvertFrom-Json
      $json.version = $second
      [IO.File]::WriteAllText((Resolve-Path $file), ($json | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    }
    $env:ACE_VERSION = $second
    Invoke-Step "package $second" { node apps/desktop/scripts/package.ts --full --unsigned --skip-build --arch $arch }
    Remove-Item Env:ACE_VERSION
    Move-Item -Force "$release/ace-$second-$arch-setup.exe" $installers
    # A scratch data home so the smoke never touches the machine user's own ~/.ace.
    $env:ACE_HOME = Join-Path $Work "installer-home"
    # The smoke needs a clean home and keeps it on uninstall, so clear the last run's.
    if (Test-Path $env:ACE_HOME) { Remove-Item -Recurse -Force $env:ACE_HOME }
    try {
      Invoke-Step "install, run, update and uninstall" {
        & ./apps/desktop/scripts/installer-smoke.ps1 -First (Join-Path $installers "ace-$first-$arch-setup.exe") -Second (Join-Path $installers "ace-$second-$arch-setup.exe") -SecondVersion $second
      }
    } finally { Remove-Item Env:ACE_HOME -ErrorAction SilentlyContinue }
  }
  git = {
    Invoke-Vitest (@("--config", "scripts/vitest-git-native.config.ts") + $narrowed)
  }
}

$selected = if ($Stage -contains "all") { @($stages.Keys | Where-Object { $_ -ne "git" }) } else { $Stage }
$narrowed = @($Files) + @(if ($Shard) { "--shard=$Shard" })
if (($Files.Count -or $Shard) -and (@($selected).Count -ne 1 -or @($selected)[0] -notin @("native", "screen", "browser", "git"))) {
  throw "-Files and -Shard need exactly one of the native, screen, browser or git stages"
}

if ($Install) {
  Use-Msvc
  Use-NodeHeaders
  Invoke-Step "bun install" { bun install --frozen-lockfile --os=win32 --cpu=$arch }
}

$results = [ordered]@{}
$summary = Join-Path $Work "summary.txt"
$commit = (git rev-parse --short HEAD).Trim()
foreach ($name in $selected) {
  $log = Join-Path $Work "$name.log"
  $started = Get-Date
  Write-Host "=== $name (log: $log)"
  $status = "pass"; $detail = ""
  # UTF-8, not Windows PowerShell's UTF-16 default, so the logs read anywhere.
  try { $writer = New-Object System.IO.StreamWriter($log, $false, (New-Object System.Text.UTF8Encoding $false)) }
  catch { throw "Cannot write $log (is an earlier run still holding it?): $($_.Exception.Message)" }
  try {
    & $stages[$name] *>&1 | ForEach-Object { $line = "$_"; $writer.WriteLine($line); $writer.Flush(); $line } | Out-Host
  } catch {
    $status = "fail"; $detail = $_.Exception.Message
    $writer.WriteLine("STAGE FAILED: $detail")
  } finally { $writer.Dispose() }
  $seconds = [int]((Get-Date) - $started).TotalSeconds
  $results[$name] = [ordered]@{ status = $status; seconds = $seconds; detail = $detail; log = $log }
  Write-Host "=== $name $status in ${seconds}s $detail"
  # Rewritten after every stage, so an interrupted run still reports what finished.
  $lines = @("commit $commit  arch $arch  $(Get-Date -Format s)")
  foreach ($key in $results.Keys) { $lines += "{0,-11} {1,-4} {2,5}s {3}" -f $key, $results[$key].status, $results[$key].seconds, $results[$key].detail }
  Set-Content -Path $summary -Value $lines
  [ordered]@{ commit = $commit; arch = $arch; stages = $results } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Work "summary.json")
}
Get-Content $summary
if (@($results.Values | Where-Object { $_.status -ne "pass" }).Count) { exit 1 }
exit 0
