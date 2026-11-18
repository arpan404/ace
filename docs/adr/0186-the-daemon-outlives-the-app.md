# 0186: Quitting the app leaves its daemon running

Date: 2026-11-18. Status: accepted. Decided by: the owner (quit closes the app only), the build of
this ADR's PR (how). Amends [ADR 0054](0054-desktop-shell.md), "Process model": its quit rule.

## Context

ADR 0054 had the app stop the daemon it started on every quit. Each quit and reopen then booted
the daemon from scratch: on a large home that is seconds before the page has a daemon, and any
agent at work stopped with the app. A daemon started by the CLI or the login service already
outlived the app; only the app's own did not.

## Decision

1. **A plain quit closes the app only.** Cmd+Q, the app menu's and the tray's Quit, and the last
   window closing (when the app is not kept in the background) stop the browser backend and the
   app's other helpers, as before, and leave the daemon the app started running with its agents.
2. **The daemon is started to outlive the app.** It is spawned detached: its own process group
   and session on macOS and Linux, outside the job that would end it with the app on Windows. Its
   stdout and stderr go to `ACE_HOME/daemon-start.log`, the file `ace open` already uses, rotated
   at each start (`@ace/service/launch-log`). Nothing is piped into the app, so no pipe breaks
   under it when the app exits. Its records go to its own `logs/ace.jsonl`, redacted and capped as
   always. Its stdin carries only the login shell's PATH (PR #2293); when the app quits first,
   stdin ends and the daemon asks the login shell itself.
3. **The app records which daemon is its own.** Once the daemon it spawned holds its home's lock,
   the app writes `ACE_HOME/app-daemon.json`: the pid and the per-run id from `daemon-lock`, the
   app version that started it, and when. A later launch that finds a daemon answering its
   authenticated `/v1/status` treats it as its own only when that record's pid and run id are the
   ones in the current lock. A daemon the CLI or the login service started never matches, so it
   stays someone else's: used, never stopped or replaced. A daemon still starting when the app
   quits, before it took the lock, is stopped instead, since no later launch could tell it is the
   app's.
4. **The next launch adopts it.** Health checks, restart when unresponsive, repair, update drains
   and stops all apply to an adopted daemon as to one this launch spawned. It is not the app's
   child any more, so its exit is noticed by looking for its pid every 250 ms, and a signal is
   sent only while the home's lock still names that pid. On Windows a stop is `POST /v1/stop`
   first, as for a spawned daemon.
5. **"Quit ace completely"** in the app menu (macOS: the ace menu; Windows and Linux: File) and
   in the tray stops the daemon the app started, adopted or not, with the same SIGTERM, grace and
   SIGKILL as before, then quits.
6. **Updates still replace the daemon.** Restart to update drains and stops the app's daemon
   before installing, as before, and so does a quit while a downloaded update waits to install
   on quit. A launch that finds the app's own daemon from another app version (a new app copied
   in while the old daemon ran) closes its admission with the update's hold (ADR 0041), waits for
   running work up to the update drain's bound (5 minutes), stops it whether or not work remains,
   and starts the bundled daemon. The startup screen says it is waiting for the previous ace to
   close. An older daemon never serves a newer app. A CLI or login-service daemon of another
   version is left as it is, as before: the app uses it.

## What works with no app open

The daemon keeps running agents, automations, remote and paired access. Without the app:

- the embedded browser is gone: the browser backend closes on every quit, as it did, and the
  daemon pauses those pages or moves them to headless (`browser.backendLoss`); it reconnects when
  the app opens;
- desktop notifications cannot show; threads that came to need the person meanwhile come back as
  one catch-up alert when the app reconnects, and phone push is unaffected;
- the app's update report is withdrawn on quit, as before;
- Spade is its own service (ADR 0123) and the token stays in the app's main process (ADR 0124);
  neither needs the daemon to have an app.

## Consequences

- Reopening the app hands the page a running daemon in milliseconds instead of a fresh start.
- A daemon now runs with no app open until the person chooses Quit ace completely, restarts
  the computer, or `ace stop` stops it. The tray, where shown, is the visible sign only while the
  app runs.
- A failure the daemon prints before its own log opens is in `daemon-start.log`, no longer in the
  desktop log. The supervisor's own decisions, and the exit codes of a daemon this launch spawned,
  are still in the desktop log. An adopted daemon's exit carries no code, since only a parent
  sees it.
- Windows and Linux still keep a windowless app running while agents work (`os/lifetime.ts`): the
  tray and notifications are why, even though quitting no longer stops the agents.

## Tests

`supervisor-ownership.test.ts`: quit leaves the app-started daemon running and the next launch
adopts it without spawning; Quit ace completely stops it; an adopted daemon that stops answering
is restarted; an app-owned daemon of another version is replaced after drain, and at the bound
even with work left; a CLI daemon is never adopted, even with an old record on file. The pure
`foundDaemon` rule is tested on its inputs. `spawn.process.test.ts`: the daemon keeps running and
logging after the process that spawned it exits, in its own process group, with stdin closed.
