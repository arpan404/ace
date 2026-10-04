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

## Long-thread search

`thread-search.process.test.ts` adds behavior guards for full message interiors,
chunk and delta boundaries, unique item paging, creation-sequence/turn metadata,
plain UTF-16 highlight offsets, output-byte restart cursors, all five filters,
authorized descendant scopes, tombstones, replacements, rollback and upgrading an
already-current global index. These tests are **not executed (tests run at merge)**.

Mutation cases each guard is designed to kill, also **not executed (tests run at merge)**:

- Retain only head/tail, or return update sequence instead of creation sequence.
- Drop chunk overlap, drop streamed suffixes, accept an incompatible delta field,
  or return one hit per matching chunk instead of one per item.
- Read all output into one string, discard the durable byte cursor, advance the
  byte cursor before the chunk write, or report ready with output bytes pending.
- Treat every typed field as tool output, omit command/file/error categorization,
  or index raw provider data.
- Expand the family implicitly, forget scope fingerprinting, ignore tombstones,
  or let newly appended rows cross an active page ceiling.
- Skip index deletion on replacement/deletion, write outside the canonical
  transaction, or reuse the old global cursor for the additive full-text index.

Static typechecking passes for `packages/search`. SQLite query behavior, indexing
throughput and long-thread latency require execution by the merge gate or the
explicitly authorized feature benchmark. No test suite or probe was run here.

Additional long-thread guards cover multi-term matches across separate chunks,
exact scope isolation for IDs sharing FTS tokens, UTF-16 source read boundaries,
whitespace-heavy snippets, output-source fairness and missing-source recovery.
Their mutation cases are **not executed (tests run at merge)**: require all terms
in one chunk; authorize via tokenized ID phrases; split UTF-16 surrogate pairs;
clip highlights after a long prefix; drain only the oldest source; report missing
bytes as ready; busy-loop startup backfill; or drop the pending job on recovery.

Live-retention guards verify that `acknowledgeDeletion(seq)` advances each cursor
only when it owns the preceding sequence, so subsequent live events are indexed
without restarting and queued backfill is never skipped. Selective multi-term
paging pins its bounded posting-count anchor across changing token frequencies.
Mutation cases are **not executed (tests run at merge)**: omit eventless gap
acknowledgement; advance over unindexed history; fan out from broad OR matches;
scan full common-term frequencies; or recompute the anchor on continuation.
