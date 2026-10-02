# 0035: Local full-text search across threads

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe thread lists and a command palette in t3code, parallel sessions in Codex, Claude Code and Cursor, and Antigravity's command center. They do not establish that any product searches every provider's tool output with restart-safe indexing, filters and stable pagination. This is a gap in the evidence, not a claim that those products lack search. ace needs one local search API for a title palette and a transcript search view. This implementation uses those inventories only as feature context and is written from our protocol and SQLite's primary documentation.

## Decision

`@ace/search` owns its tables, bounded text extraction, incremental event consumer, queries and rebuild worker. Use FTS5 in the daemon database, on the store's connection. This makes event append, durable search staging and its sequence checkpoint atomic. An attached database under WAL would complicate crash atomicity and backup. Search is derived data and its own schema version does not change the daemon's migration numbering.

Each thread has metadata and one title document. Each item has a document keyed by thread and item. Metadata filters join the thread row; status and title changes never rewrite all items. Only rendered canonical fields are indexed, including message text, reasoning, tool titles, typed tool arguments, file changes and output. Raw provider payloads, credentials, images and blobs are excluded.

Documents retain at most 8,192 UTF-16 units of head and 8,192 of tail per field, with a visible gap marker. Strings are sliced before combining; extraction traverses a bounded number of typed entries. Each delta updates this bounded durable staging row in O(change), never loads transcript history. Incomplete items become dirty and flush on completion or every 100 ms, at most 128 documents per tick. The timer is a fixed maximum wait, so a continuous stream remains searchable. Each flush does one logical index write per document per batch, recorded in durable statistics. A restart keeps staged text and dirty rows.

New appends advance the high-water mark in the append transaction only when contiguous with the checkpoint. Otherwise the event log itself is the durable queue. Backfill reads at most 256 events per transaction, yields between batches, and resumes from the committed checkpoint. Progress exposes consumed sequence, source head, pending documents and logical index writes. No history-sized map or in-memory queue exists. Background work is cancelled before database close.

Prose uses unicode61 with diacritic folding. A second external-content trigram index covers the same capped documents for explicit substring mode and CJK/code substring queries. Substrings shorter than three Unicode characters are rejected rather than scanning history. Titles have separate small indexes for palette mode, avoiding transcript postings. Both indexes share document text via external-content tables. Benchmark prose alone and prose plus trigram at one million items; keep the extra index only when its measured substring utility justifies its disk and ingestion cost. Measurements will be recorded below and in the PR.

## Protocol and wire additions

Add schema-only `search.ts` exports. `search.query` and `search.status` are read requests directly on the authenticated wire with a bounded request id. They bypass command receipts so pagination and polling do not create durable receipt history. Query has text, token/substring mode, item/thread scope, limit up to 100, optional cursor, and workspace, provider, date, status, agent and item-kind filters. Empty text lists recent titles only in thread mode. Dates refer to document creation time. Thread scope searches titles, including prefix matching for the palette.

Results carry thread/item identity, provider/workspace/status, weighted bm25 score, plain-text snippets and UTF-16 highlight offsets within those snippets. Titles receive weight 8, body weight 1. The client renders offsets as text, never HTML. Literal token queries are quoted and joined with AND; user FTS operators and SQL are never executed. Substring mode quotes the whole literal phrase.

Pagination orders by bm25 score and stable document row id. Cursors bind query/filter identity and committed index generation. A changed index returns `search_cursor_stale`; clients restart the query. This deliberately trades uninterrupted pagination during writes for no skipped or duplicate results and avoids retaining million-row snapshots. Cursors are validated, bounded, and never treated as authorization.

`item.deleted` is an additive canonical event so deletions remove search rows and client projections together. No provider or engine state rules change. Future thread retention must call the package's deletion API inside its retention transaction.

## Security

Search uses the daemon's existing authenticated connection and has the same local data access as thread replay. It introduces no provider login, network service or telemetry. Future scoped device authorization must check search filters at the dispatch boundary before enabling search for that device. The relay transports encrypted search requests and responses through the existing command boundary. SQL values are bound; query lengths, result counts, cursors, indexed fields and background batches are capped. Errors do not disclose SQL or stored text. Search tables have the same filesystem protection and backup sensitivity as the event log.

## Performance

Prepared mutation statements are reused. Query statements have a bounded cache. Hot append work touches one thread or item, and stream updates do not write FTS postings until a flush. SQLite's synchronous work is limited to bounded transactions and batches; a worker-thread migration remains an option if measured batches interfere with daemon responsiveness. Common-term ranking can still visit many postings; benchmark distributions must include common and selective queries, and report this cost honestly.

Primary reference: [SQLite FTS5 documentation](https://sqlite.org/fts5.html), covering unicode61, trigram, external content, bm25 and snippets. No implementation from a competitor is used.

## Validation

Use real temporary SQLite databases and authenticated WebSockets. Guard append/update/delete visibility, bounded stream writes, head/tail caps, every filter, deterministic pagination and stale cursors, rollback, crash/restart backfill, Unicode/diacritics, CJK, code identifiers and paths, literal FTS injection, title ranking and snippet offsets. Benchmarks are non-gating and report indexing throughput, query p50/p99, database size and peak RSS at one million items. Apply at least eight meaningful production mutations and require a named behavior test to fail for each before reverting them. `bun run check` is the local delivery gate.
