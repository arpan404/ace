# 0091: Windows process launch and supervision

Date: 2026-10-21. Status: proposed. Implements issue #1203.

## Context

Agent installs from the registry produce valid Windows paths, but ace cannot
launch agent CLIs on Windows. `spawnOwned` throws on `win32`, `findExecutable`
ignores `PATHEXT`, npm `bin` scripts cannot run through a shebang, Node refuses
to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980), and there are no POSIX
process groups to own. A Job Object owner would need native code; ADR 0068
already uses `taskkill /PID /T /F` as the Windows tree-stop request for Git
helpers. No Windows host is available to the implementer, so every Windows
branch is testable by injecting the platform (and env/filesystem) at the
boundary.

## Decision

- **Lookup.** `findExecutable` takes the platform. On Windows it matches `PATH`
  and `PATHEXT` case-insensitively, tries each `PATHEXT` extension (default
  `.COM;.EXE;.BAT;.CMD`) for extensionless commands, splits `PATH` on `;`, and
  treats existence as runnable. POSIX lookup is unchanged.
- **npm entrypoints.** `bindLocal` takes the platform. On Windows a
  `.js`/`.cjs`/`.mjs` entrypoint binds as `node <script>` with the `node`
  resolved from `PATH`. The digest still pins the script, so script changes need
  a new approval while `node` upgrades keep theirs.
- **Batch entrypoints.** One pure helper wraps a `.cmd`/`.bat` command line as
  `cmd.exe /d /s /c "..."`, spawned with `windowsVerbatimArguments` so Node
  does not re-quote the line. Arguments are MSVCRT-quoted for the target
  parser, then cmd metacharacters are `^`-escaped — twice for `.cmd`/`.bat`,
  whose `%*` forwarding parses the line a second time. Other commands pass
  through. Both supervised spawn paths apply it on Windows.
- **Supervision.** Windows processes spawn non-detached with `windowsHide` and
  keep the `RawSupervisedProcess` contract (exit reasons, output limits, stop
  grace). Graceful stop is `taskkill /pid /T`, escalating to `/T /F` after the
  grace; natural exit, spawn failure and output-limit breaches use `/T /F`.
  Both are spawned without a shell. The killer is injectable; POSIX paths keep
  their behaviour. Interactive PTY ownership stays POSIX-only.

## Consequences

- Provider CLIs, model discovery and registry installs launch on Windows
  through the same public spawn APIs, with no caller changes.
- `taskkill` is best-effort, like the ADR 0068 request: orphans are possible if
  the daemon itself is killed hard, and a process that breaks away from the
  tree is not contained the way a Job Object would contain it.
- Byte-stream `ownedCwd` reaping is skipped on Windows (no `lsof` or `/proc`);
  the tree stop is the only reaper there.

## Follow-ups (2026-10-21)

- **Interactive login works on Windows.** `spawnInteractive` no longer throws
  on `win32`. The Windows branch spawns non-detached with the console kept
  visible (`windowsHide: false`), routes `.cmd`/`.bat` entrypoints through
  the same `cmd.exe` wrapper, and stops the tree with `taskkill /T`,
  escalating to `/T /F`. Platform and killer stay injectable, so every
  branch is covered without a Windows host
  (`process-interactive-windows.process.test.ts`). No ConPTY gap remains:
  interactive ownership never allocated a PTY on POSIX either; it inherits
  the terminal.
- **Job Object containment without native code.** A per-process
  kill-on-close job is created through `koffi` (`windows-job.ts`), which is
  already a dependency and already calls `kernel32.dll` elsewhere. No
  compiler, driver or shipped binary is involved. The job handle is held for
  the ownership lifetime and closed on release, so a hard-killed daemon
  still contains its trees: the kernel kills job members when the last
  handle closes. Assignment races the child's first milliseconds — a
  grandchild spawned before the assign escapes the job — and a denied join
  (nested-job conflict, access rights) falls back silently to the taskkill
  tree stop, which remains the graceful-stop and spawn-failure path. The
  PowerShell `Add-Type` alternative was rejected: runtime-compiled C#
  breaks under Constrained Language Mode and cannot be verified without a
  Windows host.
- **Exit destroy is explicit per owner.** `registerGroup` takes an optional
  synchronous destroy; the `exit` safety net and the journal-failure path
  call it instead of assuming process-group signals. The default preserves
  the existing `killGroup` routing (which already ends Windows trees), so
  the injected-platform branches and their tests use the same tree stop the
  real platform would. A retained Windows stop now releases ownership on
  completion, matching the POSIX path.
- **Still POSIX-only.** Process-group signals, the `ProcessInventory`
  restart reaper (kernel identity, liveness and kill are all POSIX) and
  `ownedCwd` directory reaping have no Windows equivalent. A daemon that
  exits gracefully stops its trees; a daemon killed hard relies on the jobs.
  No Windows host was reachable for live verification (macOS implementer,
  no provisioned infra); the manual checklist is
  `docs/verification/windows-launch-checklist.md`.
