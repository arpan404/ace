# 0035: Local full-text search across threads

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe thread lists and a command palette in t3code, parallel sessions in Codex, Claude Code and Cursor, and Antigravity's command center. They do not establish that any product searches every provider's tool output with indexing that resumes after restart, filters and stable pagination. This is a gap in the evidence, not a claim that those products lack search. ace needs one local search API for a title palette and a transcript search view. This implementation uses those inventories only as feature context and is written from our protocol and SQLite's primary documentation.

## Decision

`@ace/search` owns its tables, bounded text extraction, incremental event consumer, queries and backfill job. Use FTS5 in the daemon database, on the store's connection. This makes event append, durable search staging and its sequence checkpoint atomic. An attached database under WAL would complicate crash atomicity and backup. Search is derived data and its own schema version does not change the daemon's migration numbering.

Each thread has metadata and one title document. Each item has a document keyed by thread and item. Metadata filters join the thread row; status and title changes never rewrite all items. Only rendered canonical fields are indexed, including message text, reasoning, tool titles, typed tool arguments, file changes and output. Raw provider payloads, image data and blobs are excluded. Search never reads provider credential stores. Printed secrets in canonical messages or tool output remain part of the local transcript and its index.

Documents retain at most 8,192 UTF-16 units of head and 8,192 of tail per field, with a visible gap marker. Strings are sliced before combining; extraction traverses a bounded number of typed entries. Each delta updates this bounded durable staging row in O(change), never loads transcript history. Incomplete items become dirty and flush on completion or every 100 ms, at most 128 documents per tick. Dirty documents are ordered by the sequence of their first unpublished change. A continuously dirty stream cannot starve another item. With up to 128 pending documents the timer bounds idle visibility delay to 100 ms; larger backlogs need more ticks and are reported through progress. Each flush does one logical index write per document per batch, recorded in durable statistics. A restart keeps staged text and dirty rows.

New appends advance the high-water mark in the append transaction only when contiguous with the checkpoint. Otherwise the event log itself is the durable queue. Backfill reads at most 256 events per transaction, yields between batches, and resumes from the committed checkpoint. Progress exposes consumed sequence, source head, pending documents and logical index writes. No history-sized map or in-memory queue exists. Background work is cancelled before database close. During startup and live appends, current authoritative thread metadata overrides older replay by sequence, so search never downgrades an active thread to a historical done status. The package also exposes an explicit rebuild that clears derived postings and resumes through the same backfill job.

Prose uses unicode61 with diacritic folding. A second external-content trigram index covers the same capped documents for explicit substring mode and CJK/code substring queries. Substrings shorter than three Unicode characters are rejected rather than scanning history. Titles have separate small indexes for palette mode, avoiding transcript postings. Both indexes share document text via external-content tables. Benchmark prose alone and prose plus trigram at one million items; keep the extra index only when its measured substring utility justifies its disk and ingestion cost. The measurements below record the trade-off.

## Protocol and wire additions

Add schema-only `search.ts` exports. `search.query` and `search.status` are read requests directly on the authenticated wire with a bounded request id. They bypass command receipts so pagination and polling do not create durable receipt history. Query has text, token/substring mode, item/thread scope, limit up to 100, optional cursor, and workspace, provider, date, status, agent and item-kind filters. Empty text lists recent titles only in thread mode. Dates refer to document creation time. Thread scope searches titles, including prefix matching for the palette.

Results carry thread/item identity, provider/workspace/status and its `statusSeq`, weighted bm25 score, plain-text snippets and UTF-16 highlight offsets within those snippets. Titles receive weight 8, body weight 1. The client renders offsets as text, never HTML. Hit status is a snapshot; clients display live status from the canonical subscription and reject a search status older than that subscription sequence. An asynchronous query must never overwrite a newer working state with an older done snapshot. Literal token queries are quoted and joined with AND; user FTS operators and SQL are never executed. Substring mode quotes the whole literal phrase.

Pagination orders by bm25 score and stable document row id. Cursors bind query/filter identity and committed index generation. A changed index returns `search_cursor_stale`; clients restart the query. This deliberately trades uninterrupted pagination during writes for no skipped or duplicate results and avoids retaining million-row snapshots. Cursors are validated, bounded, and never treated as authorization.

`item.deleted` is an additive canonical event so deletions remove search rows and client projections together. No provider or engine state rules change. Future thread retention must call the package's deletion API inside its retention transaction.

## Security

Search uses the daemon's existing authenticated connection and has the same local data access as thread replay. It introduces no provider login, network service or telemetry. After merging remote access, both commands require its `read` scope before dispatch. Read grants the same host-wide history access as subscriptions. The daemon checks authority again before delivering an asynchronous result, so revocation cannot disclose a pending response. The relay has not landed; search adds no transport and can use the same authenticated wire when that work arrives. SQL values are bound; query lengths, result counts, cursors, indexed fields and background batches are capped. Errors do not disclose SQL or stored text. Search tables have the same filesystem protection and backup sensitivity as the event log.

## Performance

Prepared mutation statements are reused. Query statements have a bounded cache. Hot append work touches one thread or item, and stream updates do not write FTS postings until a flush. Index writes remain synchronous, inside bounded transactions and batches on the existing store connection. Daemon queries run in a separate read-only worker with at most 16 outstanding requests and an 8 MiB page cache. Each query pins metadata, postings and rank statistics to one WAL snapshot; a broad query cannot stall event append on the daemon's event loop. Common-term ranking can still visit many postings; benchmark distributions must include common and selective queries, and report this cost honestly.

Primary reference: [SQLite FTS5 documentation](https://sqlite.org/fts5.html), covering unicode61, trigram, external content, bm25 and snippets. No implementation from a competitor is used.

## Validation

Use real temporary SQLite databases and authenticated WebSockets. Guard append/update/delete visibility, bounded stream writes, head/tail caps, every filter, deterministic tied and unequal-rank pagination and stale cursors, FIFO fairness, rollback, crash/restart backfill, Unicode/diacritics, CJK, code identifiers and paths, literal FTS injection, title ranking and snippet offsets. Benchmarks are non-gating and report indexing throughput, query p50/p99, database size and peak RSS at one million items. Eleven meaningful production mutations were applied, each failed its named behavior test, and all were reverted; the experiment record is in `packages/search/bench/mutations.json`. `bun run check` is the local delivery gate.

## Measurements and tokenizer choice

The release benchmark indexed 1,000,000 items across 10,000 threads and 100 workspaces, in separate Node 26.8.1 processes on a shared Darwin arm64 development host. The corpus contains prose, identifiers, paths and CJK in every item. Forty samples per query are informational; p99 is effectively the slowest observed sample at this sample count. Other work on the host makes throughput comparisons noisy. Raw results are committed at `packages/search/bench/results.json`.

| Metric                                              |          unicode61 | unicode61 + trigram |
| --------------------------------------------------- | -----------------: | ------------------: |
| Item ingestion                                      |     12,752 items/s |      11,325 items/s |
| Individual stream deltas                            |    10,342 events/s |     24,056 events/s |
| FTS document rewrites for 10,000 deltas, then flush |                  1 |                   1 |
| Database size                                       |          541.1 MiB |           989.7 MiB |
| Peak process RSS                                    |          191.8 MiB |           192.1 MiB |
| Unique token query p50 / p99                        |   0.087 / 0.857 ms |    0.092 / 0.362 ms |
| 100-hit token query p50 / p99                       |   0.337 / 0.845 ms |    0.333 / 0.582 ms |
| About 1,000-hit token query p50 / p99               |   1.299 / 1.901 ms |    1.307 / 1.829 ms |
| Million-hit prose query p50 / p99                   | 752.9 / 2,060.8 ms |  800.1 / 3,258.8 ms |
| Recent-title palette p50 / p99                      |  0.159 / 23.567 ms |    0.128 / 0.313 ms |
| Title-prefix palette p50 / p99                      |  7.579 / 73.479 ms |    5.589 / 6.033 ms |

Trigram substring queries measured 102.9 / 124.4 ms for a path matching about 1,000 items, 798.3 / 3,810.5 ms for a fragment matching a million code identifiers, and 616.3 / 2,423.1 ms for a CJK fragment present in every item. Exact token queries for paths and identifiers use the cheaper prose index by default. Trigram raises disk use by about 83%, with nearly unchanged process RSS in this run. Retain it because interior code/CJK substrings cannot use unicode61 postings without scanning documents. Full position detail is needed for phrase matching, bm25 weights and highlights; reducing detail would lose those behaviors.

Broad queries remain a performance limit. Exact relevance with a stable row-id tie break must evaluate many matching postings. The query worker keeps that work off the daemon event loop, and the title index keeps the palette independent of transcript size. No latency threshold gates tests. Index writes stay on the synchronous store connection in bounded batches, preserving append atomicity; they have not moved to a separate writer connection.
