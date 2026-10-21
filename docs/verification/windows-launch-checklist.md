# Windows launch manual checklist

No Windows host was available to the implementer (macOS only; no provisioned
infra), so the Windows branches are covered by injected-platform tests and this
checklist is the remaining gate before a Windows release. See ADR 0091.

## Environment

- Windows 10/11 x64, Node 24+, bun, git; repo checkout with `bun install`.
- `where taskkill cmd.exe node` all resolve.
- One npm-distributed agent CLI installed and signed in (for example `codex`),
  plus one `.cmd` entrypoint on `PATH` (for example Cursor's `cursor-agent.cmd`
  from the ACP registry, `official:cursor`).

## A. npm CLI: install, launch, stop

1. `node packages/provider-kit/src/doctor.ts` lists the CLI under installed
   providers with a version. This exercises `PATHEXT` lookup and the
   version/auth probes through the Windows supervised-spawn path.
2. Start the daemon and open a session with the npm CLI agent. It streams
   output and answers a prompt.
3. Stop the session from the client. The agent process and any dev server it
   started disappear from Task Manager (details tab, no wrappers remain).
4. Shut the daemon down gracefully (SIGINT/Ctrl+C). No agent processes remain.
5. Start the daemon again, open a session, then hard-kill the daemon from
   Task Manager (End task). The agent tree dies with it: the kill-on-close
   Job Object is the containment. Record any survivor's image name and PID.

## B. `.cmd` entrypoint: quoting, launch, stop

1. `where cursor-agent` resolves to the `.cmd` shim.
2. Run the ACP login for `official:cursor` (`provider.login.start`). The
   browser handoff opens and the console window stays visible; credential
   entry is never captured.
3. From a session, send an argument set with a space, an ampersand and a
   percent sign through the agent command line. The agent receives them
   intact (the `cmd.exe /d /s /c` line is double `^`-escaped).
4. Stop the session. `cmd.exe`, the shim and the agent are all gone from
   Task Manager.

## Evidence to attach

- `doctor` output (installed/auth/version rows for both CLIs).
- Task Manager process lists (or `tasklist` captures) after steps A3, A4,
  A5 and B4, plus the exact installer/CLI versions.
- Any survivor or quoting failure: command line from `wmic process where
"name='cmd.exe'" get commandline` and the daemon log tail.
