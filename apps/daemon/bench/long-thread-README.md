# Long-thread benchmark

Run from the repository root with Node 24 or newer:

```sh
node --expose-gc apps/daemon/bench/long-thread.ts
```

This is a standalone measurement, not a test suite. It creates a temporary SQLite store, feeds the canonical append API one million main-thread items across 2,000 turns, adds 2,000 approvals and 48 linked subagent threads, drains the search indexes, waits for public turn-index coverage to become ready, closes the store, and reopens it before query measurements. It waits again after reopen so turn replay and range migration finish before measurement. It never launches a provider CLI. The original task allowed measurement; the review-round owner instruction prohibits running benchmarks. The revised workloads need run at merge.

The deterministic `multiDayThread` iterator is exported from `@ace/fake-daemon` for the web performance harness. Consume it incrementally. Each record has `threadId`, `at` and a canonical `payload`. The iterator retains no transcript array and includes text that exceeds the blob threshold, full shell output, edits with known line counts, failed commands, answered approvals, token usage and independent child threads.

Seed batches contain at most 128 records or approximately 512 KiB of encoded input, plus the current record. JSON lines report progress and RSS/heap at each 100,000 items. Measurements report the first call, median, p95, maximum and process memory over 100 pages. Search measurements cover common text, blob-only text, tool output, the child-thread tree, two common terms that occur in disjoint items, common plus rare terms, and disjoint queries under tree scope and message filtering. Coverage records the disjoint-query result counts. Catch-up includes the latest 25 turns and the full five-day range by both sequence and time, plus a time cutoff inside a turn.

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
