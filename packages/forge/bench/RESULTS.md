# Forge verification

Run on 2026-10-02 in the feature worktree with Node 26.8.1 on Darwin arm64 using native TypeScript execution. Benchmarks are non-gating; process RSS is the cumulative high-water mark, including the in-memory SQLite benchmark database. The production ledger uses a file database and removes acknowledged payloads.

| Operation                                                 |   Samples |       Ops/s |  µs/op | Peak RSS MiB |
| --------------------------------------------------------- | --------: | ----------: | -----: | -----------: |
| Check mapping                                             |   100,000 |     343,259 |   2.91 |        106.4 |
| Unchanged review index, 2 comments                        | 1,000,000 | 176,748,708 |   0.01 |        106.7 |
| Unchanged review index, 2,000 comments                    | 1,000,000 | 158,676,637 |   0.01 |        109.2 |
| Metadata-only revision, 2,000 comments                    |   100,000 |  22,317,488 |   0.04 |        109.2 |
| Streamed tail, 50 KB chunk                                |     2,000 |       1,370 | 729.72 |        126.2 |
| SQLite admission and acknowledgement                      |    10,000 |      22,353 |  44.74 |        242.1 |
| Indexed duplicate lookup after 10,000 deliveries          |   100,000 |   1,629,154 |   0.61 |        243.0 |
| Warm status, 2 comments, 1 conditional comment page       |     2,000 |      81,242 |  12.31 |        109.0 |
| Warm status, 2,000 comments, 20 conditional comment pages |     2,000 |      31,382 |  31.87 |        112.2 |

`bun run --filter @ace/forge bench` runs both workloads. The warm status benchmark uses a prepared injected command runner to isolate API decoding/cache CPU from process startup. It still reads independent resource pages and hashes the GraphQL response bytes; no network or subprocess throughput claim is implied. Status RSS is from its separate process; other RSS entries are cumulative within the first benchmark process.

The review measured the old one-shot candidate API at 2.70 µs for two unchanged comments and 990.43 µs for 2,000. The retained index now performs O(1) work for unchanged snapshots and metadata-only revisions with unchanged collections. Cached pages are decoded once per retained representation. Warm status cost scales with conditional page requests, without traversing their historical records. Changed representations remain bounded by the page/record/byte limits. Incoming log processing is linear in chunk bytes. Duplicate detection uses SQLite's primary-key index rather than an in-memory session history scan.

## Deliberate mutations

Each mutation was applied to production code alone, killed by the listed behaviour test, and reverted. No mutation remains in the delivered implementation. All twelve exited with a failed Vitest test, rather than a tooling error.

| Mutation                                      | Broken behaviour caught by test                                   |
| --------------------------------------------- | ----------------------------------------------------------------- |
| M1: ignore merged flags                       | Merged PR stays merged even when GitHub also reports closed       |
| M2: report CI failures as success             | Failure outranks pending and successful checks                    |
| M3: report in-progress checks as success      | Running checks remain pending even with a success conclusion      |
| M4: reject cached 304 responses               | ETags reuse unchanged resources while new comments remain visible |
| M5: stop after the first REST page            | Checks and comments on subsequent pages are returned              |
| M6: retain recognised GitHub tokens           | Unknown fields are preserved only after token redaction           |
| M7: double the log ring allocation            | The log tail never exceeds its configured byte cap                |
| M8: delete acknowledged delivery identities   | The same feedback never queues again after restart                |
| M9: ignore server retry deadlines             | Polling waits through the full rate-limit deadline                |
| M10: omit expected merge SHA                  | Merge requests carry the head guard                               |
| M11: ignore inactive review-thread membership | Resolved and outdated feedback never queues                       |
| M12: double the snapshot byte budget          | Oversized paginated snapshots fail visibly                        |

The current full repository check after merging origin/main passed 447 tests, with four opt-in tests skipped. Forge's 49 tests use a temporary executable fake `gh`, synthetic recorded JSON responses, real git repositories, real subprocess cancellation handshakes and temporary SQLite. No coding-provider prompts or recorder sessions were run.

A read-only smoke test through the real logged-in `gh` read ace PR #10 as merged with two successful checks and no review threads. It printed only aggregate status fields. No live mutation calls were made.

## Review regression and mutation evidence

Before production fixes, all ten new public-API regression cases failed: paginated summary-only reviews; stale pending work after merge, close, CI repair, thread resolution, or edited feedback/head replacement; paused unlink/relink to the identical PR; immutable unchanged resource reuse; colliding redacted keys; and generic access-token assignments. After the fixes they all pass. Additional cases cover backpressure on unchanged polls, rebinding rejected unchanged feedback to a new head, persisted generations, dismissed summaries, deterministic overlap rejection, current-only review-index updates, and changed-only watcher publication. The watcher regression also failed before its publication fix.

The review's four surviving mutations were each reproduced against the old assertions (exit 0), then rerun with the strengthened assertions (exit 1 with a failed Vitest test). All eight mutations below were applied separately to production code and reverted; each failed a behaviour assertion, not compilation or a timer budget.

| Mutation                                              | Behaviour test that fails                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Wrong auto-merge SHA                                  | Full auto-merge argv carries the expected head SHA                       |
| Wrong auto-merge method                               | Full auto-merge argv carries the requested squash method                 |
| Wrong auto-merge PR number                            | Full auto-merge argv carries PR 7                                        |
| Remove both MCP link writes                           | Starting unlinked, link/create persist through file-backed SQLite reopen |
| Omit submitted review projection                      | Paginated summary-only reviews enqueue their actionable bodies           |
| Remove pending head invalidation                      | Rejected unchanged review text rebinds to the current head               |
| Stop advancing link generations                       | A paused unlink/relink read rejects before delivery                      |
| Reuse cached content despite a changed representation | Changed comment text becomes visible without mutating the old snapshot   |

No mutation remains in the delivered code. The final repository check includes the strengthened tests and all regression cases. No provider prompts or recorder sessions were run.

After merging remote access from `origin/main` (`844e0eb`), default-concurrency checks encountered five-second timeouts under shared-machine load (load average above 180). `VITEST_MAX_WORKERS=2 bun run check` limits process fan-out without changing assertions, synchronization or test deadlines; the combined suite has 447 passing tests and four opt-in skips.
