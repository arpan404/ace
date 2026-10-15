# Daemon startup

Run source with `ACE_HOME=/path/to/private/home bun run --filter @ace/daemon dev`
or `ACE_HOME=/path/to/private/home bun run ace -- start`. The runtime is Node 24+.
The root package has no `daemon` or `dev` script.

The event store, authentication files and core service attempts open before the
listener. `services/composition.ts` declares the order. `requires` means a
successfully initialized dependency is necessary; `after` permits an optional
dependency to be degraded. Core services precede listener services. Missing,
forward and duplicate dependency declarations are rejected before any start.
Account-home validation and repair finish before the accounts service is
published. Models and the engine require that service, so failed repairs cannot
admit provider hosts under an unvalidated account identity.
Settings open before browser backend setup; browser and screen setup precede MCP
so their toolkits are registered. Thread transitions start after the account-service
attempt and before the engine; git patch application and account migration remain
available through the same command port. Browser acquisition is lazy on first use.
The composition readiness assertion requires the command port, not every optional
feature. Store, authentication and listener initialization remain mandatory.

The CLI installs SIGINT/SIGTERM handling before initialization begins. Host callers
can pass `DaemonOptions.signal`; abort interrupts bounded initialization, stops
warmup, closes the listener/resources and removes the endpoint and lock. The
process wrapper `runDaemonProcess(startDaemon, options)` owns signal handling.

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

## Model discovery

Without `ACE_MODEL_INSTANCES`, the model service admits installed Codex, Claude,
OpenCode and Pi CLIs using background executable-path checks. Cursor supplies
only the selected SDK account catalog, with no Cursor CLI
catalog. Setting `ACE_MODEL_INSTANCES` explicitly overrides CLI defaults;
`[]` disables them.

Catalog reads return cached data immediately. Missing or expired data starts one
bounded metadata refresh per instance, with a 15-minute TTL, concurrency limits
and failure cooldown. `models.refresh` discards the selected instances' cached
choices before refreshing. After signing into a different account in an external
CLI, issue `models.refresh` for that provider or instance; this revokes old choices
in memory and on disk, including when the new account's discovery fails. In-daemon
Cursor authentication already advances its account generation automatically. Generic
ACP catalogs remain session-owned and are not cleared by this metadata refresh.
No metadata probe is awaited during daemon startup, and none sends a provider prompt.
Codex uses app-server `model/list`, Claude uses SDK control initialization,
OpenCode v2 uses an owned, authenticated loopback server and location-scoped
`client.model.list`. If that catalog is empty, `opencode models` supplies qualified
IDs without fabricated capabilities or context windows. Pi uses
`get_available_models` with extensions and session persistence disabled. Cursor retains its existing SDK or
ACP metadata path. OpenCode and Pi model IDs retain their native provider prefix.

Raw Claude and Codex protocol traffic goes to provider diagnostics at debug log
level. Transcript notices are reserved for user-relevant information and errors.

## Past sessions (on demand)

Startup opens no provider history. `openDaemonHistory` only removes working
directories a crashed session left in `ACE_HOME/tmp/past-sessions-*`; no worker
starts, no file is watched and no index exists until someone asks (ADR 0033,
2026-10-15 amendment).

The first `history.list` starts a session: a history worker with a private index
and snapshot scratch in a new `ACE_HOME/tmp/past-sessions-*` directory. It scans
on that first request or when `rescan` is set, then pages from the session index.
Sessions an ace thread already holds (matched by `provider:nativeId`) are not
listed. Unchanged files within a session require metadata checks but no content
reads; changed JSONL files use at most 64 KiB each of head and tail, and provider
databases are streamed into a private snapshot only when changed. Snapshots and
imports preserve provider files. SQLite caches are 2 MiB per history connection;
the worker has 128 MiB old-generation and 16 MiB young-generation heap limits.

Operations in a session run one at a time. `history.release`, ten idle minutes or
shutdown ends the session: the worker closes and its directory is deleted.
Import and continue answer `unsupported` once the session has ended. The reply's
`scan` reports the session's last scan (`state`, `stats`, unreadable sources).

## Other background work

Cursor SDK auth uses ephemeral `cursor.auth.error` replies, outside the durable
intent outbox. `code: "unavailable"` means authentication could not be attempted.
Its safe `reason` identifies a missing or closed service (`service_unavailable`),
an absent instance or an instance registered to another provider
(`instance_unavailable`), or SDK discovery/admission failure (`sdk_unavailable`).
SDK admission covers the pinned version, Node runtime and platform helpers;
browser login checks it before admitting a login job. Status on a usable,
logged-out SDK instance returns `cursor.auth.changed` with logged-out auth.
Selecting that instance returns `auth_failed`, as do failed auth operations after
admission. Unknown login job IDs return `not_found`. Provider diagnostics and
credentials are never included in these replies. The accounts CLI displays the
safe code and reason.

Accounts open their database before canonicalizing saved homes. Reads, assignments
and writes remain gated until validation completes. Command-library initialization
waits for that validation in the background and publishes through the live registry.
Plugin registry opening is separate from cancellable directory maintenance, which
streams directory entries. The original `PluginManager.open` convenience API still
awaits maintenance; daemon composition uses `openIndex` instead.

Files open their bounded resource catalog before starting retention cleanup and
support-artifact registration as background warmup. Relocated-upload traversal
receives the service abort signal. Cleanup debt keeps its count/byte reservation
until the original inode is removed; cancellation never refunds that debt.
Reads remain available while cleanup serializes with mutations.

Usage opening only waits for its worker cursor. Event backfill already used yielded
batches and now reports initial catch-up readiness. Model discovery remains lazy:
startup reads a capped cache (64 instances, payloads capped at 4 MiB), without
launching provider discovery. Context opens storage without a full aggregate:
existing accounting is reused, and legacy accounting recovery yields every 128
rows with uploads gated behind recovery. Notification worker opening uses an
explicit readiness acknowledgement; saved-event replay and transport delivery
run in the background. Replay yields between bounded windows. Shutdown stops new
replay ticks, drains pending ingestion and replay, then closes the worker after
socket presence cleanup. Only startup cancellation aborts unopened worker RPCs.

Doctor resolves git from PATH first, then `/usr/bin/git` and `/bin/git` when PATH
has no installation. It accepts distribution suffixes such as
`git version 2.50.1 (Apple Git-155)`. An explicit broken PATH installation still
fails instead of being silently replaced with system git.

Service cleanup has a separate 8-second deadline from the 15-second startup
bound. Its error reads `Service <name> cleanup exceeded 8000ms`. Chromium gets
five seconds for graceful context closure, then ace kills its owned process
group, cancels pending session CDP reads and logs the forced cleanup. That
fallback releases the browser service without failing daemon shutdown. Both
cleanup deadlines and the Chromium process-kill boundary are injectable.

Chromium ownership begins immediately after launch. Process identity discovery has a separate two-second bound and observes cancellation; failed discovery closes the owned context. Windows tree termination is asynchronous and an already-exited process is successful cleanup.

`ace start` also opens an authenticated preview gateway on loopback at an ephemeral
port, with `*.preview.localhost` origins. Ports require explicit trusted forwarding;
signed sessions require paired operate authority. Remote daemon access does not
change this listener's binding.

Default CLI startup uses `~/.ace` (or `ACE_HOME`), and settles its format first, before the
lock or any store (ADR 0081). A missing home is created with `ace-format.json`. A home without
that marker, or in an older format, is renamed in one rename to `~/.ace-v0` (or `~/.ace-vN`,
never over an existing backup) and replaced by a fresh one; a home whose older daemon still
runs is refused instead. A newer format exits 65 and is not moved. `~/.ace-next` from interim
builds is ignored. After startup the daemon logs the backup's path and size and leaves a
`BACKUP-README.txt` in it. See ADR 0041 for release and service version checks.

SQLite's exact uncoded experimental warning from Node 24.13.0 is filtered at the
shared SQLite boundary in each isolate. Other warnings retain Node's formatter
and consumer warning listeners. This does not disable `ExperimentalWarning`.

## Shutdown deadlines

Shutdown stops admission and aborts each service lifetime before draining socket work. Independent service owners close in parallel. Dependants close before their `requires` and `after` owners, retaining account databases and attachment context through engine and control cleanup. Each owner has a six-second cleanup deadline that logs the service name on failure. Socket tasks and presence cleanup have a five-second drain deadline. Shared Store and log resources close after those drains.

The overall shutdown deadline is seven seconds. Endpoint removal runs even if cleanup fails or exceeds the deadline. The home lock remains held until actual cleanup settles or the process exits; a timeout cannot admit a second writer against resources still owned by the first process. Service timeout reports do not permit dependent stores to close before their callers finish. The CLI arms a 7.5-second process exit fallback when it receives a termination signal; it remains armed after cancelled startup so leaked native handles cannot keep the process alive. The fallback is unreferenced, allowing successful shutdown to exit naturally.
