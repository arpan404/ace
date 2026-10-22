# 0092: CLI triage and bounded doctor repairs

Date: 2026-10-20. Updated 2026-10-21. Status: accepted.

## Context

Triage is what a person reaches for when ace is broken: the app crashes or won't open,
the daemon is down or stuck, settings are wrong. A triage screen inside the app, or one
served by the daemon, would be unavailable exactly when it is needed.

A first version asked the person to pick a template and describe the problem, then
pasted a long generated prompt into an agent. That front-loaded the wrong work: the
person had to diagnose before anyone helped, and the agent got a fixed snapshot instead
of a way to investigate.

## Decision

### `ace triage` hands a coding agent a playbook and the facts

`ace triage` asks nothing up front. It writes two files to a fresh temporary folder,
which works even when the ace folder is broken:

- `FACTS.md`: this computer's facts, collected best-effort. These are the ace CLI
  version, OS and Node, where `ace` was launched from, whether the daemon is running,
  installed agent CLIs and their versions, the data folder, log, settings and database
  paths, a source-cache folder for cloning ace, and the files the agent must never open
  (daemon token, TLS, account homes, browser profiles, MCP enrollments). It also
  carries the last 24 hours of warnings and errors (grouped, with counts and one
  shortened sample) and anything that couldn't be checked.
- `PLAYBOOK.md`: how to investigate an ace problem. Ask the person what happened and
  where, establish which build and computer it happened on, gather evidence from logs,
  `ace doctor`, the daemon, provider CLIs and read-only databases, read the source at the
  matching release tag, search arpan404/ace issues and releases, then let the person
  choose between fixing it now, writing an issue, both or neither. Local fixes are
  settings, restarts, reinstalls or sign-ins, run only with consent; the installed ace
  is never patched. Issues follow fixed sections and are posted only after the person
  approves the complete text.

The person picks an installed Claude Code, Codex, Cursor CLI or OpenCode. The agent
starts in the triage folder, so it can't wander into an unrelated project, with a
single line: read the playbook and follow it. A one-line argument survives any shell
or argv limit; the detail lives in files. `--print` writes the playbook and facts to
stdout for pasting into any agent; `--json` lists the files.

Logs, databases, issues and web pages are data written by others; the playbook tells
the agent never to follow instructions found there. Log text is redacted for
secret-looking environment values, ids and emails before it reaches the facts file.
Home paths become `~`, since the agent runs on the same computer and needs them.

### Triage depends on nothing that is broken when it is needed

There is no app triage route or provider-launch operation in diagnostics, and none
may be added.

- `cli.ts` routes `ace triage` and `ace doctor` to a small entry point before the rest
  of the command table loads, so a module that fails to load elsewhere can't block them.
- Triage never connects to the daemon. It reads files directly: the log tail, the
  daemon's run state and the data folder listing.
- Invalid `ACE_*` settings don't stop it. It drops them, keeps a valid `ACE_HOME` (or
  falls back to the default folder) and records what it ignored.
- Every probe is best-effort. A failed read or CLI probe becomes a line under "Couldn't
  check" instead of an error; in a broken install those failures are often the clue.
- `TriageProvider` lives in `@ace/diagnostics/triage`, not the wire protocol, because
  no client or daemon request carries it.

### Launching the agent

The argument vector goes straight to the installed executable, never through a shell:
`--` and then the line, or OpenCode's `--prompt=` because OpenCode reads a positional
argument as its start folder. Cursor resolves `cursor-agent` before the generic
`agent`. While the agent runs, ace ignores SIGINT so Ctrl-C interrupts the agent's turn
rather than killing ace, forwards SIGTERM and SIGHUP, and exits with the agent's code.
The agent keeps its own login, permissions and session history.

### `ace doctor` checks, then offers repairs

Doctor's checks come from feature modules under `apps/daemon/src/doctor/`: install and
versions, Linux host repairs, daemon health, recent errors, storage, accounts, computer use
and remote access, on top of the base setup checks (which include Linux host checks, ace's
browser engine and Cursor's sandbox on Linux). Each feature gets one context (config, clock,
platform, the daemon's run state and a daemon client that resolves undefined when the
daemon is down), so it works offline and is tested against temp folders and fakes. A
feature may offer repairs with ids `<feature>.<name>`; chosen repairs go to the feature
that offered them, and a repair that throws is reported as failed. Planning may read the
machine but never changes it, since report text can't be run. Report text is
redacted for secret-looking environment values only, so versions and paths stay readable.

Doctor runs its health checks (Node, provider CLIs and logins, git, node-pty,
Chromium, disk, database integrity and space, port, folder access) and then lists the
repairs the report calls for:

- **Fix ace folder access**: create missing ace and log folders and make them
  owner-only. Links, non-directories and folders owned by someone else are refused.
- **Reclaim database space**: when integrity passes and reusable pages or the WAL cross
  the thresholds. It asks the running local daemon to run its journaled incremental
  compaction and WAL checkpoint behind the existing storage fence, and reports
  before → after sizes. With no daemon running it is listed as blocked, reported as
  skipped under `--fix`, and no offline database is opened for writes. Legacy
  `auto_vacuum=NONE` files keep their reusable pages; shrinking them needs a
  rowid-preserving migration because a full VACUUM could renumber row IDs referenced by
  stored frames and receipts. Corruption stays a failure needing a backup restore.
- **Install ace's AppArmor profiles** and **Install the libraries ace's browser needs**
  (Linux, ADR 0093): through sudo, which asks for the person's password. The plan shows the
  exact commands with this machine's paths, so `--dry-run` is how to see or copy them; the
  report the app and support bundles show only points at `--fix`.

Most checks get 5 seconds; a hung CLI probe shouldn't stall the report. Starting ace's
browser engine (`--version`, then a headless start, each bounded at 10 seconds) gets 25. The database
integrity check reads the whole file, so its budget scales with size: 30 seconds plus
20 seconds per GiB, capped at 15 minutes. A full check measured about 1.7 s per GiB on a
warm SSD (10 s for a 6 GiB database), so the budget leaves about ten times that for cold
caches and slow disks. The SQLite child process gets the same budget. A check that runs
out of time reports that it didn't finish, never that the database is corrupt, and space
is not reclaimed until integrity is confirmed. The app's Checks dialog waits 16 minutes,
longer than the largest budget. The CLI shows a spinner that names the database size.

In a terminal the person picks repairs from a checklist with the recommended ones
selected. `--fix` runs the recommended ones without asking, `--dry-run` changes nothing,
and without a terminal doctor only reports. Checks run again after repairs; failures
keep a nonzero exit status. If findings remain, doctor offers to start triage with them
in the facts file. While ace's own daemon runs it holds the loopback port, so the CLI
drops that expected port warning.

Settings > Advanced keeps using the folder repairs through an admin-only diagnostics
operation, with authority checked again before writes.
