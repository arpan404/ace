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
