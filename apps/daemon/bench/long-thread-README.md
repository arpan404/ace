# Long-thread benchmark

Run from the repository root with Node 24 or newer:

```sh
node --expose-gc apps/daemon/bench/long-thread.ts
```

This is a standalone measurement, not a test suite. It creates a temporary SQLite store, feeds the canonical append API one million main-thread items across 2,000 turns, adds 2,000 approvals and 48 linked subagent threads, drains the search indexes, closes the store, and reopens it before query measurements. It never launches a provider CLI. The task owner explicitly permitted this benchmark; repository tests remain merge-only.

The deterministic `multiDayThread` iterator is exported from `@ace/fake-daemon` for the web performance harness. Consume it incrementally. Each record has `threadId`, `at` and a canonical `payload`. The iterator retains no transcript array and includes text that exceeds the blob threshold, full shell output, edits with known line counts, failed commands, answered approvals, token usage and independent child threads.

Seed batches contain at most 128 records or approximately 512 KiB of encoded input, plus the current record. JSON lines report progress and RSS/heap at each 100,000 items. Measurements report the first call, median, p95 and maximum over 100 pages. Search measurements cover common text, blob-only text, tool output and the child-thread tree. Catch-up includes the latest 25 turns and the full five-day range.

Arguments use `--name=value`:

```sh
node --expose-gc apps/daemon/bench/long-thread.ts --items=1000000 --turns=2000 --subagents=48 --database=/tmp/ace-long-thread.sqlite
```

Use `--phase=seed-only` with an explicit database path to seed and close without querying. This lets a later read phase use freshly loaded reader code.

To remeasure a retained fixture with the current reader implementation without reseeding:

```sh
node --expose-gc apps/daemon/bench/long-thread.ts --phase=read --database=/tmp/ace-long-thread.sqlite
```

An explicit database path retains the database for inspection. Use a new path. The default temporary database is removed on completion. Targets are below 50 ms for turn pages, below 150 ms for search pages, and below 50 ms for catch-up. Report measured numbers in the PR; do not infer that tests passed from these measurements.
