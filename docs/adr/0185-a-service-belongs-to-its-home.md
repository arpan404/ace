# 0185: A login service belongs to its home

Status: accepted. Date: 2026-11-17. Decided by: the owner (2026-11-17, after a dev home replaced
a person's Spade service). Amends [ADR 0123](0123-spade-runs-as-its-own-service.md), decision 1,
and [ADR 0041](0041-packaging-and-distribution.md) on the daemon's service names; the rest of both
stands.

## Context

Spade's service and the daemon's had one fixed name per OS: launchd `dev.ace.next.spade` and
`dev.ace.next.daemon`, systemd `ace-next-spade.service` and `ace-next.service`, Task Scheduler
`\ace-next-spade` and `\ace-next-daemon`. Every `ACE_HOME` on a machine shared them. ace already
refused a registration that ran another home, but only while one existed: a dev home started with
`ACE_DEV_DIR` and Spade on found the name free and registered its own unit there, so the person's
Spade became a service running from `/var/tmp`. A second home also could never have a service of
its own.

## Decision

1. **The default home keeps today's names.** `~/.ace` (`%USERPROFILE%\.ace`) registers exactly
   the names above, so existing installs keep working and nothing migrates.
2. **Every other home gets its own stable name:** the default name plus the first 10 hex digits
   of the SHA-256 of the home's normalised path (lower-cased on Windows), e.g.
   `ace-next-spade-1a2b3c4d5e.service`, `dev.ace.next.spade.1a2b3c4d5e`, `\ace-next-spade-1a2b3c4d5e`
   and the daemon's `ace-next-1a2b3c4d5e.service`. Naming is pure (`service-name.ts`).
3. **A home already registered under the default name keeps it.** A custom `ACE_HOME` installed by
   an earlier build runs under the default name; the I/O shell reads which home that registration
   runs and the planner keeps the name for that home, so its updater, restart and removal still
   find its service. Removing it frees the name for the default home.
4. **Install, update, restart and remove only touch their own home's service.** A service under
   the target name that runs another home is never replaced, started or removed: ace refuses,
   names that home and says how to remove the service by hand. A registration of the same home
   from an earlier build is still rewritten in place (ADR 0123).

## Consequences

- Dev, test and second homes can run Spade and the daemon at login beside the person's own.
- A service that took the default name before this rule stays until it is removed by hand or
  by turning Spade off (or `ace service uninstall`) in the home it runs.
- Release checks that install into a temporary `ACE_HOME` look up that home's task name.

## Tests

`packages/service/src/service-per-home.test.ts`: the default home keeps its names; a second home
installs its own Spade and daemon service and leaves the default home's alone, and its removal
clears only its own; installing never replaces a service that runs another home; a home already
under the default name keeps it.
