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

Delivered sends retain a durable acknowledgement reservation until core accepts a fresh
root run caused by user input, queue delivery or an unknown partial stream. Replayed native
boundaries, child runs and known autonomous root turns do not acknowledge input. Steering
into an active root run uses that run. On restart, live work receives an unexpected process
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
frames and again when folding. A persistence failure fences that translator until restart.

## Resource bounds and large payload integration

Default limits are 64 active thread actors, 256 queued callbacks per actor, 8 MiB of queued
frame JSON per actor and 4 MiB per frame. Capacity reservations are transactional; idle close
and process exit release them. Retired actors are evicted when another thread needs a slot.
Each snapshot dictionary caches at most 128 records and 1 MiB of serialized entity data.
Read-only scheduling and command validation do not retain every historical entity they scan.
Mailbox overload drains its accepted prefix, reports an error notice and aborts the session.

Raw data above 64 KiB is stored as original JSON bytes in a content-addressed blob. Its data
field carries `{ aceRawBlob: { id, size, preview } }`, with a 2 KiB preview.
`engine.readRawBlob(id)` returns the original bytes. This temporary envelope fits the existing
schema's unknown data field without editing protocol. Replace it with ADR 0006's shared blob
form and read route once PR #12 lands on main. Its bounded tool-output summaries and windowed
client snapshots remain necessary: the current core/projection APIs still materialize a
single item's text when a cold item or full update needs it. Engine historical cache and
mailbox bounds do not claim to bound that temporary materialization or client view memory.

## Verification and performance

Run `bun run test apps/daemon/src/engine` for public API tests with scripted providers,
file-backed SQLite and real WebSockets. Provider waits and clocks are controlled boundaries;
there are no synchronization sleeps or gating performance budgets.

Run `node apps/daemon/src/engine/benchmark.ts` for the complete adapter callback, translation,
core, SQLite and WebSocket delivery benchmark. It seeds 10, 100, 1,000 and 10,000 items, then
measures 30 one-character deltas at each size. The PR records results and mutation failures.
The header remains about 542 bytes at every history size; untouched entities are not decoded
or serialized on the frame path. SQLite intent queries index only outstanding statuses and
acknowledgements. Core status traversal still depends on the agent tree and live work.

A versioned snapshot/record codec exported by core would remove the engine-owned validator.
That dependency change is requested in the PR, without modifying core in this workstream.
