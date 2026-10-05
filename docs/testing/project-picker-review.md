# Project picker static follow-up

The owner prohibits test, mutation, benchmark and probe execution before merge.
All new execution claims below need run at merge. This run used static checks only.

The requested `## Review: changes requested` and `Integration rehearsal: findings for this PR`
comments were unavailable. `gh pr view 130 --comments`, issue comments, pull-request reviews
and inline review comments returned empty lists on 2026-10-05. No supplied mutation list
could be retrieved. The items below come from a static audit of this branch, not that review.

| Fix                                         | Public behavior regression                                                                                                         | Mutation case                                                                          | Status                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| Fill search pages after cached deletions    | A socket search with limit 1 returns alpha-two after deleting alpha-one                                                            | Restrict validation to the original top limit; omit fallback                           | not executed (tests run at merge) |
| Check canonical ignored targets             | Completion hides visible aliases to Library, .git and hidden targets; explicit hidden mode only admits the hidden target           | Remove canonical-target visibility policy                                              | not executed (tests run at merge) |
| Bound rejected completion links             | 512 ignored-target aliases produce no candidates, retain input as common prefix and report truncation with a frozen injected clock | Count only successful completions toward the 256 limit                                 | not executed (tests run at merge) |
| Bound matching regular files                | 300 matching files before a folder stop the scan, report truncation and retain the input prefix                                    | Move the metadata bound after directory-kind filtering                                 | not executed (tests run at merge) |
| Preserve Unicode insertion text             | Two different emoji folder names produce ~/ as their common prefix                                                                 | Return a shared lone high surrogate                                                    | not executed (tests run at merge) |
| Retain socket-specific cache views          | Concurrent normal/hidden sockets each retain their correct results and indexing state                                              | Drop all other hidden-mode indexes on each request; aggregate unrelated indexing flags | not executed (tests run at merge) |
| Remove fake last-opened hints on unregister | Removed projects remain searchable folders with isProject false, recentScore 0 and no lastOpened                                   | Keep opened timestamps after project removal in fake search results                    | not executed (tests run at merge) |

The socket regressions are in `apps/daemon/src/project-picker-review.process.test.ts`.
The fake-client regression is in `packages/fake-daemon/src/client-protocol.test.ts`.
SQLite recent/project rows now use schemas before returning timestamp hints.
Directory opens use one canonical root snapshot per request, and the service still
rechecks live roots and authority before delivery. Search validates at most limit + 128
candidates; completion performs at most 256 matching-entry metadata reads. The index
remains bounded to 32 cache slots and 1,024 directories per slot.

## Performance evidence

The previous implementation's recorded test run established a warm socket median below
100 ms for nine samples on a 1,100-folder tree with limit 2. Exact samples were not retained,
and this is historical evidence for the pre-review code. It does not validate this revision.

`apps/daemon/bench/project-picker.ts` defines a merge-time socket benchmark with a temporary
home, bounded directory creation and 50 warm samples each at limits 2, 30 and 100. It reports
cold latency, warm median/p95/maximum, result counts and RSS growth, and guards a median below
100 ms. Current measurements: needs run at merge. No benchmark was executed in this run.
