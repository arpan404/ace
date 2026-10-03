# Daemon engine

`new Engine(store, options)` owns provider sessions, actors, deadlines and durable intents.
Pass `engine.handler` to `startServer`. `startDaemon(config, undefined, options)` installs the
engine by default and closes it before SQLite. The development stub remains available for
transport fixtures and explicit development CLI mode. Daemon options can also include MCP
`toolkits`; the upstream toolkit-array third argument and notification-channel fourth argument
remain supported.

Register adapters with `AdapterRegistry.register(adapter, discoveryResult)`. The registry
uses declared capabilities. An empty registry accepts no new provider threads. By default `startDaemon` probes installed
CLIs through provider-kit and registers the shipped Claude adapter with the discovered executable.
An explicit registry bypasses discovery; `adapterDiscovery` injects metadata probes. No session
opens during discovery. Other provider adapters can be registered as they land.

`workload()` reports live sessions, mailbox frames/bytes and indexed held-input counts to
daemon health. The existing sixth-argument workload port still overrides these metrics.

Options accept a registry, clock, core and thread id sources, `idleMs`, `silenceMs`, an error
reporter and `limits`. `flush()` drains accepted frames and active delivery workers without
waiting for held sends to become runnable. `close()` refuses new commands, closes sessions,
drains accepted output and aborts remaining owned lifetimes.

## Persistence and delivery

The independently versioned engine migration adds `thread_state`, `engine_state_records`,
`engine_state_appends`, `intents`, `engine_sessions`, `engine_slots` and `engine_raw_blobs`.
Cwd, model and native resume id live in session metadata. `Store.atomic` extends the existing
SQLite transaction. Events, snapshot header, changed records, append chunks and delivery
acknowledgements commit together. Subscribers receive events only after commit. Receipts,
creation events, metadata, capacity reservations and intents also share one transaction.

A complete core snapshot consists of the JSON header in `thread_state.state` and its
native-keyed records. Historical items, runs and native turn ids load on demand. String
deltas append to a journal instead of rewriting the item's accumulated text. Full item
updates replace its base and retire the corresponding journal. This is a physical storage
departure from the original single JSON row, needed to meet the review's O(change) requirement.
Recovery uses this snapshot, not canonical events, preserving native identities. Both the
engine database and snapshot header require schema version 9. The engine has never shipped;
older inline snapshots and pre-ADR-0006 shell records/journals are development formats with
no upgrade path. Older, newer, malformed or unversioned formats fail with a clear error
requesting a fresh development database. Cache state is discarded after failed persistence
so uncommitted mutations cannot enter a later transaction.

Ordinary sends, steering and controls use independent worker lanes. A pending send response
cannot hold an interrupt, task stop or capable steering call. Each intent is claimed before
provider I/O. `thread.create` has mandatory input and therefore opens and sends immediately;
other sessions open when their first send becomes runnable. Unsupported steering uses the
normal queue. Readiness derives from core with only the engine-held queue excluded. Native provider queues
remain part of readiness; engine reconciliation updates only its own queue source. Provider
queue counts retire with the session and produce an uncertainty notice on crash recovery.
Thread status also comes from core: human requests precede active work anywhere in the tree,
then waiting reasons, unresponsiveness and settled outcomes. A running background child
keeps the thread working; queued input waits until the entire tree settles.

Delivered sends retain a durable acknowledgement target until core accepts a fresh
root run caused by user input, queue delivery or an unknown partial stream. Replayed native
boundaries, child runs and known autonomous root turns do not acknowledge input. Steering
into an active root run uses that run. Steering before the first acknowledgement joins the
outstanding delivery target; one accepted turn clears every member of that group. On restart,
live work receives an unexpected process
exit; uncertain delivery receives a notice and is never replayed. Queue counts reconcile
without requiring another command, including legacy untracked acknowledgement state.

An interaction id has one unique resolution reservation. Kind, offered approval options,
question identities, selections, free text and dismissal are validated before reservation.
A second device gets `already_resolved` while the first answer is in flight. Echoed resolutions
keep the winning device and answer. A failed valid answer retains its reservation because
provider delivery may be uncertain.

One timer covers the earliest core, translator or idle deadline. It ticks translator and core. Sessions
close after 30 minutes of done by default. Resume supplies the saved native id and applies
`process.started`. Shutdown drains frames received before close and frames emitted while
closing before fencing intake. Retired generations are checked before decoding or accounting
frames and again when folding. A failed open drains its accepted prefix, retires only its owned
generation, aborts that lifetime and releases its capacity slot. Late failed-open callbacks cannot
retire a newer session. A persistence failure fences that translator until restart.

## Resource bounds and large payload integration

Default limits are 64 active thread actors, 256 queued callbacks per actor, 8 MiB of queued
frame JSON per actor and 4 MiB per frame. Capacity reservations are transactional; idle close
and process exit release them. Retired actors are evicted when another thread needs a slot.
Each snapshot dictionary caches at most 128 records and 1 MiB of serialized entity data.
Read-only scheduling and command validation do not retain every historical entity they scan.
Mailbox overload drains its accepted prefix, reports an error notice and aborts the session.

Text appends fold against a persisted metadata record whose string bodies are empty. The base
and append chunks remain the complete snapshot. The scoped append value keeps core validation,
identity and append semantics while avoiding historical string reconstruction. Full reads and
upserts materialize the text on demand; replacing a body retires its old journal. Both full bodies
and metadata use bounded dictionary caches. Missing metadata is derived on its first append
only within the supported snapshot format.

ADR 0006 is on main. Shell deltas persist the bounded summary in engine state and fill Store's
shared output stream; `output.read` serves its bytes. Store provides windowed snapshots and item
pages. Raw data above 64 KiB uses Store's shared cap and protocol blob-ref form, with a 2 KiB
preview. `engine.readRawBlob(id)` reads both shared blobs and legacy engine envelopes. Core and
projection need to materialize text when a full item is requested, but valid text deltas no longer
reconstruct its accumulated body. No engine-authored changes touch those packages.

## Verification and performance

The repository owner requires tests to run once at merge. The committed public API tests use
scripted providers, file-backed SQLite and real WebSockets. Provider waits and clocks are
controlled boundaries; there are no synchronization sleeps or gating performance budgets.
Until merge, run only formatting, lint, typechecking and size checks. The owner allows specific
test files touching conflict code after resolving a main merge. Other runtime assertions,
performance measurements and mutation cases need run at merge.

`benchmark.ts` contains the complete adapter callback, translation, core, SQLite and WebSocket
delivery benchmark, deferred to merge under the same rule. It seeds 10, 100, 1,000 and 10,000 items, then
measures 30 one-character deltas at each size. It also measures active messages of 1 KiB,
1 MiB + 1 byte and 4 MiB. Detail items load through real WebSocket pages before timing so
client projection applies every delta even when the item is outside the snapshot window. The
PR distinguishes historical measurements from final-head verification deferred to merge.
The header contains configuration, queue sources and live indexes; historical entity
dictionaries remain separate. Untouched entities are not decoded or serialized on the frame path. SQLite intent queries index only outstanding statuses and
acknowledgements. Core status traversal still depends on the agent tree and live work.

A versioned snapshot/record codec exported by core would remove the engine-owned validator.
That dependency change is requested in the PR, without modifying core in this workstream.

## Composition with main

Daemon startup retains remote-access device scopes, MCP toolkits, models and notifications.
The server drains durable callbacks and presence removal before engine shutdown; notification
draining remains attached until final engine events commit. Raw capping uses Store's owned
PayloadStore and prepared-statement cache instead of creating a second payload owner.

Conductor remains behind its documented executor ports in ADR 0017. A production lane bridge
needs durable effect receipts, child attachment, worktrees, account migration, artifact extraction
and forkable history. Installing a partial bridge here would launch invisible or unrecoverable
lanes. Its public driver and existing injected daemon handler remain available; engine commands
continue to decline conductor commands explicitly until those executors are supplied.

Providers with durable prompt admission emit `input.admitted` before a turn starts. The optional third argument to `ProviderSession.send` supplies the engine command ID; returning it on the admission fact acknowledges exactly that input, including a late receipt recovered after an uncertain send. Uncorrelated admissions retain the oldest awaiting group fallback. The per-thread acknowledgement policy is persisted in the existing engine record store; subsequent run starts cannot acknowledge another input. Providers using turn-start acknowledgement keep their existing behavior. Admission is neither a new run nor terminal evidence.
