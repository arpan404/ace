# Real-data smoke

Run this after a merge batch, before installing a desktop build:

```sh
bun run smoke:real
bun run smoke:real --out /tmp/ace-smoke/review --home-source ~/.ace-next
bun run smoke:real --max-threads 40 --scan-timeout-ms 120000
```

Requires Node 24+, Bun, macOS `sandbox-exec`, `/usr/bin/sqlite3`, and Playwright's
headless Chromium. Use the browser installed for `tools/web-e2e`. The runner
never installs a browser or a provider. Real mode requires macOS filesystem
protection and fails on other hosts.

The command exits 1 for a failed check or an incomplete journey. It writes
`report.json`, `summary.md`, and numbered PNGs under `--out`, defaulting to
`/tmp/ace-smoke/<short-sha>/`. It checkpoints the report after each step.
The short summary groups repeated failures; JSON keeps every step and screenshot
reference. Reports and screenshots stay local and can contain personal conversation
content. Known credential patterns and the scratch daemon token are redacted,
including in screenshots. No traces, storage dumps, provider output, or daemon
logs are retained.

## Source isolation

The only ace source files opened are `settings.json` and these SQLite stores:

- `events.sqlite`
- `models.sqlite`
- `accounts.sqlite`
- `automations.sqlite`
- `onboarding.sqlite`
- `history/index.sqlite`

This is an explicit allowlist, with no directory crawl. Symlinked state files and
redirected history directories are refused. SQLite's backup API includes committed
WAL rows. The copy process cannot write outside scratch, so SQLite cannot create
sidecars in the source. A closed WAL store can require immutable mode to avoid
sidecars, as described in [SQLite's read-only WAL documentation](https://www.sqlite.org/wal.html#read_only_databases).
That fallback uses `sqlite3 .backup` only when no WAL exists before and after,
and the source file's inode, size, mtime and ctime stay unchanged. An unreadable
live WAL fails the run rather than weakening protection.

The tool does not open or copy the source daemon token, locks, endpoint, provider
instance homes, Chromium/browser profiles, auth files, keychains or credential
stores. Nothing is written to the source. The scratch daemon creates its own token,
which travels only through local IPC and the local authenticated connection.

Real mode runs the current checkout's actual daemon composition, engine, discovery,
history worker and model worker. Merge `origin/main` before running it. The web app
is built from that same checkout into scratch and served on an ephemeral loopback
port. The daemon also binds an ephemeral port; 4242 is rejected. Headless Chromium
uses a fresh temporary profile and 1440×900 dark viewport.

The daemon and its CLI children can write only in scratch. The live ace home is
also unreadable to the daemon after the copy. Registered project contents are
unreadable except this checkout's own source code; workspace path metadata can
still identify a saved session. Real CLI discovery and the history importer see
the owner's normal Claude, Codex, OpenCode and Pi homes read-only. ace asks the
installed CLI for metadata and auth readiness; the tool never reads its credentials.
CLI probes that need to write to their normal profiles can fail under this protection.
Their warnings fail the smoke run and must be distinguished from UI bugs.

Copied settings disable automations and remote access. The daemon's session-context
boundary refuses every provider conversation session, including automatic restart
recovery. A separate loopback proxy parses every client frame and permits only
reviewed reads (including the scratch plugin catalog and attachment reads), metadata
refresh, scan, scratch import, draft allocation/release, scratch notification preferences,
presence and read markers. Prompts, continuation, login/logout, installation,
settings writes, project changes and screen control are refused before forwarding.
Unknown future messages are refused too. Browser HTTP access is restricted to the
local web app and the proxy's two read-only status/device routes.

## Journey and checks

The tour waits on catalog replies and UI readiness, then captures the sidebar and
walks its virtual rows up to the thread cap. It opens each selected thread, chooses
a stored project with importable history, visits New thread and Show all past
sessions, waits for a fresh scan, and imports one session into scratch. It checks
every model source tab, Providers and every linked provider page, Usage & accounts,
Skills and `/` in separate cold browser contexts, all Activity tabs, every Settings
page including the theme editor, and a nonexistent thread URL representing a
previously deleted thread. No thread is deleted for this journey.

Scans have the configurable time budget above; UI waits have a 15-second backstop.
Each step has a duration, and JSON records cold-start duration, elapsed time to
catalog readiness, scan duration, and each thread-open duration. A failure keeps
its screenshot and the tour continues to independent steps.

Checks reject console errors, uncaught page errors, visible error surfaces, wrapper
tags, ANSI escapes, omitted-object markers, serialized JSON prose, raw event
prefixes, raw model display labels, bare Unavailable labels, sent New thread titles,
`.local` hostnames, and known provider icons without brand paths. Code examples
are excluded from JSON prose checks. Current-turn status and matching queued text
are checked for contradictions; historical stopped turns alone do not contradict
current work. Catalog-dependent empty states fail after readiness.

Daemon warnings and errors fail, with one allowlist entry: a warning with
`code=no_models` whose source is Copilot. Fatal process/worker output, daemon exit,
page crash and idle daemon RSS above 256 MiB fail. Logs are streamed from scratch
after shutdown and then deleted. Servers and their process groups stop in cleanup;
the scratch home and web build are removed on success or failure.

## Fixture mode and normal tests

```sh
bun run smoke:real --fixture --out /tmp/ace-smoke/fixture
```

Fixture mode serves the real app in its existing fake-daemon mode and runs the
same tour, DOM collection, redaction and presentation checks. It never copies
owner state or starts real CLIs. Its synthetic saved sessions support scan/import.
Messy native fixtures include a wrapper-tag title, raw notice and JSON prose, plus
the repo's existing vanished-model and restart fixtures. **Fixture mode is expected
to exit 1** and report those deliberately visible defects. It is a check of the
checker, not a passing sample-data health claim.

Normal Vitest runs include the tests in `src/`: visible defects and clean controls,
JSON prose versus code, real fake-daemon browser rendering, screenshot redaction,
network refusal of prompts/auth/install, live-WAL and closed-WAL backups, symlink
refusal and macOS filesystem protection. These tests assert behaviour and use no
wall-clock performance assertions. `smoke:real` itself is not part of `bun run check`.

For targeted worker verification, run each test file separately with the unit or
process project and bounded workers. The orchestrator owns the full merge gate.
