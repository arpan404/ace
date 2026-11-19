# Runs one GitHub Actions runner for ace's release pipeline as ephemeral runners, one after
# another (ADR 0188), on the Windows VM as the ace-ci user (docs/release/runners.md). Each
# registers, takes exactly one job, is removed by GitHub, and its work folder is deleted before
# the next registers.
#
#   run-ephemeral.ps1 -RunnerDir C:\ace-ci\runner -Name ace-win -Labels ace-win
#
# The registration token comes from GitHub's API with the fine-grained token in
# $env:ACE_RUNNER_TOKEN_FILE (repository Administration: read and write, arpan404/ace only).
param(
  [Parameter(Mandatory)] [string] $RunnerDir,
  [Parameter(Mandatory)] [string] $Name,
  [Parameter(Mandatory)] [string] $Labels
)
$ErrorActionPreference = 'Stop'
$tokenFile = if ($env:ACE_RUNNER_TOKEN_FILE) { $env:ACE_RUNNER_TOKEN_FILE } else { Join-Path $HOME '.config\ace-runner\token' }
$repo = 'arpan404/ace'
Set-Location $RunnerDir
while ($true) {
  foreach ($stale in '_work', '.runner', '.credentials', '.credentials_rsaparams') {
    if (Test-Path $stale) { Remove-Item -Recurse -Force $stale }
  }
  try {
    $response = Invoke-RestMethod -Method Post `
      -Uri "https://api.github.com/repos/$repo/actions/runners/registration-token" `
      -Headers @{ Authorization = "Bearer $((Get-Content -Raw $tokenFile).Trim())"; Accept = 'application/vnd.github+json' }
  } catch {
    Write-Warning "Couldn't get a registration token; retrying in 60s: $_"
    Start-Sleep -Seconds 60
    continue
  }
  & .\config.cmd --unattended --ephemeral --replace --disableupdate `
    --url "https://github.com/$repo" --token $response.token `
    --name $Name --labels $Labels --work _work
  # Exits after its one job; a crash or a lost connection just starts a fresh runner.
  & .\run.cmd
  if ($LASTEXITCODE -ne 0) { Start-Sleep -Seconds 10 }
}
