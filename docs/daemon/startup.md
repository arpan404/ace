# Daemon startup

Run source with `ACE_HOME=/path/to/private/home bun run --filter @ace/daemon dev`
or `ACE_HOME=/path/to/private/home bun run ace -- start`. The runtime is Node 24+.
The root package has no `daemon` or `dev` script.

The event store, authentication files and core service attempts open before the
listener. `services/composition.ts` declares the order. `requires` means a
successfully initialized dependency is necessary; `after` permits an optional
dependency to be degraded. Core services precede listener services. Missing,
forward and duplicate dependency declarations are rejected before any start.
Dependencies that need warmed data explicitly await its readiness in their own
background initialization: commands wait for account-home validation.

The daemon writes its private `daemon-endpoint` file after the listener accepts
connections and the core initialization attempts finish. Optional context,
review, history, usage and notification initialization then runs. Socket handlers
and public daemon getters read the live registry. Features become available as
they open; processing saved user data is background work. Notification activation
registers devices that connected before its store opened.

Each initialization and activation attempt has a 15-second backstop. Errors name
the service. An attempt owns its resources and abort signal, and publishes only
once initialization succeeds. Failure starts cleanup, prevents late publication
and leaves the daemon serving. An unavailable engine rejects commands with
`engine_unavailable`; it never manufactures successful results or settled agent
states. Store, lock, identity and bind failures remain fatal.

Authenticated `GET /v1/status` and `ace status` expose a `services` list. Each entry
has `name`, `state` (`starting`, `ready`, `degraded`) and optional `error`. A service
can serve its persisted data while reporting `starting` during warmup. Background
failures report `degraded` with the service name. A startup deadline covers opening
and activation, not the size-dependent lifetime of indexing or backfill.

## History indexing

`openDaemonHistory` opens the index and starts a worker scan without awaiting it.
Opening installs trust filters for at most 256 registered homes; it does not
walk the persisted inventory. Removed or rebound homes are filtered from reads
immediately, and stale rows are cleaned in yielded background batches.

`history/index.sqlite` stores file path, size, mtime, fingerprint, registered home,
provider and scan epoch. Unchanged files require metadata checks but no content
reads. Changed JSONL files use at most 64 KiB each of head and tail. Four file
samples run concurrently; each batch commits before yielding. Provider databases
are fingerprinted with their WAL/journal metadata and streamed into a private
snapshot only when changed. Snapshots and imports preserve provider files.
SQLite caches are 2 MiB per history connection; the worker has 128 MiB old-generation
and 16 MiB young-generation heap limits. Heap limits are a backstop, not an RSS
measurement. Filesystem streams, SQLite caches and native allocations also count
toward RSS; the process regression records RSS growth for merge-time verification.

A separate read-only WAL connection serves committed index pages during a scan.
Up to eight list/get requests may overlap indexing; write/import operations remain
exclusive. Cleanup, pruning and lineage aggregation yield in capped pages. An
import or continuation cancels the current scan before using its exclusive lane.
Shutdown cancels scans, releases progress waiters, closes private snapshots and
index connections, then terminates the worker. Incomplete scans do not prune
unvisited sessions; completed file batches survive cancellation and restart.

`history.scan` with `action: "start"` starts or joins background indexing and
returns immediately. `action: "status"` reads status without triggering a scan and
requires read scope. Omitted action retains start permission requirements.
`history.list` serves persisted summaries immediately, with current scan status.
Both responses accept/echo optional `requestId`; existing fields remain available.
Their `scan` includes `state` (`idle`, `scanning`, `ready`, `failed`), `stats`
(`files`, `reads`, `bytes`, `skipped`), unsupported reasons and an optional failure.
Authenticated read clients receive `history.scan.updated` progress/completion
through the existing bounded socket outbox; revoked devices receive nothing.
A client that reconnects fetches status or a list again.

`@ace/client` provides `listHistory({cwd, limit, before})`, `scanHistory()`,
`historyScanStatus()` and observable `historyScan()`. The observable starts unknown
on reconnect and is updated by list/scan replies and progress events. A completed
`scanHistory()` request acknowledges indexing admission, not scan completion.

## Other background work

Accounts open their database before canonicalizing saved homes. Reads, assignments
and writes remain gated until validation completes. Command-library initialization
waits for that validation in the background and publishes through the live registry.
Plugin registry opening is separate from cancellable directory maintenance, which
streams directory entries. The original `PluginManager.open` convenience API still
awaits maintenance; daemon composition uses `openIndex` instead.

Usage opening only waits for its worker cursor. Event backfill already used yielded
batches and now reports initial catch-up readiness. Model discovery remains lazy:
startup reads a capped cache (64 instances, payloads capped at 4 MiB), without
launching provider discovery. Context opens storage without a full aggregate:
existing accounting is reused, and legacy accounting recovery yields every 128
rows with uploads gated behind recovery. Notification worker opening uses an
explicit readiness acknowledgement; saved-event replay and transport delivery
run in the background. Replay yields between bounded windows and shutdown aborts
pending worker RPCs.

Doctor resolves git from PATH first, then `/usr/bin/git` and `/bin/git` when PATH
has no installation. It accepts distribution suffixes such as
`git version 2.50.1 (Apple Git-155)`. An explicit broken PATH installation still
fails instead of being silently replaced with system git.
