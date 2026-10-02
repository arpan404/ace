# Daemon engine

`new Engine(store, options)` owns provider sessions, actors, deadlines and durable intents. Pass
`engine.handler` to `startServer`. `startDaemon(config, undefined, options)` installs the engine
by default and closes it before closing SQLite. The development stub remains available for
transport-only fixtures and the explicit development CLI mode.

Register each adapter with `AdapterRegistry.register(adapter, discoveryResult)`. The registry
uses the adapter's declared capabilities. An empty registry accepts no new provider threads.
This workstream does not bundle real adapters or run provider discovery itself.

Options accept the registry, a clock, core and thread id sources, `idleMs` and `silenceMs`, and
an error reporter. Idle sessions close after 30 minutes by default. `flush()` drains accepted
commands and frames, without waiting for queued sends to become runnable. `close()` rejects
new commands, closes sessions gracefully, aborts remaining owned lifetimes and drains workers.

## Persistence and delivery

The engine migration has its own version table to avoid conflicting with store migrations.
It adds `thread_state`, `intents`, and `engine_sessions`. The last table keeps the resolved cwd,
model and native resume id outside the core snapshot. `Store.atomic` exposes the existing
SQLite transaction to the engine. Events and the state snapshot commit together; event
subscribers run only after commit. Receipts, creation events, metadata and intents also share
one transaction. Provider work runs in a later microtask and reads durable intents. Sends and controls use
separate worker lanes, so a pending transport response does not block interrupt or stop.

`thread.create` includes mandatory input, so its intent creates the session and sends that
input. Other sessions open lazily when a send becomes runnable. A queued send is persisted
before delivery and reported through `queue.changed`. Readiness comes from core with the
queue count temporarily set to zero, because core otherwise reports `waiting/queue` instead
of `done`. An unacknowledged send remains visible until a provider turn boundary arrives.
Steering bypasses readiness only when the adapter declares support.

An interaction id has one unique resolution reservation. A second device receives
`already_resolved` while the first answer is in flight. Provider resolution echoes acquire
the winning device and answer from that reservation. A failed answer retains its reservation:
retrying an answer with uncertain provider delivery is unsafe.

On restart, saved live work receives an unexpected process exit, expiring interactions and
settling runs and background tasks. Unattempted sends remain eligible for delivery. Running
intents receive notices and are never automatically replayed. Control intents whose old
provider session is gone also receive notices. Frames from retired session generations are
ignored. A persistence failure stops the affected session and prevents its translator from
continuing from an uncommitted position.

One timer per thread covers the earliest core deadline or idle-close deadline. Expiry applies
translator tick facts followed by a core tick. Idle resume supplies the saved native session
id and applies `process.started` before folding frames from the resumed session.

## Verification and performance

Run `bun run test apps/daemon/src/engine` for scripted-adapter tests against file-backed SQLite
and real WebSocket clients. Clocks and provider waits are controlled at their boundaries.
No real provider prompts or recordings are needed.

Run `node apps/daemon/src/engine/benchmark.ts` for a non-gating snapshot benchmark. With
50 deltas per history size, this machine measured approximately 0.19, 0.34 and 2.36 ms per
repository apply at 10, 100 and 1,000 items. JSON snapshots were 5,150, 39,800 and 387,200 bytes.
Snapshot serialization and validation scale with history because ADR 0007 requires a full
core snapshot in every commit. Intent scans select only outstanding rows. Incremental
snapshot storage would require a separate core persistence contract.

The snapshot decoder validates the core state while retaining the original JSON fields.
A public, versioned core snapshot codec would remove the engine's need to maintain that
validator. This is requested in the PR rather than changing core in this workstream.
