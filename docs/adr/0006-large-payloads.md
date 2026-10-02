# 0006: Large payloads: output streams, capped raw data, paged snapshots

Date: 2026-10-02. Status: proposed.

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

- A `thread` subscription snapshot carries every agent, run, interaction and background task (these are small and needed for status), but **only the most recent items**: by default the last 200 items or 1 MiB, whichever is smaller. It also carries `itemsBefore: cursor | null`.
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
