# 0092: The daemon runs natively on Windows

Date: 2026-10-20. Status: proposed. Amends [ADR 0048](0048-windows-screen-helper.md),
[ADR 0054](0054-desktop-shell.md) (the remote-only Windows target), [ADR 0084](0084-use-my-chrome.md)
(Windows was out of scope) and [ADR 0087](0087-background-computer-use-engine.md) (macOS only).

## Context

The Windows desktop app builds today but only as a client for a daemon on another machine
(`remote-only`, `apps/desktop/src/main/daemon/target.ts`). Nothing below the client runs on
Windows: `bun install` fails in the workspace addon build, the terminal service throws on
win32, provider process trees are POSIX process groups, releases have no win32 target and
service registration knows only launchd and systemd. The Rust Windows screen helper (ADR 0048)
speaks the session protocol that ADR 0087 retired for agents, and it has never run on Windows.

Two ways to get a daemon on a Windows machine were considered:

- **WSL2.** The daemon stays POSIX. It would see Linux paths, Linux provider installs and a
  Linux PATH, not the person's Windows checkouts and CLIs; browser and computer use would cross
  the VM boundary. It also needs WSL installed and running. Rejected.
- **Native win32.** The daemon runs on Node for Windows against the person's Windows CLIs,
  files and desktop. Chosen.

## Decision

The daemon, CLI, terminal, browser and computer-use engine run natively on Windows 10 1903+
and Windows 11, x64 and ARM64. Release targets gain `win32-x64` and `win32-arm64`.

### Process ownership

POSIX process groups become Job Objects on Windows. Every provider, terminal and helper tree
the daemon starts is assigned to a job created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a
crashed daemon cannot orphan it. Stopping a tree asks politely first (stdin close, a
provider's own interrupt, `CTRL_BREAK_EVENT` for console trees), then terminates the job.
`kill("SIGTERM")` is never used as a graceful stop on win32, because Node maps it to
`TerminateProcess`. The supervisor and desktop app stop the daemon through `POST /v1/stop`.

### Filesystem confinement

The workspace addon keeps its descriptor-relative contract on Windows. Opens are relative to
a held directory handle (`NtCreateFile` with `RootDirectory`) and pass
`FILE_OPEN_REPARSE_POINT`, so junctions and symlinks are refused rather than followed, the
Windows equivalent of `openat(O_NOFOLLOW)`. Handles become Node file descriptors through
libuv's `uv_open_osfhandle`, so the TypeScript `Descriptor` class is unchanged.

### Installation, service and updates

- Data home stays `%USERPROFILE%\.ace` (`ACE_HOME` still overrides), matching the provider
  CLIs' own homes and the existing resolver.
- `current` and `previous` are pointer files written by write-then-rename on win32, since
  directory symlinks need Developer Mode and cannot be replaced by rename.
- The installed launcher is `bin\ace.cmd`.
- The login service is a per-user Task Scheduler task with a logon trigger and restart on
  failure. It needs no administrator rights and runs in the person's session, where their CLI
  credentials and desktop are. A Windows Service would run outside that session.
- The installer is `install.ps1`, verified the same way as `install.sh`: pinned archive hash,
  then the bundled Node verifies the Ed25519 manifest.
- Updates retry Windows sharing violations (`EBUSY`, `EPERM`) and treat pruning old releases
  as best effort, since a loaded `.exe` or `.node` cannot be deleted.
- Release binaries and installers are Authenticode-signed with the release publisher's
  certificate. Unsigned builds are development builds.

### Terminal

Terminals use node-pty's ConPTY backend. The default shell is PowerShell 7 when installed,
otherwise Windows PowerShell; the person's terminal setting still wins.

### Browser use

The pipe transport works unchanged. ace's own Chromium comes from Chrome for Testing on x64.
Chrome for Testing has no Windows ARM64 build, so ARM64 uses an installed native Chrome or
Edge. "Use my Chrome" registers its native messaging host under
`HKCU\Software\<vendor>\NativeMessagingHosts` with a `.cmd` launcher.

### Computer use

The Rust helper gains a `--computer` mode that speaks ADR 0087's engine contract exactly
(`hello`, `apps`, `resolve`, `state`, `act`, `cancel` over newline JSON on stdio), so the
daemon's client, helper pool, cancel and toolkit are shared across platforms. UI Automation
replaces the macOS accessibility API. Actions prefer, in order: UIA patterns, window messages
to the target window, and only then foreground `SendInput` after an explicit `activate`. Each
step reports which path it took. The session mode of ADR 0048 stays for the live screen view.

App identity on Windows is the AppUserModelID for packaged apps and the lowercase executable
path otherwise, with a display name. The built-in blocked list gains Windows shells,
credential prompts, password managers and ace itself.

## Consequences

- A Windows CI lane (x64 and ARM64) runs install, typecheck and the process tests that cover
  the code changed here. Real-desktop checks (UIA, input, capture) run on a Windows VM or
  machine before release, as macOS computer use does.
- Windows-only code lives in `*-win32.ts` modules or `src/windows/` folders behind the
  existing platform seams, so POSIX paths stay readable.
- Without a signing certificate, SmartScreen warns on first run; the release plan needs one.
