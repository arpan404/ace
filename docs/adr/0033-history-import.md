# 0033: Import local provider history

Date: 2026-10-02. Status: accepted.

## Context

A new ace installation should show sessions the user already has. Codex and Claude have native session pickers and forks. Cursor lists chats across workspaces but its ACP loader cannot open TUI chats. The competitor inventories at `/tmp/ace-orch/research-t3code.md` and `/tmp/ace-orch/research-competitors.md` do not establish a complete cross-provider importer. ace needs account-aware discovery, explicit history fidelity, and native continuation without copying credentials or running prompts.

Read the provider and fixture research under `docs/research`. Recorded transport fixtures are not on-disk transcripts; tests derive native records from their message content instead of treating live notifications as history. Implementations are fresh, based on ace specs and primary provider formats.

## Decision

Add `@ace/history-import` and `@ace/native-session`. History operations run in a Node worker. A private ace SQLite index stores source fingerprints and metadata, with bounded list pages. Scan each configured instance home independently. Workspace lists show root sessions, with sidechain activity contributing to their recency. Import attaches child transcripts to the agent tree. The account boundary is `{id, provider, homeDir}`. Home selection stays host-local, and instance identity stays attached to imported threads and continuation requests.

`@ace/native-session` owns bounded JSONL iteration, head/tail sampling, Codex metadata and lineage references, and Claude sidechain paths. ADR 0018 on `feat/accounts` already owns migration planning. Until it merges, the narrow reusable contract is `CodexSessionMeta`, `codexParents`, `claudeSidechainRoot`, `walkFiles`, and `readHeadTail`. Accounts should replace its private metadata schema and directory convention with these exports. Migration safety, publication and writer leases remain accounts responsibilities. Do not merge the whole accounts branch into this workstream.

Discover Claude `projects/<slug>/<id>.jsonl` and `<id>/subagents/*.jsonl`, Codex `sessions` and `archived_sessions` rollouts plus `state_*.sqlite`, and OpenCode `opencode.db` or legacy `storage/session`, `storage/message`, `storage/part` JSON files. SQLite queries are read-only, bounded and schema-probed. Unknown schemas and compressed/paginated Codex histories return an unsupported reason. OpenCode v2 and SQLite scalar records above 1 MiB are unsupported. Node SQLite lacks incremental blob handles, so SQL substring would still materialize a giant cell inside SQLite. Use metadata-only `octet_length` to refuse that case before loading it; native export is the future escape hatch. JSONL oversized records remain lossless streamed blobs. Cursor is unsupported for full import: readable agent transcripts omit results, and TUI store databases cannot be resumed through ACP. No private binary decoding is guessed.

Index JSONL with at most 64 KiB at each end. A long file's message count is a sampled lower bound, explicitly labelled `sampled`; an exact count cannot be obtained from head/tail alone. Import records an exact count after a complete stable decode. Opaque oversized or malformed records keep the count sampled. Persist path, size, mtime and ctime; unchanged files incur no content reads. Sidechain changes invalidate their parent summary. Scan uses asynchronous directory iteration and fixed-size reads, with cancellation and bounded inventories. Completed scans remove stale entries; cancelled scans do not prune.

Import reads one bounded native record at a time, maps messages, reasoning, calls, outputs and compaction to canonical items, and retains unknown records as raw notices. Historical state does not prove that a provider tree has stopped. Imported threads start `new`, and imported agents are `unresponsive` until the engine reconciles native state. Never replay historical approvals as new actionable requests.

The caller supplies a transactional `ImportSink`: begin, append agent/item, store blob, commit, rollback. Await every write for backpressure. Commit publishes the imported thread only after stable source verification. Cancellation or changed files roll back. Large raw records and oversized lines become blob references; transcript text is split into bounded items. Sinks must persist incrementally and serve windowed items under ADR 0006, never acquire a full-history projection to import. The package supplies the streaming backend contract while the engine and large-payload branches develop separately.

## Protocol and wire additions

Add schema-only `history.ts` through the `@ace/protocol/history` export. Define session summaries, list requests with workspace cwd and bounded cursors, import requests, unsupported outcomes, and imported provenance. Extend Thread additively with optional imported provenance including NativeRef and instance ID. Wire contracts use `history.list` and `history.import`; source paths never cross the wire. Authentication and request routing remain the daemon's existing boundary. These independent schemas and the sink port avoid rewriting the shared wire union during parallel development.

Continuation returns the existing adapter `resume: {nativeSessionId}` context plus instance ID and cwd. Fork continuation requires a caller-supplied native fork operation which returns the new native ID. ace never fabricates fork IDs or claims capabilities a provider lacks. No provider process is launched during discovery or import. Legacy OpenCode messages sort by stored creation time in a private SQLite file; part IDs give deterministic part order. Small part inventories sort at most 16 paths, then spill to disk.

## Security

Only host-registered absolute homes are scanned. Reject symlinks and special files, enforce directory and entry limits, validate input through Zod, and verify real paths stay inside the home. Provider files are opened read-only with no-follow semantics. SQLite uses read-only mode; immutable mode is safe only for caller-declared offline snapshots without WAL or journal files. A read-only SQLite handle can update a live database's shared-memory read marks. For live homes, stream a fingerprint-verified private copy of the database and WAL under the ace index directory, then query that copy read-only. Never open source shared-memory files through SQLite. Active rollback journals return a retry reason. This costs O(database bytes) on a changed database and avoids violating source preservation. No checkpoints, migrations or pragma writes run on provider databases. Indexes and blobs belong to ace, outside provider homes, with private permissions. Imported transcripts may contain secrets and use the same authenticated access and retention as ace-created threads.

## Performance and tests

The worker owns synchronous SQLite and JSON decoding. One operation is in flight per service. File sampling batches hold at most 16 paths. Custom sinks pull at most 16 bounded packets; the default archive writes inside the worker without sending items over IPC. A verification barrier follows sink writes before commit. Lists use SQLite ordering and capped pages; no transcript cache grows with history. JSONL record memory is capped; oversized lines stream to blobs from source byte ranges. Non-gating benchmarks cover 5,000-file cold/warm scans and streaming import, with throughput and peak RSS.

Public API tests use temporary homes and actual SQLite files. Cover each supported provider, fixture-derived content, multi-home identity, warm scans counted by actual content reads, partial final lines, unknown data, cancellation, changed sources, lineage refusal, sidechains, deletion, large records and backpressure. Compare source bytes before and after scans/imports. Apply eight meaningful mutations, require a named test failure for each, then revert.

## References

- [Codex app-server history APIs](https://learn.chatgpt.com/docs/app-server) and [local research](../research/providers/codex.md).
- [Claude CLI resume/fork](https://code.claude.com/docs/en/cli-reference) and [local history research](../research/providers/claude-code.md#8-history).
- [OpenCode session APIs](https://opencode.ai/docs/server/) and [local storage research](../research/providers/opencode.md).
- [SQLite WAL read-only and shared-memory behavior](https://sqlite.org/wal.html#read_only_databases).
- [Cursor history limitations](../research/providers/cursor.md#8-history).
