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
| app logs folder `desktop*.jsonl`         | desktop main process                  | 1 MiB per file, 3 rotations (4 MiB), fixed     |

The service manager sends daemon output to `/dev/null`, and the recorder is a developer tool outside the app.

The desktop main process writes its own records and every stdout and stderr line of the daemon child it spawned to `desktop.jsonl` in Electron's logs folder (macOS `~/Library/Logs/ace`), as well as to its console. A Finder launch has no console, and the supervisor's reasons for restarting the daemon (ADR 0054) must survive it. Each record is one JSON line (`at`, `level`, `component`, `message`, `data`); a message is clipped at 4,096 characters and its data at 8,192. Before anything reaches the console or the queue, the message and the serialized data pass through the daemon's diagnostic redactor (`@ace/redaction/diagnostic`, with the same home and environment context as `ace.jsonl`), and data is redacted before it is clipped, so a cut never leaves the start of a secret. Lines are written in batches at most 250 ms after the first, with at most 1 MiB waiting in memory; lines past that are dropped and counted, as are failed writes, and neither throws into the app. A line that would take the current file past 1 MiB rotates it to `desktop.1.jsonl` first, and the oldest of three rotations is replaced. On exit whatever is still queued is appended with one synchronous write. Help → Show Logs opens the daemon's log folder and the app's logs folder, each when it exists; for a remote daemon only the app's.

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

## Amendment: live SQLite write buffer (issue #857)

Established append streams now enter a daemon-owned buffer before SQLite. The canonical core
reducer still owns item changes and liveness; its events publish directly from memory. Event
rows and engine snapshot append patches accumulate until 75 ms, a 64 KiB accounting threshold,
or a control/read/maintenance/shutdown boundary. Adjacent deltas for the same thread, item,
agent and field compact to at most 4 KiB; interleaved streams retain their global order. The
1 ms mailbox remains an intake bound, independently of the persistence window.

The write buffer has an 8 MiB hard admission budget. Accounting charges event text, engine
patches, decoded strings and per-entry overhead conservatively. Admission flushes before the
cap; oversized frames take the durable size-boundary path. Residual over-capacity after the
flush surfaces as transient `Store is busy` so the provider mailbox retries after 100 ms;
it never poisons the session. Single oversized batches are rejected by the stream() size
guard before admission. Pending snapshots stay pinned
outside the engine LRU. Flushes commit all events, derived tables, append patches and snapshot
headers together. A failed transaction keeps the complete batch and retries after 100 ms;
provider intake pauses until storage recovers. No uncommitted entry is evicted. This is a
deliberate divergence from per-thread/agent LRU eviction: uncommitted data is pinned, never
evicted, and delivery resync stays at the Outbox layer (`RESYNC_CLOSE_CODE`). Control facts,
new items and full upserts remain durable boundaries. Cursor SDK recovery frames retain their
existing atomic provenance/offset transaction and durable acknowledgement contract.

An ordinary streaming-frame acknowledgement means admission to this bounded buffer, not
per-token durability. The usual process-crash loss window is the unflushed tail (at most
75 ms under healthy storage). A storage failure can extend that window while data stays
pinned in the running daemon. Completion, explicit engine flush and graceful shutdown drain
it. This is an intentional change from durable-per-token delivery; memory cannot survive a
power loss. Completed/control state is never published ahead of its commit.

Live events reserve canonical sequence numbers. Before publishing the first live event in a
range, a small independent transaction advances the existing `host_sequence` high-water mark
by at least 65,536 slots counted from canonical event envelopes, never bytes or provider
facts. A shell-output fact may split into several canonical deltas. The exact batch is pinned
before its range is checked, so refilling a range can durably flush the complete batch and
snapshot together. Only unpublished original envelopes reach live subscribers; compacting
the persisted rows never repeats an already delivered prefix. Reservation or forced-flush
failures retain the batch and apply mailbox backpressure until storage recovers. The visible durable head comes from actual event/deletion rows,
not unused reservations. Restart skips the reserved range, including slots published only
in memory, so a lost tail can never alias later events. The table's encoding is unchanged;
previous builds also skip its high-water mark. A compacted persisted delta uses the final
sequence in its span, leaving gaps. Reconnecting from a cursor inside a compacted span, or
ahead of the durable head after a crash, takes a fresh snapshot rather than replaying an
append twice. Existing Outbox byte limits and resync-on-congestion remain the delivery
contract. Snapshot and transcript reads drain the pending tail before reading SQLite. The canonical
writer passes the actual predecessor to turn and search indexes, so reserved/compacted gaps
advance their coverage in the same transaction. Usage replay bounds pages by actual rows
rather than iterating empty sequence ranges.

A separate 8 MiB/512-entry LRU holds thread snapshots, recent item pages and entity pages.
Every local transaction invalidates it wholesale (coarse but correct), including queue/recovery, switch, fork, migration,
archive and deletion writes. `PRAGMA data_version` fences writes from other connections; `total_changes()` also fences raw
writes on the Store connection. A cursor past even the reserved high-water mark is treated
as unsafe and falls back to a fresh snapshot rather than surfacing a replay error.
Transactional reads bypass cache population; callers receive independent values. Read-cache
pressure cannot evict pinned writes. Cache misses fall through to SQLite.

Read-cache optimization remains a separate follow-up: with 1,000 awaited deltas, a local
single-writer run committed 42 transactions, while interleaving a snapshot read every four
deltas committed 251 transactions with 250 cache misses and no hits. Reads currently drain
the tail to preserve consistency. The next Store extraction should move snapshot, item-page
and entity-page reads, their cache keys and generation checks into one read-path owner;
Store will keep the flush barrier and write transaction ownership. This separates read-path
work before Store reaches its 1,500-line limit. Shutdown now has its own small owner so a
failed final flush cannot skip timer, worker or connection cleanup; its promise reports
flush and cleanup failures after all cleanup has been attempted.

WAL auto-checkpoint and the existing 16 MiB journal limit remain enabled. A bounded idle
checkpoint timer tries TRUNCATE without waiting for other readers, at most once per five
seconds after writes. No recurring work remains once idle. Retention semantics are unchanged.
The authenticated `diagnostics.health` response includes `streaming`, populated by
`Store.streamingMetrics()`. It exposes committed transaction/event counts, buffered batch rows,
flush failures, live bytes, current/peak buffer accounting, WAL size and read-cache hits,
misses, hit bytes, invalidations, evictions, stale serves (always zero by construction) and
current bytes. Counter differences over a
measurement interval yield transaction rate and rows per batch.

The standalone scripted-provider benchmark is `node apps/daemon/bench/live-write-buffer.ts`.
A local run of this implementation delivered all 1,000 individually awaited deltas in 44
transactions and 43 persisted delta rows (about 23 times fewer), with 68,200 bytes of peak
buffer accounting and a 1,648,032-byte WAL. These are observed values, not platform-independent
latency budgets. The regression suite also checks Unicode chunk bounds, replay from compacted
spans, retry after a rejected transaction, cross-connection/raw-write invalidation and an idle
checkpoint returning the WAL to zero without subsequent write growth.
