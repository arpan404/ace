# 0076: Log caps, write batching and data retention

Date: 2026-10-13. Status: accepted.

## Context

The daemon's log sink kept at most 8 MiB of rotated JSONL, but the cap was fixed, the logger wrote on every event-loop turn, and a crash lost whatever was still in memory. `ace open` appended the detached daemon's stdout and stderr to `daemon-start.log` with no bound. Data retention existed only as reviewed cleanup (ADR 0031, `docs/daemon/storage-cleanup.md`), which removes archived threads and only runs automatically when the host opts in. The owner requires a per-stream log cap with a 1 GB default, batched writes everywhere, and an automatic data window with a 120-day default that both the CLI and the app can change on a running daemon.

## Decision

### Log streams

Every log stream ace writes is capped on disk, rotated segments included:

| Stream                                   | Writer                                | Cap                                            |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| `<home>/logs/ace*.jsonl`                 | daemon logger, file sink in a worker  | `logs.maxBytes`, default 1 GiB                 |
| `<home>/daemon-start.log`                | `ace open`, detached daemon stdio     | same value from the environment, default 1 GiB |
| browser `console.jsonl`, `network.jsonl` | per session, removed with the session | 16 MiB each, fixed                             |

The desktop main process writes to its console only, the service manager sends daemon output to `/dev/null`, and the recorder is a developer tool outside the app.

The sink derives its segment size from the cap (an eighth of it, between 128 bytes and 64 MiB), so dropping the oldest segment never discards more than an eighth of history. Before each append it deletes the oldest segments until the current file, the incoming batch and the remaining segments fit under the cap. Policy is pure (`packages/diagnostics/src/log-policy.ts`); the sink is the I/O shell. A cap change applies at once: the sink rescans the directory, since retention or a person may have removed segments, then trims. `daemon-start.log` rotates once per launch when it reaches a quarter of the cap; only startup lines and crash traces go there.

The logger buffers records and writes a batch when 512 are queued or 250 ms after the first one, one sink write per batch. Writes and resizes share one serial chain. A full buffer (4,096 records) gives up its oldest record of the lowest level present, so debug lines go first and errors last; every dropped record is counted, as is every record the sink failed to write. A full disk therefore costs log lines and increments `failed`; it never throws into the daemon. On `uncaughtExceptionMonitor` the daemon records the error and appends every buffered line, including a batch the worker may not have finished, with one synchronous write; `exit` does the same. A crash can repeat the last batch but does not lose it.

### SQLite writes

Provider frames already enter the store in batches: the thread actor seals its mailbox after a 1 ms window, 256 frames or 256 KiB, and folds the whole batch, its event appends, thread snapshot and acknowledgements in one transaction. Adjacent text deltas for the same item coalesce into one event up to 4 KiB. A frame's acknowledgement resolves only after its transaction commits, and events publish only after commit, so durable acknowledgements and the states the UI acts on are never reported early. The 1 ms window stays: adapters that await each acknowledgement must stream without a per-token delay (`scripted-backpressure.process.test.ts`). Measured with real SQLite, 1,000 back-to-back deltas commit in 4 transactions as 12 delta events (`delta-batching.process.test.ts`).

`events.sqlite` already runs WAL, `synchronous=NORMAL`, `wal_autocheckpoint=256` and `journal_size_limit=16 MiB`. The other daemon databases that use WAL now set `journal_size_limit` too, and those without an explicit choice set `synchronous=NORMAL`. Upload metadata and the plugin registry keep `synchronous=FULL` on purpose.

### Data retention

`storage.retentionDays` (1 to 3650, default 120) is the automatic data window. A daemon pass removes, in one bounded plan of at most 256 items:

- threads whose whole delegation tree has been idle longer than the window, archived or not, with their events, transcript payloads and attachment references;
- unreferenced attachments older than the window;
- rotated log files older than the window.

Age is last activity: the newest of activity, archive and deletion times across the tree, never creation time. Every reviewed-cleanup protection still holds and is rechecked at removal time: working, waiting on a person, limited, queued or uncertain input, pinned, leased sessions, active delegation. Worktrees, caches and artifacts stay with reviewed cleanup. A pass runs 30 s after startup, every 6 hours, 2 s after the window shrinks, and after 60 s when work remained or the pass failed. A plan is journaled only when something is eligible, uses the reviewer `storage:retention` so a crash resumes it, and is dropped once settled. Removals are followed by the existing incremental compaction. Selection is pure (`planStorageItem` with `idleThreads`, `data-retention-policy.ts`); `DataRetention` is the timer shell.

### Configuration and live changes

`ace config get [retention-days|log-cap]` and `ace config set retention-days DAYS | log-cap SIZE` talk to the running daemon through the socket's `settings.set` and `settings.get`. The daemon saves the global setting and applies it immediately: the logger resizes its sink and retention re-arms with the new window. Connected clients see the value through the existing `settings.subscribe` push. Settings → Storage shows both values and saves through the same request. With no reachable local daemon, the CLI saves the same settings file, and the daemon reads it when it starts.

`ACE_RETENTION_DAYS` and `ACE_LOG_MAX_BYTES` (`1g`, `512m` or bytes) are parsed with the protocol schemas at startup. They follow the convention `ACE_LISTEN` set: an explicit environment variable wins over saved settings. The settings service resolves such keys with the new `environment` provenance. A CLI or app change is still saved, takes effect once the variable is unset, and is reported as overridden: the CLI prints which variable wins, and the app disables the field and names it.

## Consequences

Retention now deletes idle threads that were never archived. Pins keep a thread indefinitely. Shortening the window removes data within seconds, bounded to 256 items per pass. A cap smaller than the current logs deletes the oldest segments at once.

Thread purges also drop the engine's cached actor for that thread. Before this, shutdown recovery could read the purged engine state and fail.

## Follow-ups

- `daemon-start.log` takes its cap from the environment or the default, not from saved settings, because the launcher runs before any daemon.
- Browser session logs keep their fixed 16 MiB per stream.
- Native clients do not show the two settings yet.
