# Daemon engine

`new Engine(store, options)` owns provider sessions, actors, deadlines and durable intents.
Pass `engine.handler` to `startServer`. `startDaemon(config, undefined, options)` installs the
engine by default and closes it before SQLite. The development stub remains available for
transport fixtures and explicit development CLI mode. Daemon options can also include MCP
`toolkits`; the upstream toolkit-array third argument and notification-channel fourth argument
remain supported.

Register adapters with `AdapterRegistry.register(adapter, discoveryResult)`. The registry
uses declared capabilities. An empty registry accepts no new provider threads. Discovery
and real adapters are outside this workstream.

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
Recovery uses this snapshot, not canonical events, preserving native identities. Version 1
full snapshots remain readable and convert on their next write. Cache state is discarded
after failed persistence so uncommitted mutations cannot enter a later transaction.

Ordinary sends, steering and controls use independent worker lanes. A pending send response
cannot hold an interrupt, task stop or capable steering call. Each intent is claimed before
provider I/O. `thread.create` has mandatory input and therefore opens and sends immediately;
other sessions open when their first send becomes runnable. Unsupported steering uses the
normal queue. Readiness derives from core with queue count excluded.

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

One timer covers the earliest core or idle deadline. It ticks translator and core. Sessions
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
and metadata use bounded dictionary caches. Legacy snapshots gain metadata on their first append.

ADR 0006 is on main. Shell deltas persist the bounded summary in engine state and fill Store's
shared output stream; `output.read` serves its bytes. Store provides windowed snapshots and item
pages. Raw data above 64 KiB uses Store's shared cap and protocol blob-ref form, with a 2 KiB
preview. `engine.readRawBlob(id)` reads both shared blobs and legacy engine envelopes. Core and
projection need to materialize text when a full item is requested, but valid text deltas no longer
reconstruct its accumulated body. No engine-authored changes touch those packages.

## Verification and performance

Run `bun run test apps/daemon/src/engine` for public API tests with scripted providers,
file-backed SQLite and real WebSockets. Provider waits and clocks are controlled boundaries;
there are no synchronization sleeps or gating performance budgets.

Run `node apps/daemon/src/engine/benchmark.ts` for the complete adapter callback, translation,
core, SQLite and WebSocket delivery benchmark. It seeds 10, 100, 1,000 and 10,000 items, then
measures 30 one-character deltas at each size. It also measures active messages of 1 KiB,
1 MiB + 1 byte and 4 MiB. Detail items load through real WebSocket pages before timing so
client projection applies every delta even when the item is outside the snapshot window. The PR records results and mutation failures.
The header remains about 542 bytes at every history size; untouched entities are not decoded
or serialized on the frame path. SQLite intent queries index only outstanding statuses and
acknowledgements. Core status traversal still depends on the agent tree and live work.

A versioned snapshot/record codec exported by core would remove the engine-owned validator.
That dependency change is requested in the PR, without modifying core in this workstream.
