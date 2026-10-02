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

Subscribed threads share an owned cache rebuilt from their stored events. Appends update its view and host-wide cursor. The last unsubscribe releases the cache. Snapshots contain JSON data; clients can continue folding with `@ace/projection`. Views carry parent links and a children index, ordered transcript ids, agents, runs, interactions, background tasks and latest per-agent usage. Status changes are facts supplied by the future engine, not derived here.

An independent `daemon-lock.sqlite` connection holds an exclusive transaction for the daemon lifetime. It prevents a second daemon from opening `events.sqlite`, and a process crash releases the OS lock. Never delete the lock database while a daemon runs. `daemon-lock` is diagnostic owner metadata. Shutdown closes the server and sockets, then the event store, then the lock connection. Startup failures unwind the resources already acquired. SQLite's [file-locking documentation](https://www.sqlite.org/lockingv3.html) describes the underlying local-file locks.

The daemon writes a random 32-byte hex token to `daemon-token`, mode 0600, and keeps a persistent `host-id`. Neither contains provider credentials. A socket must first send a version-1 `hello` with its device id and token. Invalid or missing authentication produces an error and close code 4001. Token comparison uses equal-length buffers and `timingSafeEqual`. Binary and malformed input are rejected, and a command's device must match its authenticated device.

## Subscribe, replay and sequence coverage

Each subscription has an independent cursor. The server registers its live listener before capturing a fixed log head. During bootstrap it buffers live publications. It then sends either a snapshot at that head or the stored events after the supplied cursor through that head. Finally it drains buffered events strictly above the cursor, then switches to live delivery. No asynchronous work separates these steps. This makes replay and the live stream one continuous sequence without overlap.

Omitting `afterSeq` requests a snapshot. A replay gap above 5,000 host events also requests a snapshot. A cursor ahead of the log is an error. Unsubscribe and socket closure release subscriptions and their caches. Ping receives pong; idle sockets close with code 4008.

Sequence numbers are host-wide. In this milestone, every subscription receives all host events, including a thread subscription. A thread fold advances its cursor across other threads but only changes its own thread view. This preserves strict gap detection without pretending that intentionally filtered sequences were lost. Clients must retain the last successfully folded sequence and reconnect with `afterSeq`. A projection refuses gaps without advancing or changing the view, and ignores duplicate or older sequences.

## Backpressure

Above 256 KiB of socket buffering, outgoing event batches queue. Only consecutive deltas for the same subscription, thread, agent, item and field can concatenate. Updates, other items and intervening events break a coalescing run. Stored events stay unchanged.

A coalesced wire event keeps the last event's `seq`, id and timestamp, and adds optional `firstSeq`, the first covered sequence. Its append contains the concatenated text. The shared projection accepts it only when `firstSeq` immediately follows the view cursor, then advances to `seq`. Partly overlapping ranges require resync because their text cannot be divided safely. This transport extension is validated in `wire.ts` and does not change the canonical stored `Event` schema.

The outbox checks pressure periodically and on writes. If buffering stays above 4 MiB for 5 seconds, or queued input would exceed 4 MiB, it closes with code 4009. The client reconnects from its last applied cursor and replays original events. Control messages flush older queued events first so results and heartbeat responses retain delivery order.

## Engine command port

`CommandHandler.handle(command, store)` is synchronous. It returns a result carrying the command id and appends facts through the transaction-owned store. Retrying an id returns the saved result, including failed results, without running its handler again. A thrown exception rolls back events, projection and receipt, allowing a retry.

The stub implements archive and the opt-in development creator. Other commands return `not_implemented`. The engine should commit durable intent through this port, then perform provider or network work after commit. Async side effects cannot be made atomic by holding a SQLite transaction open. Provider adapters, process spawning and derived status belong to later milestones.

## Decisions still open

- Should thread subscriptions filter payloads? That needs an explicit watermark or covered-range message so clients can distinguish host-wide gaps from scope filtering without receiving unrelated payloads.
- Should coalesced coverage use a batch-level range rather than `firstSeq` on the delivered event? A client package should settle that before wire version 1 ships beyond local development.
- Which durable intent or outbox contract will the engine use for provider work after a command commits?
- The append-only log and command receipts currently have no retention policy. Retention will need a replay floor and a snapshot fallback.
