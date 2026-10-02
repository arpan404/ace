# Event store and local WebSocket API

Start the daemon with `bun run --filter @ace/daemon dev`. Node 24+ executes the TypeScript directly. It prints its WebSocket URL and token-file path. Configuration comes from `ACE_HOME` (default `~/.ace`), `ACE_PORT` (default 4242, 0 selects an available port), and `ACE_LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`). The listener always binds to 127.0.0.1.

`ACE_DEV=1` enables the development creator. On an empty database the CLI creates a workspace for its current directory and a starter thread. `thread.create` then creates threads in an existing workspace. The exported store workspace API lets development tools supply other local paths. Without this flag, creation returns `not_implemented`.

## Storage and ownership

`events.sqlite` uses WAL, `synchronous=NORMAL`, foreign keys and a 5-second busy timeout. `schema_version` has one row, keyed by 1. Each numbered migration runs in the migration transaction; newer unknown versions fail startup.

- `events` stores the host-wide integer sequence, unique event id, thread id, timestamp, payload type and JSON payload. An index on `(thread_id, seq)` supports rebuilding a single thread.
- `command_receipts` stores the command id, device id, reception timestamp and JSON result.
- `workspaces` stores ids, unique paths, display names and creation timestamps.
- `threads` stores sidebar fields, archive time and the optional root agent id. `workspace_id` references `workspaces`.

Appending uses one `BEGIN IMMEDIATE` transaction. It allocates sequences after the current committed head, inserts events and updates the sidebar projection together. Rolled-back appends consume no sequence. Command handlers run in that same transaction as their receipts. Nested appends use savepoints so a caught failure cannot leak a partly inserted batch. Listeners receive committed events in order; reentrant appends wait in the publication queue behind the current batch. Subscriber errors cannot reverse a commit or stop delivery to other subscribers.

Subscribed threads share an owned cache rebuilt from their stored events. Appends update its view and host-wide cursor. The last unsubscribe releases the cache. Socket close cancels subscriptions and pending progress timers. Snapshots contain JSON data; clients can continue folding with `@ace/projection`. Views carry parent links and a children index, ordered transcript ids, agents, runs, interactions, background tasks and latest per-agent usage. Status changes are facts supplied by the future engine, not derived here. Late `agent.updated.parentId` facts move the child between parent indexes. Root creation persists `rootAgentId`. Sidebar `updatedAt` changes on thread metadata events, so snapshot and replay agree without streaming transcript payloads to the sidebar.

An independent `daemon-lock.sqlite` connection holds an exclusive transaction for the daemon lifetime. It prevents a second daemon from opening `events.sqlite`, and a process crash releases the OS lock. Never delete the lock database while a daemon runs. `daemon-lock` is diagnostic owner metadata. Shutdown closes the server and sockets, then the event store, then the lock connection. Startup failures unwind the resources already acquired. SQLite's [file-locking documentation](https://www.sqlite.org/lockingv3.html) describes the underlying local-file locks.

The daemon writes a random 32-byte hex token to `daemon-token`, mode 0600, and keeps a persistent `host-id`. Neither contains provider credentials. A socket must first send a version-1 `hello` with its device id and token. Invalid or missing authentication produces an error and close code 4001. Token comparison uses equal-length buffers and `timingSafeEqual`. Binary first frames, unsupported versions, missing tokens and a second hello close with 4001. Malformed input after authentication is rejected while keeping the connection open, and a command's device must match its authenticated device.

## Subscribe, replay and sequence coverage

Each subscription has an independent cursor. The server registers its live listener before capturing a fixed log head. During bootstrap it buffers live publications. It then sends either a snapshot at that head or the stored events after the supplied cursor through that head. Finally it drains buffered events strictly above the cursor, then switches to live delivery. No asynchronous work separates these steps. This makes replay and the live stream one continuous sequence without overlap.

Omitting `afterSeq` requests a snapshot. A replay gap above 5,000 host events also requests a snapshot. A cursor ahead of the log is an error. Unsubscribe and socket closure release subscriptions and their caches. Ping receives pong; idle sockets close with code 4008.

Sequence numbers are host-wide, but payloads are scoped. A `thread` subscription receives only its thread's events. The `threads` scope receives only `thread.created` and `thread.updated`, never token deltas. Sidebar snapshots omit `rootAgentId`; it belongs to the thread view.

An `events` message carries `afterSeq`, `throughSeq` and the scoped events in ascending order. It asserts complete delivery for that scope over `(afterSeq, throughSeq]`. Missing host sequences inside that interval were filtered, not lost. When only out-of-scope events arrive, a per-subscription timer sends `progress{subscriptionId, afterSeq, throughSeq}` with no payloads. Progress is coalesced for 250 ms, is cancelled when a matching delivery already covers it, and is cancelled on unsubscribe. Replay applies the same filter and advances immediately to the replay head, including an empty scoped replay.

Clients use `applyDelivery(view, eventsOrProgress)` for socket delivery. Its predecessor must equal the view's last `throughSeq`. All event ranges must be ordered, belong to the scope, and end within the watermark. Validation happens before folding, so an invalid interval cannot partly update a view. A duplicate interval is ignored; a missing predecessor or partial overlap requests resync without changing the view. `applyEvent` remains the strict contiguous-log fold for local canonical events. Clients reconnect with their last successfully applied view sequence.

## Backpressure

Above 256 KiB of socket buffering, outgoing event batches queue. Only consecutive deltas for the same subscription, thread, agent, item and field can concatenate. Updates, other items and intervening events break a coalescing run. Stored events stay unchanged.

A coalesced wire event keeps the last event's `seq`, id and timestamp, and adds optional `firstSeq`, the first covered sequence. Its append contains the concatenated text. `applyDelivery` validates the aggregate range against the batch predecessor, preceding delivered events and watermark, allowing filtered host holes between events. The cursor advances to `throughSeq`, which can exceed the last delivered event. Partly overlapping ranges require resync because their text cannot be divided safely. This transport extension is validated in `wire.ts` and does not change the canonical stored `Event` schema.

The outbox checks pressure periodically and on writes. If buffering stays above 4 MiB for 5 seconds, or queued input would exceed 4 MiB, it closes with code 4009. The client reconnects from its last applied cursor and replays original events. Control messages flush older queued events first so results and heartbeat responses retain delivery order.

## Engine command port

`CommandHandler.handle(command, context)` is synchronous. The context contains only bound `appendEvents`, `getThread` and `readEvents` methods, so handlers cannot own caches, close the database, or recursively enter receipt management. It returns a result carrying the command id and appends facts through the transaction-owned store. Retrying an id returns the saved result, including failed results, without running its handler again. A thrown exception rolls back events, projection and receipt, allowing a retry.

The stub implements archive and the opt-in development creator. Other commands return `not_implemented`. The engine milestone will add an internal `intents` table and worker to perform provider I/O after the receipt transaction commits. Async side effects cannot be made atomic by holding a SQLite transaction open. Provider adapters, process spawning and derived status belong to later milestones.

## Deferred work

The review settled filtering and coverage: thread payloads are filtered now, aggregates retain `firstSeq`, and batches/progress carry `throughSeq` plus their `afterSeq` predecessor. A future client must use `applyDelivery` for these messages.

The engine milestone will specify the internal intent table and worker. The agreed retention direction keeps all events and expires receipts after 30 days; this milestone still retains receipts without expiration. Receipt cleanup should ship with its operational policy in a later PR.

Paged snapshots, separate streams for large tool output, and a shared delta helper between core and projection remain follow-ups. No provider execution or core code is added here.

## Verification

`bun run check` covers format, lint, types and Vitest. Tests assert committed logs, returned views, socket messages and child-process outcomes. Timer behavior uses controlled clocks; socket pressure tests force thresholds at the transport boundary rather than relying on loopback buffer sizes. `bun run --filter @ace/projection bench` reports informational delta-fold timings; no time budget gates correctness tests.
