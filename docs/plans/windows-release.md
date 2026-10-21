# Windows release plan

Goal: ace runs natively on Windows 10 1903+ and Windows 11, x64 and ARM64: daemon, CLI,
desktop app, terminals, every provider, browser use and computer use. Design:
[ADR 0092](../adr/0092-native-windows-daemon.md). Started 2026-10-20 from five code audits.

Today the Windows desktop app is a remote-only client. Nothing below it runs on Windows:
`bun install` fails, every provider spawn throws, terminals throw, release targets and service
registration have no win32 entry, and the Windows computer-use helper speaks a retired protocol.

## Workstreams

Each workstream is one branch off `main`, named `ace/windows-<stream>`. Windows-only code goes
in `*-win32.ts` files or `windows/` folders behind existing platform seams.

| # | Stream | Branch | Size |
|---|--------|--------|------|
| 1 | Workspace confinement addon, ripgrep inputs, command discovery, pinned git | `ace/windows-fs` | XL |
| 2 | Process ownership (Job Objects), CLI resolution, `.cmd` shims, env keys | `ace/windows-process` | XL |
| 3 | Terminal on ConPTY, workspace scripts, login terminals | `ace/windows-terminal` | L |
| 4 | Release targets, runtime staging, install.ps1, service, supervisor, updater | `ace/windows-release` | XL |
| 5 | Browser use and Use my Chrome | `ace/windows-browser` | L |
| 6 | Computer use engine (`--computer` on UI Automation) and daemon wiring | `ace/windows-computer` | XL |
| 7 | Desktop app: local daemon, packaging, OS integration, Windows UI fixes | `ace/windows-desktop` | L |
| 8 | Git, secure files, sign-in, provider installers, small daemon gaps | `ace/windows-daemon-misc` | L |
| 9 | CI lanes (x64, ARM64), `.gitattributes`, test fixtures | `ace/windows-ci` | M |

### 1. Workspace confinement (`ace/windows-fs`)

- `packages/workspace/build.ts` builds `descriptor.node` on win32 with MSVC from a Windows
  source next to `descriptor.c`: relative opens through `NtCreateFile(RootDirectory)` with
  `FILE_OPEN_REPARSE_POINT`, refuse reparse points, `uv_open_osfhandle` for fds, rename and
  delete by handle (`SetFileInformationByHandle`), directory listing by handle. Same JS
  binding schema; `pipe()` returns a CRT pipe pair.
- ripgrep reads `/dev/fd/N` today (`rg-search.ts`, `input-pipe.ts`); win32 needs stdin or
  another input path.
- `packages/commands/src/posix.ts` (openat/fdopendir via koffi) and
  `packages/git/src/pinned-process.ts` (fchdir) need win32 equivalents.

### 2. Process ownership (`ace/windows-process`)

- `provider-kit` `process.ts`, `process-interactive.ts`, `process-bytes.ts`,
  `process-owner.ts`, `process-identity.ts`, `process-inventory.ts`: Job Object ownership via
  koffi (kernel32), identity = pid + creation time, graceful stop then `TerminateJobObject`.
- `discovery/executable.ts`: PATHEXT, prefer `.exe`, never pick npm's extensionless shim,
  case-insensitive `Path`, `USERPROFILE` fallback. Run npm `.cmd` shims through their real
  target (`node <script>` or the vendor `.exe`) and use `cmd /d /s /c` with strict quoting only
  as a last resort (CVE-2024-27980).
- `windowsHide: true` everywhere the daemon spawns.
- `adapter-cursor/src/host-entry.ts` negative-pid kill; `provider-kit/src/sdk.ts` Cursor gate.
- `directory-processes.ts` (lsof/ps), preview port discovery (`preview/src/discovery.ts`).

### 3. Terminal (`ace/windows-terminal`)

- Windows backend for `packages/terminal` on node-pty ConPTY: shell `pwsh.exe` →
  `powershell.exe` → `%ComSpec%`; no `/bin/sh` wrapper, FIFO lease, group keeper, `ps` table
  or SIGSTOP. Process table through a Windows query.
- `workspace-runtime.ts` scripts and `account-management.ts` login terminals on win32.

### 4. Release, install, service, updates (`ace/windows-release`)

- `ReleaseTarget` + `win32-x64`, `win32-arm64` (protocol docs regenerate).
- Node runtime: pinned `node.exe` per arch; `runtime\node.exe` everywhere `bin/node` is assumed.
- Archive-relative paths always POSIX; ConPTY files staged; guardian skipped on win32.
- `current`/`previous` pointer files on win32; directory fsync skipped; files synced `r+`.
- `bin\ace.cmd` launcher; PATH via HKCU `Environment`.
- Service: per-user Task Scheduler logon task (`schtasks /Create /XML`), restart on failure.
- Supervisor stops the daemon through `POST /v1/stop`; daemon handles `SIGBREAK`/`SIGHUP`.
- Updater launched so the service stop cannot kill it; sharing-violation retries; best-effort
  prune of old releases.
- `install.ps1` (+ `.sha256`), npx wrapper, smoke test on win32.

### 5. Browser (`ace/windows-browser`)

- Security: `uploads.ts` containment uses `..` + `sep` (P0).
- Use my Chrome: `.cmd` native-host launcher, registry registration per vendor
  (Chrome, Chromium, Edge, Brave, Vivaldi), install/uninstall/query.
- ARM64: no Chrome for Testing build; fall back to native Chrome or Edge (App Paths).
  `detectChromium` learns `.exe`, Edge and App Paths.
- Chrome guardian on win32, kill timeout, EBUSY/EPERM retries, O_NOFOLLOW stand-in, Windows
  filename sanitising, `windowsHide`, Downloads folder from the shell, embedded-page platform.

### 6. Computer use (`ace/windows-computer`)

- `native/screen-helper-windows --computer`: ADR 0087's contract on stdio (`hello`, `apps`,
  `resolve`, `state`, `act`, `cancel`), UI Automation outline with stable int ids, one-shot
  window screenshot, act tiers (UIA pattern → window message → foreground SendInput after
  `activate`), settle on UIA events, clipboard paste with restore, person-first safety.
- Daemon: enable the engine on win32 (`apps/daemon/src/services/screen.ts`), `windowsHide`,
  graceful helper stop, Windows blocked-app list, platform-aware tool copy, settings copy,
  skill text.

### 7. Desktop app (`ace/windows-desktop`)

- `target.ts` allows a managed local daemon on win32; `paths.ts` `node.exe`; stage ConPTY
  files and the Node runtime; stop the daemon via `/v1/stop` then kill.
- AppUserModelID and toast activation; login item args; session-end handling; caption buttons
  vs header; tray `.ico`; AltGr in the terminal and shortcuts; "Show in Explorer" labels;
  per-arch installer names; per-user NSIS; Authenticode hooks (Azure Trusted Signing).
- Parking window occlusion on Windows.

### 8. Daemon gaps (`ace/windows-daemon-misc`)

- Git: `core.hooksPath=/dev/null` → an empty ace-owned directory; `C:/` vs `C:\` and case
  normalisation in worktree identity; `core.longpaths`; shorter worktree keys.
- 0600 checks (`secure-channel`, `mcp-server` private config) → owner-only ACL on win32.
- Sign-in page opener and `ace open` on win32; `blob-worker` sqlite DLL; `tls-identity`
  without `openssl`; global gitignore via `USERPROFILE`; `jq` in `cli/io.ts`.
- Provider installers on Windows (ADR 0069 amendment): official PowerShell/winget/npm methods,
  npm shim detection, npm prefix layout, no sudo hints.

### 9. CI (`ace/windows-ci`)

- `windows-latest` and `windows-11-arm` lanes: install, typecheck, lint, Rust helper build,
  and the process tests the Windows work touches.
- `.gitattributes` with `* text=auto eol=lf`.
- Portable fake-CLI fixtures for process tests (no shebang-only scripts).

## Test machine

Windows 11 ARM64 (26300) in VMware Fusion on the Mac: VM `Windows 11 ARM ace`, user `ace`,
OpenSSH with key `~/.ssh/ace_winvm`. ARM64 Windows also runs x64 builds under emulation, so
both architectures can be exercised. Real-desktop checks (UIA, input, capture, ConPTY,
Use my Chrome) run there before release.

## Release checklist

- [ ] All workstreams merged; Windows CI lanes green.
- [ ] VM run: install with `install.ps1`, service starts at logon, `ace status`, update and
      rollback, uninstall.
- [ ] VM run: Claude, Codex, OpenCode, Cursor and Pi threads; terminals; worktrees.
- [ ] VM run: browser_* tools on owned Chrome (x64) and Edge (ARM64); Use my Chrome.
- [ ] VM run: screen_apps / screen_state / screen_act on Notepad, Calculator, Explorer.
- [ ] Desktop installer x64 and ARM64; managed daemon; tray; notifications; deep links.
- [ ] Authenticode certificate chosen and wired (owner decision).
