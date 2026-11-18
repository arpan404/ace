# Release runners

How to set up the three machines and the GitHub settings that ace's release pipeline needs
([ADR 0188](../adr/0188-tag-driven-release-pipeline.md), `.github/workflows/release.yml`). Do
these once, in order. After that a release is:

```sh
git tag ace-0.0.24-beta-1 origin/main && git push origin ace-0.0.24-beta-1   # a beta
git tag v0.0.24 origin/main && git push origin v0.0.24                       # stable, after the version bump PR
```

To rerun a tag: **Actions › Release › Re-run failed jobs**, or **Run workflow** on `main` with
the tag. Finished steps are not repeated.

## 1. GitHub settings (repository `arpan404/ace`)

### Tag ruleset: only the owner creates release tags

**Settings › Rules › Rulesets › New ruleset › New tag ruleset**

- Name `release tags`, enforcement **Active**.
- Bypass list: **Repository admin**, mode **Always**.
- Target tags: include by pattern `v*` and `ace-*-beta-*`.
- Rules: **Restrict creations**, **Restrict updates**, **Restrict deletions**, **Block force
  pushes**.

Make sure the owner is the only admin (Settings › Collaborators: nobody else has Admin). Only a
bypassing actor can create a restricted tag, so only the owner can start a release.

### Actions

**Settings › Actions › General**

- Actions permissions: **Allow arpan404, and select non-arpan404, actions**, allowing
  `actions/checkout@*`, `actions/setup-node@*`, `actions/upload-artifact@*`,
  `actions/download-artifact@*` and `oven-sh/setup-bun@*`.
- Fork pull request workflows from outside collaborators: **Require approval for all external
  contributors**.
- Workflow permissions: **Read repository contents and packages permissions**; leave "Allow
  GitHub Actions to create and approve pull requests" off. Jobs ask for more themselves.

### Environments

**Settings › Environments**: create `release`, `staging` and `production`. For each:

- No required reviewers (the tag push is the approval).
- Deployment branches and tags: **Selected branches and tags**, adding branch `main` (for a
  manual rerun) and tags `v*` and `ace-*-beta-*`.

| Environment  | Secrets                                                                                                                                       | Variables                                                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release`    | `ACE_RELEASE_PRIVATE_KEY` (the Ed25519 PEM), `MAC_KEYCHAIN_PASSWORD`, `AZURE_CLIENT_SECRET` (if Windows is signed with Azure Trusted Signing) | `ACE_RELEASE_PUBLIC_KEY` (PEM), `CSC_NAME`, `APPLE_KEYCHAIN_PROFILE` (`ace-notary`), and for Windows signing `ACE_WINDOWS_PUBLISHER`, `ACE_AZURE_SIGNING_ENDPOINT`, `ACE_AZURE_SIGNING_ACCOUNT`, `ACE_AZURE_CERTIFICATE_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` |
| `staging`    | `CLOUDFLARE_API_TOKEN` (a token scoped to the staging Workers and D1)                                                                         | `CLOUDFLARE_ACCOUNT_ID`                                                                                                                                                                                                                                                |
| `production` | `CLOUDFLARE_API_TOKEN` (production Workers and D1, and Pages edit for the web app)                                                            | `CLOUDFLARE_ACCOUNT_ID`                                                                                                                                                                                                                                                |

Delete the old repository-level `CLOUDFLARE_API_TOKEN` secret once `production` has its own:
secrets live only in environments. Without the Windows signing variables the Windows build is
unsigned.

### The runner-registration token

The runners register themselves before every job, which needs a registration token from the
API. Create a **fine-grained personal access token** (Settings › Developer settings):
repository access **Only arpan404/ace**, permission **Administration: Read and write**, nothing
else, expiry 90 days. Each machine keeps a copy in `ace-ci`'s home (below). Renew it before it
expires; the runners log `Couldn't get a registration token` when it has.

## 2. omarchy (Linux): every step but the macOS and Windows builds

Three runner instances, so the two Linux builds and the notes can run at once.

```sh
# The user: unprivileged, no wheel or docker group.
sudo useradd --create-home --shell /bin/bash ace-ci
sudo loginctl enable-linger ace-ci          # a user manager for rootless podman

# Rootless containers, and arm64 emulation for the Linux arm64 build.
sudo pacman -S --needed podman qemu-user-static qemu-user-static-binfmt git curl github-cli
grep -q '^ace-ci:' /etc/subuid || sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 ace-ci
sudo systemctl restart systemd-binfmt
# Rootless podman runs inside the runner service, which checks it on every start (below).
```

As `ace-ci` (`sudo -iu ace-ci`):

```sh
# The release-notes agent's CLI, logged in as ace-ci (ADR 0002): ace never holds the login.
# Install Claude Code for this user, then:
claude          # /login once, then quit

mkdir -p ~/.config/ace-runner && chmod 700 ~/.config/ace-runner
install -m 600 /dev/stdin ~/.config/ace-runner/token    # paste the fine-grained token, then Ctrl-D

# The runner, three copies. Take the current version and checksum from
# https://github.com/actions/runner/releases.
version=2.330.0
curl -fLo /tmp/runner.tgz "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"
echo "<sha256 from the release page>  /tmp/runner.tgz" | sha256sum -c -
for n in 1 2 3; do mkdir -p ~/runner-$n && tar -xzf /tmp/runner.tgz -C ~/runner-$n; done

# Optional: the notification hook. It gets the title and the body as its two arguments.
printf 'ACE_RELEASE_NOTIFY=/home/ace-ci/.config/ace-runner/notify\n' | tee -a ~/runner-{1,2,3}/.env
```

A hook can be any executable, for example one that posts to a phone push service. When ace's CLI
gains a notify command, the hook calls it.

As root, install `tools/release/runners/run-ephemeral.sh` from the repository outside `ace-ci`'s
home, so the runner's jobs can't change it:
`sudo install -D -o root -g root -m 755 run-ephemeral.sh /usr/local/libexec/ace-ci/run-ephemeral.sh`. Then, as root,
`/etc/systemd/system/ace-runner@.service`:

```ini
[Unit]
Description=ace release runner %i
After=network-online.target
Wants=network-online.target

[Service]
User=ace-ci
# ace-ci's id, from `id -u ace-ci`; rootless podman needs its runtime folder.
Environment=XDG_RUNTIME_DIR=/run/user/<ace-ci uid>
# Rootless podman and arm64 emulation, checked in this exact service context before the runner
# registers: a failure keeps the runner offline and shows in `systemctl status`.
ExecStartPre=/usr/bin/podman run --rm --platform linux/arm64 docker.io/library/debian:12 uname -m
ExecStart=/usr/local/libexec/ace-ci/run-ephemeral.sh /home/ace-ci/runner-%i omarchy-%i omarchy
Restart=always
RestartSec=10
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

No `NoNewPrivileges=`, and none of the sandboxing options that turn it on (`RestrictSUIDSGID=`,
`SystemCallFilter=`, `RestrictNamespaces=`, `PrivateDevices=`, `ProtectKernel*=` and the like):
rootless podman maps its users through the setuid `newuidmap` and `newgidmap`, which
`NoNewPrivileges` disables. The containers themselves are the isolation for the build. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ace-runner@1 ace-runner@2 ace-runner@3
journalctl -u ace-runner@1 -b | grep -E 'aarch64|Listening for Jobs'   # both lines
```

`aarch64` comes from the start check: podman ran an arm64 container as `ace-ci` under the
service's own settings. If it's missing, `systemctl status ace-runner@1` shows the error.

They appear under Settings › Actions › Runners as `omarchy-1..3` with labels `self-hosted`,
`Linux`, `X64`, `omarchy`. Workflows match labels case-insensitively.

## 3. The owner's Mac: the macOS build only

Create the user and its signing keychain (as an admin):

```sh
sudo sysadminctl -addUser ace-ci -fullName "ace CI" -password -    # standard user, not admin
sudo -iu ace-ci
```

As `ace-ci`:

```sh
# Xcode command line tools are installed machine-wide (xcode-select --install).
# The signing keychain: the only place the Developer ID identity lives.
security create-keychain -p '<keychain password>' ace-signing.keychain-db
security set-keychain-settings -lut 7200 ace-signing.keychain-db
security list-keychains -d user -s ace-signing.keychain-db login.keychain-db
# Export "Developer ID Application: …" with its private key from the owner's keychain as a
# .p12 (Keychain Access › Export), then:
security import developer-id.p12 -k ace-signing.keychain-db -T /usr/bin/codesign -T /usr/bin/security -P '<p12 password>'
security set-key-partition-list -S apple-tool:,apple: -s -k '<keychain password>' ace-signing.keychain-db
rm developer-id.p12
security find-identity -v -p codesigning ace-signing.keychain-db     # lists the identity
# Notarization credentials, stored in the same keychain as profile "ace-notary":
xcrun notarytool store-credentials ace-notary --key AuthKey_XXXX.p8 --key-id <key id> \
  --issuer <issuer id> --keychain ~/Library/Keychains/ace-signing.keychain-db
rm AuthKey_XXXX.p8
security lock-keychain ace-signing.keychain-db

mkdir -p ~/.config/ace-runner && chmod 700 ~/.config/ace-runner
install -m 600 /dev/stdin ~/.config/ace-runner/token    # paste the fine-grained token, then Ctrl-D
version=2.330.0
curl -fLo /tmp/runner.tgz "https://github.com/actions/runner/releases/download/v$version/actions-runner-osx-arm64-$version.tar.gz"
shasum -a 256 /tmp/runner.tgz        # compare with the release page
mkdir -p ~/runner && tar -xzf /tmp/runner.tgz -C ~/runner
```

Put `<keychain password>` in the `release` environment as `MAC_KEYCHAIN_PASSWORD`; it is not
kept on the Mac. Set `CSC_NAME` to the identity's name after `Developer ID Application: ` and
`APPLE_KEYCHAIN_PROFILE` to `ace-notary`.

As an admin, copy `tools/release/runners/run-ephemeral.sh` to `/usr/local/libexec/` (root-owned,
mode 755) and create `/Library/LaunchDaemons/dev.ace.ci-runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.ace.ci-runner</string>
  <key>UserName</key><string>ace-ci</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/libexec/run-ephemeral.sh</string>
    <string>/Users/ace-ci/runner</string>
    <string>ace-mac</string>
    <string>ace-mac</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>/Users/ace-ci</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/ace-ci/runner.log</string>
  <key>StandardErrorPath</key><string>/Users/ace-ci/runner.log</string>
</dict>
</plist>
```

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.ace.ci-runner.plist
tail -f /Users/ace-ci/runner.log     # "Listening for Jobs"
```

While the Mac sleeps the macOS build waits in the queue (GitHub gives up after 24 hours; rerun
the failed job then).

## 4. The Windows VM: the Windows x64 build only

On the ARM64 VM, as an administrator:

```powershell
# A standard (non-admin) account for the runner.
$password = Read-Host -AsSecureString 'Password for ace-ci'
New-LocalUser -Name ace-ci -Password $password -PasswordNeverExpires
# Git, Python 3 and the Visual Studio 2022 Build Tools with "Desktop development with C++"
# including the x64/x86 build tools (native modules are built for x64).
winget install --id Git.Git -e
winget install --id Python.Python.3.12 -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

As `ace-ci` (`runas /user:ace-ci powershell`):

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\ace-runner", "$HOME\runner" | Out-Null
Set-Content -NoNewline "$HOME\.config\ace-runner\token" (Read-Host 'Fine-grained token')
icacls "$HOME\.config\ace-runner\token" /inheritance:r /grant:r "ace-ci:(R)"
$version = '2.330.0'
Invoke-WebRequest "https://github.com/actions/runner/releases/download/v$version/actions-runner-win-arm64-$version.zip" -OutFile "$env:TEMP\runner.zip"
(Get-FileHash "$env:TEMP\runner.zip").Hash    # compare with the release page
Expand-Archive "$env:TEMP\runner.zip" "$HOME\runner"
```

The workflow installs x64 Node and x64 Bun itself, so the build is x64 under emulation.

As an administrator, copy `tools/release/runners/run-ephemeral.ps1` to `C:\ProgramData\ace-ci\`
(writable only by administrators) and run it at boot as `ace-ci`, in the background:

```powershell
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -File C:\ProgramData\ace-ci\run-ephemeral.ps1 -RunnerDir C:\Users\ace-ci\runner -Name ace-win -Labels ace-win'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName 'ace release runner' -Action $action -Trigger $trigger -Settings $settings -User 'ace-ci' -Password (Read-Host 'ace-ci password') -RunLevel Limited
Start-ScheduledTask -TaskName 'ace release runner'
```

## 5. Check before the first real release

- Settings › Actions › Runners shows `omarchy-1..3`, `ace-mac` and `ace-win` idle.
- Push a beta tag (`ace-<next>-beta-<N>`). Watch Actions › Release: prepare plans all four
  platforms, each build runs on its machine, notes appear on the draft, staging and production
  deploy, and the beta publishes as a prerelease. The owner gets the notify hook's message.
- Renew the runner token and update the runner folders when GitHub announces a new minimum
  runner version (the runners don't update themselves: `--disableupdate`).
