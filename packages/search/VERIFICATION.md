# PR 47 review fixes

Verification is static only. The owner prohibits tests, probes, mutation runs, benchmarks and CI execution during feature work. Every runtime scenario below **needs run at merge**. Regression scenarios were written before the production fixes; no failing or passing execution is claimed.

## Blocking findings

1. Historical titles could overwrite current palette postings during partial backfill. Creation now stages the title from the resolved metadata row. Updates and `observeThread` refresh the title stage from that same row, without dirtying an unchanged title. The `partial backfill publishes only` cases cover creation alone and a historical rename in the first 256 events, then restart and final replay. The existing current-status and daemon startup tests now query current and old title prefixes too.
2. Deletion looked up documents using only a thread index. It now resolves the stage's unique thread/item key to the document primary key, including a miss for a pending item. A fixed number of indexed lookups replaces repeated transcript scans. The mixed pending/indexed retention scenario covers a late pending deletion, a late indexed deletion, a surviving thread with the same item id and retention without publishing deleted staging. `bench/deletions.ts` measures this workload with 100,000 items by default, half pending before half indexed, 100 samples of each deletion type, retention latency and peak RSS. Timing and throughput **need run at merge**; functional tests contain no latency budget.

## Other findings

- Response caps now preserve code points while retaining UTF-16 offset semantics. Thread-title, title-snippet and body-snippet tests put an emoji across each cap. Output tests query all four retained boundaries with literal highlight assertions for completed and split-delta text.
- `SearchWorkerFactory` and `SearchWorker` are public injected ports. Node worker creation lives in `worker-runtime.ts`. `StoreOptions.searchScheduler` and `searchWorkerFactory` inject daemon scheduling and worker acquisition; `search-runtime.ts` owns the default 100 ms timer.
- `SearchQueries.close()` rejects pending requests immediately, waits for both terminations, and reports cleanup failure after both readers settle. Store close returns the cleanup promise while cancelling its timer, aborting replay and closing its SQLite connection synchronously. Daemon shutdown and socket fixtures await it. Controlled boundary tests cover startup failure, malformed responses, cleanup failure, two-worker completion and reentrant close/cancellation.
- The title-weight test inserts the equal-length body document first. A title weight of one would now put the body first by row id; the intended weight of eight must overcome that ordering.
- The wire test reads the persisted command-receipt count rather than relying on host sequence. The deletion test subscribes, receives the deletion event and folds it through `@ace/projection`, asserting the delivered client view as well as stored state and search results.
- The standalone append rollback test fails its injected output read after another item has been staged, without an outer transaction. It checks progress and later flush visibility, covering a savepoint rollback mutation that an outer rollback could hide.
- Real worker and socket suites are registered in the process project added on main. No process suite was executed here.

## Mutations and measurements

`bench/mutations.json` lists all review cases plus title-posting, response-cap and cleanup mutations, with their behavioral guards. Every case is **not executed (tests run at merge)**. The opt-in mutation runner targets title weight eight to one, both read-authorization branches and both metadata sequence guards. No demonstrated mutation kills are claimed.

ADR 0035 and `bench/results.json` retain historical 1M-item measurements from before the owner's restriction and before the final changes. They are not performance validation of this revision. Index/query/output/deletion throughput, p50/p99 and RSS **need run at merge**. No new timing numbers were fabricated.

## Static checks

`bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size` passed. All 543 source files are within 1,500 lines. `bun run check` and GitHub CI were not run. The comments on PR 47 were also inspected for `Integration rehearsal: findings for this PR`; no such comment was present during this review-fix run.
