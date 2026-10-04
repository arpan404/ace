# 0006: Large payloads: output streams, capped raw data, paged snapshots

Date: 2026-10-02. Status: accepted.

## Context

Review of the core engine and daemon (PRs #1 and #2) found three ways data grows without bound:

- **Tool output is re-sent in full.** A shell call's output accumulates in `ToolDetail.shell.output`. Every later `item.updated` for that call (status change, exit code) carries the whole accumulated string. A probe with 10 MB of output produced a 10.5 MB `item.updated`, and the event log stores it again each time.
- **Raw provider payloads are unbounded.** `RawPayload.data` holds whatever the provider sent. Tool results such as file reads, MCP responses and images can be megabytes.
- **Snapshots contain the whole thread.** A `ThreadView` snapshot includes every item ever created. Long threads produce snapshots that are too large and slow for mobile clients on cellular links.

Agents routinely run builds, test suites and log tails, so this is the normal case, not an edge case.

## Decision

### 1. Tool output is a stream, not a field

- Each tool call that produces output gets an **output stream**, identified by `streamId` (one per item and channel, e.g. combined stdout/stderr).
- The daemon stores stream chunks in an append-only `output_chunks(stream_id, offset, bytes)` table, outside the event log.
- `item.delta{field: "output"}` events keep delivering live output to subscribed clients. They are also what fills the stream.
- In the item itself, `ToolDetail.shell.output` is replaced by an `output` summary: `{ streamId, bytes, tail, truncated }`. `tail` is the last 4 KiB, enough for list views and status lines. **`item.created`/`item.updated` never carry more than the tail.**
- Clients fetch older output on demand with a new wire request, `output.read{ streamId, offset, limit }`. It returns at most 256 KiB per call.
- Output deltas are still persisted individually. Retention (below) bounds them.

### 2. Raw payloads are capped in events

- `RawPayload.data` is limited to 64 KiB when serialised. Larger raw payloads are stored in a `blobs(id, sha256, bytes)` table, and the event carries `{ type, name, blobRef, size, preview }` instead. `preview` holds the first 2 KiB.
- Adapters still pass full raw data to core. The daemon applies the cap when it persists and sends events, so core and adapters stay unaware of storage.

### 3. Snapshots are windowed

- A `thread` subscription snapshot carries open/active agents, runs, interactions and background tasks, their required ancestors, and the most recent settled entities (up to 200 and 128 KiB per collection). Older entities are available through `entities.page` with exclusive creation-sequence cursors in `entitiesBefore`. Items carry **only the most recent window**: by default the last 200 items or 1 MiB, whichever is smaller. It also carries `itemsBefore: cursor | null`.
- A new wire request, `items.page{ threadId, before, limit }`, returns older items in order, so clients load history on scroll.
- Live events after the snapshot are unaffected. A client holding a windowed view still applies all events. An event for an item outside its window is ignored, unless the client is tracking that item (e.g. an open detail view).

### 4. Retention

- Events, output chunks and blobs are kept for the life of the thread. Deleting a thread deletes all three.
- Item deltas older than 30 days in archived threads may be compacted: they are replaced by the item's final state, and their sequence numbers are kept as tombstones so replay cursors stay valid. Implemented later; noted here so nothing depends on deltas living forever.

## Consequences

- **Protocol change before clients exist:** `ToolDetail.shell.output` becomes an `output` summary, `RawPayload` gains a blob-ref form, and the wire protocol gains `output.read` and `items.page` plus `itemsBefore` on thread snapshots. This is cheap to do now and expensive after clients ship.
- Core stops accumulating full output in its state. It keeps byte counts and the tail; the daemon owns the stream. That also removes core's largest memory cost.
- Projection must handle windowed views and paging.
- Delta-heavy sessions still write one row per delta. If profiling shows this matters, the daemon may coalesce consecutive deltas for the same item within a short window (≤ 50 ms) before appending, keeping order and sequence semantics.

## Implementation choices

Limits count UTF-8 bytes. Output tails and canonical appends also fit within 4 KiB of JSON string content after escaping; control characters can therefore shorten the retained tail. Output reads return base64 so arbitrary byte offsets do not corrupt multibyte characters. Oversized output facts become canonical deltas of at most 4 KiB; the adapter delta fact shape stays unchanged. Summary objects belong to core and are rejected in adapter drafts, including partial details that omit their kind. Legacy string output in drafts is accepted as an append-only source and translated into suffix deltas, including details inheriting their kind from the call or existing item. Missing or explicitly undefined output preserves the current summary. A stream combines stdout and stderr for its shell item.

Item cursors are exclusive creation sequences. Snapshots take the newest contiguous suffix within both limits. Item pages return at most 200 current items in creation order and allow a single item to exceed the snapshot byte budget. Projection can seed a tracked detail item and merge older pages while preserving newer live values.

Raw blobs contain JSON-serialized data, with byte sizes and hashes computed over those bytes. They are deduplicated within a thread and deleted with that thread. Blob retrieval is left for the detail/debugging API; this decision adds only output reads and item pages to the wire protocol.

Text and reasoning deltas both append to reasoning and notice items. Messages accept only text, and shells accept only output. The shared projection delta function owns these rules.

### Long-thread implementation (2026-10-03)

Intake pauses above 256 queued frames (or a quarter of the byte budget) and resumes below 64 (or a sixteenth). The line reader checks pressure between lines within a single stdout read; JSON-RPC, SDK iterators and event streams use the same session flow port. A much larger last-resort cap ends that provider session with a durable notice and permits explicit resume.

The mailbox accumulates at most 256 frames or 256 KiB until the next 1 ms batch timer. Adjacent appends merge within 4 KiB, preserving structural fact boundaries. Acknowledgement follows the SQLite commit containing canonical events, state records and SDK recovery offsets/provenance. Unacknowledged input can be replayed by its provider; committed facts are never acknowledged from memory alone. SQLite admission occurs before stateful translation, and transient contention retries without poisoning the actor. History publication pauses intake and Store-writing engine work while WAL readers remain available. Timers catch failures and retry with bounded delays; delegation failures cannot monopolize the earliest deadline.

Replay has both count and byte budgets. Gaps beyond either budget receive a fresh snapshot. Outbound event batches stay below 1 MiB, including after coalescing. A snapshot with many simultaneously active entities is streamed as ordered `snapshot.part` fragments; transport pressure pauses fragment production. `subscription.ready` releases one of the client's four in-flight subscriptions. Durable command replay permits eight in flight. These limits bound work in progress without rejecting a thread for its historical entity count.
