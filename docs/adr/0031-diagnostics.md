# 0031: Local diagnostics, structured logs and support bundles

Date: 2026-10-02. Status: accepted.

## Context

ace owns local CLI processes, native PTYs and a SQLite event store. A failed login, mismatched Node ABI or damaged disk should produce a useful explanation before the user starts a thread. The competitor inventories at `/tmp/ace-orch/research-t3code.md` and `/tmp/ace-orch/research-competitors.md` describe browser logs and troubleshooting facilities, but establish no common, redacted machine-health report across providers. That is a gap in the inventories, not evidence that those products have no diagnostics.

## Decision

`@ace/diagnostics` owns logging, health collection, a doctor registry and support export. `@ace/redaction` owns the recorder's existing redaction rules and extends them for environment values and secret-bearing settings. Provider-kit remains the owner of CLI discovery. No prompts, credentials files or recorder sessions are used.

The logger queues bounded records and keeps a bounded recent ring. A single acknowledged batch at a time crosses to a worker that performs redaction, serialization and asynchronous file writes. Overflow, oversized entries and failed writes are counted; diagnostic failures do not stop agent execution. JSONL files rotate by bytes and expire oldest first under a total byte cap. Flush and shutdown wait for the outstanding batch. Child loggers share the queue and limits. Inputs are bounded before copying and all persisted and exported bytes pass redaction.

Doctor checks have pure evaluators and injected probes. The runner starts independent checks concurrently, supplies abort signals and deadlines, and always returns an ordered report with `ok`, `warn` or `fail` and a fix hint. Node 24+, provider installed/version/login, git, node-pty ABI, Chromium, data-directory access/free space, read-only SQLite integrity and loopback port availability are checked. Unknown provider authentication warns rather than claiming a valid login. Unsupported Antigravity/ACP discovery warns explicitly. SQLite checks run in a disposable child process, killed on timeout. Integrity checking never repairs or creates a database. Missing databases warn on first use.

Support export streams a gzip tar archive with recent logs, a doctor report, versions and redacted settings. It never scans arbitrary files. Each source and the export have byte caps; sanitized text is staged in a private temporary directory so tar sizes are known without keeping files in memory. Long lines are omitted as a whole, preventing partial-token leakage. Thread event text is exported only with `--include-threads`. The archive contains no database, WAL, credential file or raw environment dump.

## Protocol and daemon integration

A new schema file defines `diagnostics.health` and a health response. The command uses the existing authenticated `command` envelope and returns a `commandResult` with optional `health`. This read-only command bypasses receipt persistence so retries return current measurements. It cannot mutate thread state. Existing messages remain valid.

Health includes event-loop delay mean/p99/max in milliseconds, RSS/heap bytes, active resource count, SQLite page bytes and WAL bytes, active sessions and named queue depths, plus logger drop counters. Unavailable metrics are nullable rather than fabricated. Engine session/queue counts use a small injected port until the engine lands. Sampling does no history scans and allows at most one collection in flight. Node's [performance hooks](https://nodejs.org/api/perf_hooks.html), [SQLite API](https://nodejs.org/api/sqlite.html) and [workers](https://nodejs.org/api/worker_threads.html) are the runtime contracts.

The daemon CLI accepts `doctor [--json]` and `support-bundle PATH [--include-threads]`. `bun run ace -- doctor` is the repository entry point. Default daemon startup remains unchanged.

## Security

Redaction replaces known API keys, GitHub tokens, JWTs, authorization headers, identity fields, home/workspace paths and configured environment values. Structured secret keys are stripped regardless of their value's format. Redaction precedes durable writes, including temporary bundle files. Unknown secrets in arbitrary prose cannot be identified perfectly; the default bundle excludes conversation content, and limits the amount exported. Files and staging directories are owner-only. A support bundle is a local file, never uploaded automatically.

## Performance and verification

Queues, rings, record depth/field budgets, batches, file count and bytes are bounded. Logger enqueue is proportional to a capped input record, never prior logs. Worker acknowledgement supplies backpressure rather than an unbounded MessagePort backlog. Bundle I/O uses stream backpressure. SQLite is isolated in a child process and has a deadline that also stops native work.

Tests exercise public APIs with fake machine probes and real filesystem, SQLite and socket edges. They verify redaction before file writes, rotation and retention across restarts, overflow counters, child levels, all check outcomes, aborted hung probes, corrupt SQLite, archive contents and thread opt-in. A non-gating benchmark reports logger throughput and peak RSS. At least eight production mutations must each fail a behavioral test before delivery.
