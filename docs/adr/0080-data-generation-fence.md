# 0080: Data generation fence

Date: 2026-10-14. Status: accepted by owner decision. Refines startup in ADR 0003 and the
diagnostics in ADR 0031.

## Context

Old copies of the app bundle can stay on disk with the same bundle id (`dev.ace.app`), and
Launch Services sometimes resolves a relaunch to one of them (issue #712). That older daemon
took the ACE_HOME lock and opened data a newer build had already migrated. Its services failed
one by one: a table had more columns than the old insert supplied, an enum value was missing, a
notification database version was not supported. It still announced `Daemon listening`, so
clients connected and every command came back `engine_unavailable`.

Each store versions itself (`schema_version` in `events.sqlite`, the notification database
version, the forge and model stores). But a store only finds out after it opens, and some stores
had already done work on the newer files by then.

## Decision

**ACE_HOME records the newest data generation that has opened it, and an older build refuses
to start.**

- `DATA_GENERATION` in `apps/daemon/src/data-generation.ts` is one integer for the whole home.
  Any change to a persisted format that an older build cannot read bumps it in the same change:
  a SQLite schema or migration in any database under ACE_HOME, a new enum value stored in a
  row, or a JSON state file. It never decreases.
- `ACE_HOME/data-generation` holds `{"generation":N}`. The daemon writes it via a temp file and
  rename, mode 0600, under the daemon lock, and only when the stored value is missing or lower.
- On startup the daemon reads the file before it takes the lock or opens any database. If the
  stored generation is higher than the build's, it logs a clear record to `logs/ace.jsonl`
  (stored generation, supported generation, pid and version), prints the same message on
  stderr, and exits with `exitCodes["newer-data"]` (65).
- The desktop supervisor does not restart a daemon that exits with 65. It shows "A newer
  version of ace already uses this data. Open the newest ace, or update this one."
- A daemon whose engine fails to start fails startup and never listens. Other services that
  fail still degrade in place and report their error in `/v1/status` `services`.

## Consequences

- An old bundle cannot serve, or quietly damage, data from a newer build. The person gets one
  clear message instead of a stream of unavailable services.
- Forgetting the bump reopens the hole for that change. Reviews of persisted-format changes
  check for it.
- This is not a migration system. ace is pre-release, so an older build is not made to read
  newer data. It is only kept from opening it.
- Moving data back to an older build means deleting or restoring ACE_HOME. That is
  deliberate.

## Addendum (2026-10-15): stores this build cannot read

The fence covers newer data. A store in a format this build does not read for another reason,
such as one left by an older pre-release build, has no migration (the pre-release rule in
AGENTS.md). The forge link tables and the notification database used to carry upgrade code for
older layouts; that code is removed.

- A store that finds a format it does not read throws `IncompatibleDataError`
  (`@ace/provider-kit/incompatible-data`). Its message names the file, what is wrong and the
  recovery step, and it leaves the file untouched.
- Service startup stops on that error in either phase instead of degrading, so the person sees
  one message, not the store's service plus every dependent reporting "Dependency … is
  unavailable". The CLI exits with `exitCodes["incompatible-data"]` (66).
- The desktop supervisor does not restart a daemon that exits with 66. It says that saved data
  from a different build cannot be read and that the daemon log names the file.

`ACE_HOME/daemon-run.json` records how each run ended: `running` once the lock is held, and
`stopped` with its stop reason as the last step of an orderly shutdown. The next start logs
"Previous daemon run stopped in order" (with the source and signal) or, when `running` was left
behind, a warning that the previous run crashed or was killed. That tells an app quit, update
or `ace stop` apart from a crash in the durable log.
