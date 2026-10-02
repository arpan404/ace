# Local thread search

`@ace/search` adds FTS5 indexes to the daemon's existing SQLite database. The daemon stages appended events in their transaction, coalesces streaming items, resumes backfill on startup and serves transcript and palette queries from independent read-only workers. It never starts a provider CLI.

## Wire API

After the normal authenticated hello, send a read request:

```json
{
  "type": "search.query",
  "requestId": "palette-1",
  "text": "comp",
  "scope": "threads",
  "limit": 30
}
```

The response is `search.results` with the same `requestId`, `hits`, `generation` and a nullable `cursor`. Send the cursor with the same query and filters for the next page. A changed index returns `search.error` with `search_cursor_stale`; restart from the first page. Request ids correlate asynchronous responses, which can arrive after other socket messages.

`scope: "threads"` searches title prefixes. Empty text lists titles by creation date, newest first. `scope: "items"` searches messages, reasoning, tool titles and typed details, outputs, notices and thread titles. `mode: "tokens"` is the default, with literal terms joined by AND. `mode: "substring"` searches a literal substring of at least three Unicode characters, useful for identifier fragments, paths and CJK. FTS operators supplied by a client have no special meaning.

Optional `filters` accepts `workspaceId`, `provider`, `after`, `before`, `status`, `agentId` and `kind`. Date bounds are inclusive epoch milliseconds and refer to document creation. Agent and item-kind filters apply to documents; title documents have no agent. `limit` defaults to 30 and cannot exceed 100. Text is capped at 512 UTF-16 units, request ids at 128 and cursors at 2,048.

Each hit includes `threadId`, bounded `threadTitle`, optional `itemId` and `agentId`, workspace/provider/status, `statusSeq`, kind, creation time, bm25 score, `title` and `snippet`. Status is a snapshot at `statusSeq`; clients use their canonical thread subscription to display live status and must not overwrite a newer subscription with an older search hit. The latter two contain plain `text` and half-open UTF-16 `highlights`. Render these as text ranges. Snippets can include ellipses and omitted output, so offsets refer to the returned text, not the original output stream.

```json
{ "type": "search.status", "requestId": "progress-1" }
```

`search.progress` reports `indexedSeq`, `headSeq`, `pending`, `indexWrites`, `generation` and `ready`. `indexedSeq` is the durable event-consumption checkpoint; some consumed items can still await an FTS flush. `ready` requires the checkpoint to equal the source head and no dirty documents. `indexWrites` counts logical document rewrites, not individual SQL statements. Both FTS indexes are updated for each logical rewrite.

Search requires the same `read` scope as subscriptions. Host/admin and read devices can use it; operate-only devices cannot. Revocation also prevents a pending query response from being delivered. The scope currently grants access to all workspaces, as it does for replay. Query and status requests bypass command receipts.

## Package API and ownership

`SearchIndex` takes a caller-owned `DatabaseSync` and optional `{ trigrams, readOutput }`. The output reader accepts thread id, stream id, byte offset and a limit of at most 64 KiB, returning bounded bytes or undefined. The daemon supplies its scoped output store; missing storage falls back to the summary tail. Creation, completion updates and rebuild read capped head/tail ranges; deltas do no stream reads. `append(events)` consumes validated canonical events in sequence order and stages text; call it inside the event append transaction. Metadata changes can use `observeThread(thread, seq)` in that same transaction. `flush()` publishes up to 128 dirty documents. It accepts a batch limit from 1 to 256. The daemon calls it every 100 ms. FIFO order uses the sequence when a document first became dirty, so continuing streams do not starve other documents.

`backfillBatch(source)` reads at most 256 events. `backfill(source, { signal, onProgress, yield })` yields between batches and resumes from SQLite's committed checkpoint. The source supplies `headSeq()` and bounded, host-wide `readEvents()` in sequence order. A page covers deleted sequence gaps; a short page covers through the current head. Do not supply a filtered source. Its optional `getThread()` supplies current authoritative metadata during replay, so older events cannot make a working thread appear done. The daemon provides this port through its existing public store API.

`rebuild(source, options)` clears derived documents and postings, invalidates existing cursors and runs the same resumable backfill. Current thread metadata remains available during replay. `deleteThread(id)` removes all of that thread's derived rows and postings, using bounded batches within one transaction. The daemon coordinates this with source-history deletion in its transaction. Progress uses a durable pending counter rather than scanning dirty rows.

`query(input)` is a synchronous standalone reader useful for tests and benchmarks. The daemon uses `SearchQueries(databasePath).query(input)`, an asynchronous reader with a separate WAL snapshot per request. Transcript and palette readers each admit at most 16 outstanding requests, with independent workers and queues; a broad transcript query cannot hold the palette queue. Excess admission and reader failures return `search_failed`. Close the reader and abort backfill before closing the owning database. The worker reader requires a file-backed database.

Rendered fields retain at most 8,192 UTF-16 units of head and 8,192 of tail, plus an omission marker. Small staged bodies store their text once. A tagged encoding preserves unmatched UTF-16 halves across split deltas and restart; cap boundaries retain whole characters. Typed extraction visits at most 256 values, eight nesting levels and the first/last 64 array entries. Raw/native provider payloads, image data and blobs are not indexed. Typed output deltas remain searchable through the bounded stream accumulator. Pending documents live on disk, not in a history-sized memory queue.

## Verification and benchmarks

```sh
bun run fmt
bun run lint
bun run typecheck
bun run check:size
```

Per the repo owner, tests, mutation experiments and benchmarks run only at merge. The behavior tests are written but final runtime verification **needs run at merge**. `bench/mutations.json` lists the cases the tests are designed to kill, marked **not executed (tests run at merge)**. `bench/mutations.py` is an opt-in merge-time runner, not a local gate.

The non-gating `bench/search.ts` benchmark defaults to one million items across 10,000 threads and 100 workspaces. It compares unicode61 alone with unicode61 plus trigram in separate Node processes, using 256-event transactions, a 16 MiB SQLite page cache and a bounded synthetic corpus. It measures ingestion, 10,000 individual streamed deltas followed by one flush, query p50/p99, title palette queries, final database size and process peak RSS. Each query uses 40 samples. Token queries receive one warmup; substring/palette samples include the first read. These are engine timings, without WebSocket or worker startup overhead. Common terms deliberately match nearly every item.

`SEARCH_BENCH_ITEMS` can reduce the corpus for local iteration. `SEARCH_BENCH_MODE=prose` or `dual` selects one configuration. Benchmarks have no gating latency threshold. Historical results from before the runtime-verification restriction and final query changes, and the tokenizer trade-off, are in [ADR 0035](../../docs/adr/0035-search.md). Updated measurements need run at merge. `bench/outputs.ts` additionally measures bounded output-summary completion reads and document writes.
