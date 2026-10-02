# Automation verification

Each production mutation below was applied separately. Its targeted public-behavior test failed with an assertion failure under Vitest, then the original source was restored in a finally block. No mutation remains in the branch.

| Mutation                                  | Test file            | Behavior selected         |
| ----------------------------------------- | -------------------- | ------------------------- |
| choose the later DST-fold instant         | `recurrence.test.ts` | repeated autumn           |
| accept nonexistent local times            | `recurrence.test.ts` | nonexistent spring        |
| spill monthly day 31 into short months    | `recurrence.test.ts` | monthly day 31            |
| allow an extra COUNT occurrence           | `recurrence.test.ts` | COUNT counts              |
| exclude the UNTIL endpoint                | `recurrence.test.ts` | UNTIL is inclusive        |
| swap downtime policies                    | `service.test.ts`    | downtime                  |
| admit one run above the concurrency limit | `service.test.ts`    | concurrency occupied      |
| remove persisted jitter                   | `service.test.ts`    | jitter survives           |
| overwrite failed outcomes with success    | `service.test.ts`    | records executor failures |
| leave the old scheduler timer armed       | `service.test.ts`    | arms one timer            |
| reemit unchanged GitHub resource versions | `github.test.ts`     | move pages                |
| omit conditional request headers          | `github.test.ts`     | conditional GETs          |

| let jitter swallow later nominal occurrences | `jitter.test.ts` | large jitter cannot skip |

The same twelve mutations were rerun after the scheduler gained concurrent polling. All twelve again failed their selected assertions and were reverted. A thirteenth mutation removed the recurrence-specific jitter cap; its dedicated assertion failed, then it too was reverted.

## Non-gating benchmark

Command: `bun run --filter @ace/automations bench`. Runtime: Node v26.8.1, macOS arm64. The worktree runs on a shared machine; these numbers are observations, not test thresholds. RSS is the cumulative process peak reported at each benchmark, not retained memory attributed to that operation.

| Path                                   |   Ops/s | Microseconds/op | Peak RSS, MiB |
| -------------------------------------- | ------: | --------------: | ------------: |
| Weekday RRULE                          |  24,137 |           41.43 |         113.8 |
| Five-minute cron                       |  26,798 |           37.32 |         114.6 |
| Counted cursor advance                 |  38,822 |           25.76 |         114.9 |
| 100 PR snapshot, one change            | 108,298 |            9.23 |         115.2 |
| Durable admission and template failure |   7,286 |          137.25 |         120.5 |
| Durable dedup, 10k records             |  21,256 |           47.05 |         122.7 |
| File admission, executor and outcome   |   2,497 |          400.44 |         125.3 |
| Indexed next deadline, 1,000 jobs      |  17,212 |           58.10 |         127.0 |
| Indexed inbox page, 15k records        |   8,943 |          111.82 |         216.8 |

## PR review regressions

All seven blockers were reproduced through the public API before their fixes. The tests failed on the reviewed implementation and passed after correction:

- Hourly DTSTART 09:30, INTERVAL=2 and BYMINUTE=0,30 returns 11:00, 11:30, 13:00, 13:30.
- Corrupt unrelated poll JSON does not prevent listing, restarting or manual execution. Valid large snapshots are covered in the composed benchmark below.
- A failed initial file subscription leaves no definition, and an identical retry watches files. Failed replacement preserves the existing watcher and prompt.
- A throwing first unsubscribe still cleans the second watcher, reports the failure and ignores callbacks retained after stop.
- An onRun configuration edit stops the remaining old GitHub batch and prevents stale snapshot writes. An in-flight response after an edit is discarded.
- Twenty stop/start cycles retain one active external monitoring subscription, then zero after stop. Ignored cancellation also releases service waits and cannot finish a newer monitor's row.
- Real fake-gh grandchildren inherit pipes; abort rejects before parent exit and descendant sockets close after process-group termination.

Additional tests reject noncanonical dot-segment endpoints before spawn, use an injected supervisor with a real child response, preserve ETags through malformed responses and restart, migrate inline SQLite cursors, and replace microtask-count synchronization with an executor-arrival notification.

## Review mutation rerun

Each mutation was applied independently, its selected behavior test failed, and source was restored in a finally block. All ten were caught. The host cap, event schema and stale revision mutations are the three survivors identified by review. Revision protection is now redundant across response, delivery and commit; the mutation disables it at all points, including mid-batch replacement.

| Mutation                                               | Behavioral test                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| Restore minute-subtracted hourly buckets               | expands BYMINUTE within the hourly interval                           |
| Remove host-wide capacity                              | caps active executions across automations at 256                      |
| Bypass trigger event schema                            | rejects invalid trigger keys before recording or executing            |
| Disable revision checks at every delivery/commit point | stops an old GitHub batch when a notification replaces its definition |
| Persist definition before subscribing                  | rolls back a failed workspace subscription                            |
| Let unsubscribe exceptions escape                      | attempts every watcher cleanup                                        |
| Leave obsolete monitoring subscriptions alive          | releases obsolete executor monitoring subscriptions                   |
| Remove endpoint canonicalization                       | rejects noncanonical endpoint                                         |
| Load snapshots during definition lookup                | admits manual work without decoding unrelated poll state              |

## Updated benchmark after review

Command: `bun run --filter @ace/automations bench`. Node v26.8.1, macOS arm64. No gating timing budgets. Peak RSS is cumulative within each benchmark process; it includes transient bounded snapshot decoding, not retained memory per operation. Admission samples run 1,000 durable failed-template arrivals with 8-KiB bodies in the cached entries. Composed samples include ten pages, resetting the persisted baseline, fetching/parsing/diffing, durable admissions, skipped arrivals at capacity, executor outcomes, and snapshot commit. Each poll loads its prior snapshot once. Per-job capacity is 32, host capacity 256. Machine load can change these observations.

| Path                                        |   Ops/s | Microseconds/op | Peak RSS, MiB |
| ------------------------------------------- | ------: | --------------: | ------------: |
| Weekday RRULE                               |  33,059 |           30.25 |         112.1 |
| Five-minute cron                            |  34,961 |           28.60 |         113.9 |
| Counted cursor advance                      |  51,225 |           19.52 |         114.5 |
| 100 PR snapshot, one change                 | 153,491 |            6.52 |         114.6 |
| Durable admission and template failure      |  13,183 |           75.86 |         119.8 |
| Durable dedup over 10k records              |  69,977 |           14.29 |         121.9 |
| File admission, executor and outcome        |   7,124 |          140.36 |         125.7 |
| Indexed next deadline, 1,000 jobs           | 138,797 |            7.20 |         127.4 |
| Indexed inbox page, 15k records             |  13,482 |           74.17 |         212.6 |
| Admission, zero cached entries              |  11,073 |           90.31 |         106.5 |
| Admission, 100 cached entries               |  15,796 |           63.31 |         112.2 |
| Admission, 1,000 cached entries             |  16,100 |           62.11 |         139.4 |
| List 31 definitions with 30 large snapshots |  14,033 |           71.26 |         148.4 |
| Poll 1,000 cached entries, one change       |      12 |       85,928.05 |         259.3 |
| Poll 1,000 cached entries, 100 changes      |       7 |      136,401.06 |         275.9 |
| Poll 1,000 cached entries, 1,000 changes    |       6 |      171,964.01 |         275.9 |
| Supervised fake-gh process, 64-KiB response |      15 |       65,615.00 |         100.5 |

A separate `node --expose-gc packages/automations/bench/poll-admission.ts` observation allocated 0.322 MiB for listing 31 definitions with 30 persisted 0.79-MiB snapshots. It measures allocation for one call immediately after GC; it is non-gating. Full `bun run check` passed with 445 tests and four existing skips before delivery.
