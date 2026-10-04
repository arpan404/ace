# PR 90 review fixes

The review targets revision `34c75d40`. This round merged `origin/main` first; the branch was already up to date. The PR had one comment starting **Verdict: changes required.** and no comment titled **Integration rehearsal: findings for this PR** when inspected.

## Findings and regressions

Each blocker received public-API regression source before its implementation change. No failing or passing execution is claimed. Every behavioral claim below **needs run at merge**.

| Finding                                                         | Change                                                                                                          | Public regression                                                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deleted initiating/latest previews survive                      | Repair both caches from surviving messages inside deletion transaction; repair old caches during upgrade        | `long-thread-previews.process.test.ts`: deletion fallback, streamed fallback, all removed, restart, rollback, old turn during a newer run                                                                            |
| Time cutoff approximates a sequence                             | Persist literal-time radix aggregates and canonical-seq command revisions; retain current completion membership | `long-thread-time.process.test.ts`: reversed times, exclusive boundary, epoch/radix boundaries, reopened older turn; `long-thread-upgrade.process.test.ts`: midturn generated fixture, resumable upgrade/live writes |
| Fake omits descendants/pending approvals                        | Merge visible linked family, current pending counts and latest family message                                   | fake `long-thread.test.ts`: pre-cutoff root/child approvals, child command/message, closure                                                                                                                          |
| Fake doubles inclusive session usage                            | Shared `countsTowardTurnUsage`; preserve model identity and known zero deltas                                   | fake `long-thread.test.ts`: agent/session exclusion, model separation, post-cursor known zero                                                                                                                        |
| Fake scans contributions/changes; daemon scans completed suffix | Incremental item/agent and balanced seq/time aggregates; persisted completion memberships                       | fake replacement/late-child/failed/interrupted regressions; daemon older-turn reopening regression                                                                                                                   |
| Oversized bodies allocated before budget rejection              | Preflight non-preview stored byte sizes before hydration; pass remaining window budget                          | `long-thread-paging.process.test.ts`: oversized target/neighbor, cursors, escaping/UTF-8, TextSource/restart                                                                                                         |
| Writer mixes decisions and SQL                                  | Extract pure item/agent/run ownership, activity and settlement decisions                                        | Existing lifecycle, original-turn, tool and rollback behaviors remain the public guards                                                                                                                              |
| Disjoint search scans transcript candidates                     | Cap raw scoped anchor postings before intersection/dedup; cursor advances through empty pages                   | search `thread-search.process.test.ts`: disjoint empty-page continuation to a late multi-chunk match                                                                                                                 |
| Boundary-overlap mutation is masked                             | Remove intact duplicate; assert the sole joined occurrence and snippet                                          | search boundary regression                                                                                                                                                                                           |

Time-file regressions also cover create/delete equivalence, empty edits, surviving zero-line replacement and deletion with an earlier timestamp. Upgrade replay reconstructs reference deltas durably and clears temporary membership rows in bounded batches.

## Mutation coverage

Every case is **not executed (tests run at merge)**. The review did not claim any caught or surviving outcome. These are intended guards, not demonstrated kills.

| Mutation                                                                  | Intended behavioral guard                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Reset stable ordinals; drop initiating message                            | daemon `long-thread.process.test.ts`, root ordinals/pre-run messages; new preview regressions |
| Double-count replacement tools/files                                      | daemon replacement behavior; fake authoritative replacement behavior                          |
| Settle from root alone; ignore running tools                              | daemon whole-tree lifecycle and `long-thread-tools.process.test.ts`                           |
| Move late approval review to current turn                                 | daemon `long-thread-permissions.process.test.ts`; fake late-review behavior                   |
| Sum lifetime usage again                                                  | daemon `long-thread-lifecycle.process.test.ts`; fake usage/model and known-zero behavior      |
| Make sequence/time cutoff inclusive; assume monotone time                 | daemon partial catch-up and new literal-time regressions; fake reversed-time behavior         |
| Advance index outside rollback                                            | daemon rollback behavior; new preview rollback behavior                                       |
| Retain deleted jump target                                                | daemon deleted-target window behavior                                                         |
| Ignore window byte budget; materialize oversized neighbors                | daemon window budget and new paging behaviors                                                 |
| Skip descendant authorization                                             | daemon tree-search/catch-up authorization behavior                                            |
| Share or regress device cursors                                           | daemon device isolation/restart behavior                                                      |
| Coalesce last cursor instead of maximum; retain aborted highest mark      | client `long-thread.process.test.ts`                                                          |
| Index only text prefix                                                    | search blob-only and tool-output behavior                                                     |
| Remove boundary overlap                                                   | search sole split-token occurrence and highlighted snippet                                    |
| Ignore filters or cursor binding                                          | search filter behavior and strengthened query/filter/family mismatch cases                    |
| Drop worker forwarding                                                    | worker `worker-client.test.ts` long-thread requests                                           |
| Omit synthetic approvals/children                                         | fake generator public-client behavior                                                         |
| Omit family facts/current pending; count only successful outcomes         | new fake family/pending and failed/interrupted settlement behaviors                           |
| Lose migration/live facts, cached preview repair or completion membership | new daemon upgrade/reopen/preview regressions                                                 |

## Verification policy

Only the owner's allowed static commands run in this review round. Tests, `bun run check`, probes, mutation/flakiness runs, benchmarks and CI runs/waits are prohibited. Test pass/fail results, mutation kills, flakiness, updated memory/latency and the performance target verdict all **need run at merge**.

Passed `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run check:size`, `bun run check:deps`, `bun run docs:protocol --check` and `git diff --check`. Dependency-cruiser exits successfully with no reported violations but warns that its compiler integration does not support TypeScript 7 and may miss edges. No UI files or PR 88 internals changed.

Historical timings at `34c75d40` remain in [the benchmark report](long-thread-results.md). The updated script includes adversarial search and literal-time catch-up, waits for public turn-index readiness and reports memory for each workload. It has not been executed this round.
