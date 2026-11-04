# 0113: Update machines from any client

Status: accepted. Date: 2026-11-04. Amends [ADR 0091](0091-desktop-auto-update.md), where a
desktop app's update status was read-only for other clients, and builds on
[ADR 0041](0041-packaging-and-distribution.md)'s standalone updater.

## Context

The owner runs ace on about ten machines: Macs, Linux and Windows, some with the desktop app,
some as standalone daemons from install.sh or install.ps1. When a release comes out, each one
had to be updated on that computer: Restart in the app, or `ace update apply` in a terminal. A
client could read a desktop app's update status (`appUpdate.request`) but not act on it, and
had nothing at all for standalone daemons.

An update restarts the daemon, so it must never silently kill agents (AGENTS.md priority 1),
and an update that fails must leave the old version running and say why.

## Decision

**One status per machine.** `machineUpdate.request` with `status` (read scope) returns
`MachineUpdate` and keeps the socket told of changes with `machineUpdate.changed`. It says what
the machine runs (version, platform, architecture), what kind of install it is (`desktop`,
`standalone`, `source`), the release on offer for its platform, the state (`none`, `available`,
`waiting`, `downloading`, `ready`, `installing`, `updated`, `failed`), how many threads are
working or waiting on a person, the request being carried out and how the last update ended.
States, block reasons and errors are open strings, so an older client shows a newer daemon's
values instead of failing.

- A desktop install takes the facts from the app's own report (`PUT /v1/app-update`), which
  now also carries the updater's state, progress, error and whether it installs in place.
- A standalone daemon runs `ace update check` (the signed manifest for its own target and
  channel) a minute after it starts, then daily, and on an administrator's `check`, at most
  once a minute. That is no more often than the daily automatic update already asks.
- The install kind is read off the daemon's entry script: the desktop build's
  `desktop-app.json` beside it, or a `releases/<version>-<target>/` folder. Anything else is a
  checkout and is never updated this way.

**Who may.** `check`, `start` and `cancel` need admin scope: a device paired as Administrator,
or an account device that passed the machine code (ADR 0111). A read-only device sees the
status and nothing else. Linked machines have no machine-call op for updates (ADR 0105), so no
agent on another machine can update this one. Adding such an op would need its own capability,
off by default.

**The request.** `start` names the mode and the release the person saw. The daemon refuses it
when the install can't take it (`blocked`), when the release on offer isn't that one (`stale`),
or, for `now`, when more agents work than the person confirmed (`confirm`, with the current
count). An accepted request is written to `machine-update.json` in the data directory before
anything else happens, so it survives restarts.

- `idle` (the default) waits until no thread works or waits on a person, then installs.
- `now` installs at once. Running turns stop the way a quit stops them, and the new version
  continues them after it starts (ADR 0098).
- A request for a release that is no longer the one on offer expires with a sentence saying
  which release is out now. Nothing newer is ever installed unseen.

One pure function decides each step (`nextStep` in `apps/daemon/src/machine-update/rules.ts`).
`MachineUpdates` gathers the facts, carries out the step and records each install before it
begins. The daemon that starts afterwards settles that install by the version it runs: the
target means it worked; anything else is a failure with the updater's reason, or "didn't
finish" when there is none.

**Desktop installs.** The daemon tells its app what to do in the reply to the report the app
already sends every 20 seconds (`AppUpdateReply.instruction`). No new connection or port is
involved, and the app hears each instruction id once.

- `download` fetches the release.
- `install` with `idle` runs the app's `ace update apply` path: drain running agents (up to
  five minutes), stop the daemon, `quitAndInstall`. If work outlasts the drain, the request
  waits for the next idle.
- `install` with `now` runs the confirmed Restart path: stop the daemon, then `quitAndInstall`.
- An app that doesn't start installing within 90 seconds is reported as a failure. The old
  version keeps running.
- When the app isn't running, the status says so (`app-closed`). The request is refused,
  rather than starting a GUI app on a computer nobody may be at, or updating only the bundled
  daemon, which the next app launch would replace anyway.
- An install that can't replace itself (a deb or tar.gz on Linux, an ad-hoc signed Mac app)
  reports `release-page` with the release's URL. An AppImage, a Developer ID signed Mac app and
  Windows' per-user NSIS install update in place.
- An app from before this ADR sends no updater state and never reads instructions. It reports
  `unknown`: it needs one update by hand.

**Standalone daemons.** The daemon launches the release's own CLI, `node ace.mjs update apply
--drain --outcome` for `idle` or `--interrupt --outcome` for `now`. It runs outside the
service's process tree, as the supervisor's daily update does (`planUpdateLaunch`). The updater
keeps every ADR 0041 guarantee: signature and checksum, database snapshots, the journal,
rollback when the new version isn't healthy, and the service manager restart. `--interrupt`
skips only the wait for running threads. `--outcome` writes `update-outcome.json` before the
updater exits, and the next daemon reads it to say why an update failed.

**Clients.** The fleet is updated together. The person's window sends `start` to every machine
it administers, in parallel, and asks its own machine last so that it stays up to show
progress. Each machine picks its own platform's release and applies the same rules. The window
keeps the run (target release, mode, machines) in local storage. It survives the window's own
restart, and a machine that was offline gets the request when it comes back, if that release
is still the one on offer. The wording and these decisions live in `packages/ui-core`, so the
iPhone app can reuse them.

## Consequences

- Machines on a release from before this change can't be updated from elsewhere: their daemons
  don't know the request. The first remote update is possible from the release after it.
- A remote update needs a client with admin access to each machine. Read-only pairings are
  listed as such.
- A fleet run is held by the window that started it. Another client shows each machine's own
  status but not the run's summary.
- Tests: the rules as tables, the coordinator with test doubles for the updater and the app,
  one real-server process test for scopes and the app's reply, the updater's `--interrupt`
  path against the transactional updater, and the app's controller and reporter.
