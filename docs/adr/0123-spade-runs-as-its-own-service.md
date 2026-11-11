# 0123: Spade runs as its own service

Status: accepted. Date: 2026-11-11. Decision 6 amended by [ADR 0124](0124-desktop-keeps-spades-token.md). Decided by: the owner (2026-11-11: "Spade will not be hosted by
the daemon; it will be a long-running process on its own"). Supersedes
[ADR 0121](0121-the-daemon-hosts-spade.md) on when Spade runs, its environment, readiness, stop and
restart, and its credentials; keeps 0121's host thread and its `spade.*` family, as decision 8
says. Builds on [ADR 0041](0041-packaging-and-distribution.md) (service and updater),
[ADR 0091](0091-desktop-auto-update.md), [ADR 0095](0095-native-windows-daemon.md),
[ADR 0113](0113-remote-updates.md), [ADR 0119](0119-spade-endpoint-keys.md) and
[ADR 0122](0122-outside-mcp-clients.md).

## Context

Under ADR 0121 the daemon starts `spade-server` as a child process, gives it a fresh MCP bearer
for each run, restarts it after a crash and forwards every client request to it (`spade.http`,
`spade.live`). So whenever the daemon stops, Spade stops with it: a daemon update, crash or
restart cuts off Spade's running replies (they reopen as interrupted), loses its background jobs
(reported as unknown outcome), revokes its ace credential, and leaves every app unable to reach
it. Spade is meant to be always on, and the daemon restarts far more often than Spade needs to:
every daemon release, every crash, every `ace update apply`.

The daemon itself already runs as a per-user service with a signed, draining updater
(ADR 0041, 0095, 0113), and Spade is one static Rust binary with no runtime, so running it the
same way costs little.

## Options considered

- **Keep Spade as the daemon's child (ADR 0121).** Simplest, but couples Spade's uptime to the
  daemon's, which is the problem.
- **Run Spade inside the desktop app.** Stops when the app quits; not always on, and absent on
  standalone daemon machines.
- **A separate service with its own release channel and updater.** Independent, but two signing,
  release and update paths to keep correct; versions could drift apart.
- **A separate service that apps still reach only through the daemon.** Spade keeps working, but
  nobody can see or steer it while the daemon is down.
- **Chosen:** a separate per-user service, shipped and updated with ace's existing release and
  updater, that the desktop app talks to directly, with the daemon as a client of neither
  lifecycle: Spade uses ace the way any client does, and copes when ace is away.

## Decision

1. **Spade is its own per-user service.** It is registered beside the daemon, never under it:
   launchd `dev.ace.next.spade` (RunAtLoad, KeepAlive, throttled like the daemon's), systemd
   `ace-next-spade.service` (`--user`, `Restart=on-failure`), and on Windows a per-user Task
   Scheduler task `ace-next-spade` with a logon trigger and restart on failure, for the same
   reason the daemon is one (ADR 0095: it must run in the person's session, where the keychain
   is). Plans, rendering and validation live in `@ace/service`, with the same launcher rules as
   the daemon's. The daemon starting, stopping, crashing or updating never starts or stops Spade.

2. **Turning Spade on registers the service; off removes it.** The `spade.enabled` setting stays
   the one switch: the desktop app (or `ace spade on|off`) registers or removes the service and
   writes the setting. With `DISABLE_SPADE=1` builds (#1782) nothing is registered. Spade's data
   folder (`<ACE_HOME>/spade`), its single-instance lock (exit code 3), `server.json` and its
   0600 token file are unchanged.

3. **One release carries both programs.** `spade-server` for each target ships inside the desktop
   app and the standalone archives, at ace's version, covered by the same signed manifest and the
   same electron-updater feed. On install it is copied out to
   `<ACE_HOME>/releases/spade/<version>/`, behind a `current` pointer that the service runs, so
   replacing the app bundle never pulls the binary out from under a running Spade.

4. **Updates swap one program at a time, and Spade's swap pauses rather than cuts.** Every
   updater path (the desktop restart, `ace update apply`, ADR 0113's machine update) installs
   both and never stops both at once. Spade's swap mirrors ADR 0041's:
   - `POST /v1/maintenance` on Spade closes admission: new messages are still stored (and answered
     after the restart); no new turn starts.
   - A running model step is allowed to finish (up to 30 s). Each open turn is then recorded as
     paused (`turn_paused`), not interrupted, and resumes by itself when Spade starts, from its
     stored events, as turns already do.
   - In `idle` mode (ADR 0113) the swap waits for background jobs; in `now` mode a job still
     running is reported as Spade reports a lost job today ("unknown outcome"), never as not run.
   - Spade's SQLite is snapshotted with the backup API and the candidate migrates and checks the
     copy first; any failure keeps the old version running and says why.
   - The swap is the copy, the `current` flip and a service restart: about a second of downtime.

5. **Each side accepts the other's previous version.** Spade's HTTP API carries its version in
   `/health` and `server.json`; the MCP contract with the daemon is versioned as today. Each side
   accepts the previous release's shapes and keeps unknown fields and events, so the two programs
   can be updated in either order and a remote update can move one at a time.

6. **The desktop app talks to Spade directly.** Its main process reads `server.json` and the token
   file (same user) and gives the renderer Spade's address and token through the preload bridge;
   the renderer uses Spade's own HTTP API and live stream. No daemon in the path: Spade stays
   visible and usable from the desktop app while the daemon is down, and uploads and images take
   one request instead of base64 parts over the daemon socket.

7. **Spade reaches ace as a client with a durable grant, and copes without it.**
   - Turning Spade on makes a `spade` grant in the daemon, stored, listed and revoked like
     ADR 0122's grants (it survives daemon restarts), and bound to Spade's host thread, so its
     lease is still the provider-session tool set ADR 0121 gives it. Turning Spade off revokes
     it; the person can also revoke it, which stops Spade's use of ace until it is turned on again.
   - The daemon hands the grant's token to Spade over Spade's local API (authenticated with
     Spade's token file); Spade keeps it in the OS keychain beside its endpoint keys (ADR 0119),
     never in its database or logs. `SPADE_ACE_*` environment variables and the per-run bearer
     are retired.
   - Spade finds the daemon from the daemon's own discovery file and reconnects with backoff.
     While the daemon is down, ace's tools are simply absent (they are deferred and listed live
     already); everything else (chat, models, search, `web_fetch`, background jobs) keeps working.

8. **What stays from ADR 0121.** The host thread (one per machine, hidden, healing, its access
   ceiling and default provider, children that are ordinary visible threads), now made when the
   grant is made rather than at launch; the MCP listing and protocol headers; and the `spade.*`
   family, which becomes a forwarder only. It reads Spade's state from `server.json` and `/health`
   instead of owning a child process, and it remains the path for every client that is not the
   local desktop app: the web app in a browser, the iPhone, other machines.

9. **Remote devices reach Spade through the daemon until a direct path exists.** A direct remote
   path (Spade with its own Noise key among the machine's paths, ADR 0114, and the machine's
   device trust shared with it) needs Noise and pairing in Rust and is its own decision, to be
   recorded before it is built. Until then a remote device can't reach Spade while that machine's
   daemon is down; Spade keeps working, and the device catches up from stored events when the
   daemon is back.

## Consequences

- Spade's uptime no longer depends on the daemon's. Daemon releases, crashes and restarts no
  longer interrupt replies, lose background jobs or revoke Spade's access to ace.
- Planned Spade restarts pause and resume turns instead of interrupting them.
- Two services to register, update and diagnose per machine; `ace doctor` and the release checks
  must cover both. Windows needs a second Task Scheduler task.
- Uploads from the desktop app stop paying for base64 parts through the daemon.
- The daemon loses its Spade supervisor code (`spade/host.ts`, its runtime and backoff) and gains a
  grant kind and a forwarder that reads files instead of owning a process.
- Accepted for now: remote devices lose Spade while the daemon is down (decision 9).

## Tests

- `@ace/service` plan tests render and validate Spade's plist, unit and task, and refuse a
  launcher that differs from the expected program, as the daemon's do.
- A process test stops and restarts the daemon while Spade streams a reply: the reply finishes,
  and Spade's tool list empties and refills.
- An updater test swaps Spade with a turn open: the turn is recorded paused and finishes after the
  restart with no `reply_interrupted`.
- A grant test: the `spade` grant survives a daemon restart, works only for the host thread's
  lease, and stops working once revoked.
- A desktop test reaches Spade through the preload bridge with the daemon stopped.
