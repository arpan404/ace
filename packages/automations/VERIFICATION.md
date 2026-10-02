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
| Launch after notification-driven shutdown              | does not launch a new observer after notification-driven stop         |

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

## Independent verifier follow-up

Initially merged origin/main at 94b2170, retaining automation, MCP and remote exports, then refreshed through bbcdae5 with notifications and the encrypted relay. The merge brings main's CommonJS fake-CLI fixture helper from #30. No CI invocation, rerun or watch was made in this round; CI is disabled by the repository owner and the local check is the gate.

Reproduced both verifier lifecycle probes before fixing them: executor abort attempted a synchronous restart, and throwing file cleanup called onError, which attempted a restart. Each public-service test found one active resource after stop instead of zero. A third startup probe had a workspace subscription call stop and likewise leaked one watcher. All three now pass through a pure, constant-space lifecycle state machine. Teardown owns the transition and suppresses callback-driven startup until it finishes; stop during startup disables admission immediately and drains cleanup after startup registers resources. An explicit later start recovers observers and installs usable watchers, and a later stop releases them.

Added the single-event final-snapshot behavior through the public API. Removing only the final revision check reproduced old pages overwriting the replacement manual definition's empty state. Restoring it passes. Removed the redundant initial revision check, so R3's equivalent isolated mutation no longer has a target; delivery and commit retain their own revision checks.

Four additional production mutations were independently applied, failed behavioral assertions and were restored in finally:

| Mutation                                       | Guarding behavior                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Allow startup during teardown                  | executor abort and cleanup error callbacks cannot restart inside stop |
| Ignore a stop requested during startup         | a subscription-triggered stop releases the newly registered watcher   |
| Do not drain a startup stop after registration | a subscription-triggered stop releases the newly registered watcher   |
| Remove only the final snapshot revision check  | the last event's notification edit preserves replacement state        |

The verifier's discovery failure was not reproduced after the merge. The first full check passed with 542 tests and four existing skips. A temporary diagnostic used public discoverProviders with the same filesystem marker handshake, real fake CLI processes and four concurrent calls per wave: 100 attempts, zero failures. The existing discovery suite also passed alongside the automation suite. No discovery or process-supervisor implementation change was made in this round. These observations do not establish the historical cause or prove unrelated flakiness. The diagnostic was removed.

Refreshed non-gating measurements on Node v26.8.1, macOS arm64, shared machine. Command: bun run --filter @ace/automations bench. Peak RSS is cumulative within each benchmark process and includes transient allocations.

| Path                                                |   Ops/s | Microseconds/op | Peak RSS, MiB |
| --------------------------------------------------- | ------: | --------------: | ------------: |
| Weekday RRULE                                       |  18,166 |           55.05 |         118.5 |
| Five-minute cron                                    |  24,996 |           40.01 |         118.9 |
| Counted cursor advance                              |  39,002 |           25.64 |         119.2 |
| 100 PR snapshot, one change                         | 111,270 |            8.99 |         119.3 |
| Durable admission and template failure              |   9,543 |          104.79 |         124.5 |
| Durable dedup over 10k records                      |  66,999 |           14.93 |         126.8 |
| File admission, executor and outcome                |   5,989 |          166.98 |         130.4 |
| Indexed next deadline, 1,000 jobs                   | 132,333 |            7.56 |         132.1 |
| Indexed inbox page, 15k records                     |  13,390 |           74.68 |         222.8 |
| Admission, zero cached entries                      |  11,663 |           85.74 |         110.2 |
| Admission, 100 cached entries                       |  11,905 |           84.00 |         116.6 |
| Admission, 1,000 cached entries                     |  14,156 |           70.64 |         141.3 |
| List 31 definitions with 30 large snapshots         |  13,202 |           75.75 |         149.8 |
| Poll 1,000 cached entries, one change               |      18 |       55,967.86 |         257.7 |
| Poll 1,000 cached entries, 100 changes              |      13 |       77,536.59 |         273.7 |
| Poll 1,000 cached entries, 1,000 changes            |       6 |      158,759.84 |         308.4 |
| Supervised fake-gh process, 64-KiB response         |      17 |       58,817.34 |         101.8 |
| Restart, recovery and cancellation, one pending run |   9,782 |          102.23 |         117.3 |

The previous follow-up's final merged-tree `bun run check` passed formatting, lint, all 266 tracked source-file sizes, all package typechecks and 641 tests with four existing skips. The automation suite has 92 passing tests.

## Second verifier follow-up

Merged origin/main at 726fb6b before changes, then through 9f2a382 when Git landed and 709f66d when orchestration landed. The additive protocol export conflict preserves both schema groups. No production automation behavior changed in this round. The verifier had confirmed the behavior but identified missing regression guards. Added five public-service tests with real temporary SQLite and injected workspace, executor and timer boundaries. Each exact surviving mutation first failed its new test, passed after restoration, and then failed again against all 97 automation tests. Each mutation was restored in a finally block; the restored package suite passes.

| Verifier mutation                             | New guarded behavior                                                                                                             | Failure with mutation                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| N2 ignore startup stop in admission authority | A subscription requests stop, then a wire run immediately rejects; no run row or execution exists                                | Wire result incorrectly returns ok=true                      |
| N7 continue job startup after requested stop  | An overdue later schedule retains its persisted deadline and cursor; explicit later startup applies the skip policy              | Deadline and ordinal advance during stopped startup          |
| N8 continue recovery after requested stop     | First recovery requests stop; later durable runs acquire no observer; explicit later startup recovers both and records successes | A second recovery subscription starts during stopped startup |
| N10 propagate timer cancellation failure      | Stop still removes watchers, reports the error, blocks recursive lifecycle acquisition and permits a usable later start          | Stop throws before watcher cleanup                           |
| N11 omit partial-startup rollback             | Failure subscribing the second workspace releases the first watcher, preserves definitions, rejects admission and permits retry  | One watcher remains installed after startup failure          |

The new tests use boundary outcomes and resource lifetimes rather than private state, sleeps, microtask counts or timing assertions. Runtime ownership caps and the pure lifecycle state machine are unchanged. R3 remains retired as a redundant removed guard.

### Full-suite timeout comparison

The initial full check after merging 726fb6b reproduced the reported daemon crash-recovery timeout, another daemon restart timeout and a notification-spool timeout, all at the existing 5,000-ms deadline. To compare with main, a temporary archive of origin/main at 726fb6b was installed and tested inside this worktree. No other worker's checkout was used. Main's first run passed 607 tests with four skips. Simultaneous full-suite runs on the PR and main then failed identically in `prevents a second process sharing the database and restarts after SIGTERM` and `a full disk spool evicts the oldest alert and catches up without sending historical state`. Main had 605 passes/two failures/four skips; the PR had 702 passes/two failures/four skips. Both failed at 5,000 ms. Daemon and notification sources were identical to main. A later main run passed again, 607 tests/four skips.

A second comparison used an origin/main archive at 9f2a382 and the ten shared suites affected by the default-worker run. On main, 82 tests passed and five timed out: daemon SIGTERM restart, the exact reported crash-recovery case, the first remote CLI case, the core root-delta case and notification-spool catch-up. The crash case hit the same 5,000-ms deadline at lifecycle.test.ts:111, taking 5,126 ms on main and 5,034 ms in the PR default-worker run. This reproduces the reported failure without automation production code. The two branches' daemon and notification sources are identical. These comparisons establish shared test failures under machine load; no behavioral defect specific to automations was reproduced. No daemon or notification test, timeout or global runner configuration was changed. `VITEST_MAX_WORKERS=4 bun run check` passed all stages with 704 tests/four skips on the 726fb6b merged tree; this caps concurrency rather than changing assertions or deadlines. Both temporary main archives were removed. The default-worker full run and the simultaneous four-worker diagnostic run were stopped after recording failures; they are not passing gate evidence. The older discovery failure's historical cause also remains unproved; current discovery tests pass. Historical install chronology and complete provenance cannot be independently established from checkout inspection; no new claim is made about them.

### Refreshed performance observations

`bun run --filter @ace/automations bench`, Node v26.8.1, macOS arm64, shared machine. These remain non-gating measurements. RSS is cumulative within each benchmark process, including transient allocations. No hot-path production changes were made in this round.

| Path                                                |  Ops/s | Microseconds/op | Peak RSS, MiB |
| --------------------------------------------------- | -----: | --------------: | ------------: |
| Weekday RRULE                                       | 25,151 |           39.76 |         116.2 |
| Five-minute cron                                    | 21,694 |           46.10 |         116.5 |
| Counted cursor advance                              | 18,719 |           53.42 |         116.8 |
| 100 PR snapshot, one change                         | 92,102 |           10.86 |         116.9 |
| Durable admission and template failure              |  5,760 |          173.61 |         122.7 |
| Durable dedup over 10k records                      | 27,980 |           35.74 |         124.9 |
| File admission, executor and outcome                |  2,500 |          399.96 |         128.5 |
| Indexed next deadline, 1,000 jobs                   |  9,550 |          104.71 |         130.2 |
| Indexed inbox page, 15k records                     |  5,494 |          182.02 |         220.9 |
| Admission, zero cached entries                      |  4,446 |          224.93 |         107.1 |
| Admission, 100 cached entries                       |  2,828 |          353.59 |         113.5 |
| Admission, 1,000 cached entries                     |  6,671 |          149.91 |         139.7 |
| List 31 definitions with 30 large snapshots         |  8,768 |          114.05 |         148.2 |
| Poll 1,000 cached entries, one change               |     12 |       83,678.87 |         251.4 |
| Poll 1,000 cached entries, 100 changes              |      7 |      137,663.65 |         276.5 |
| Poll 1,000 cached entries, 1,000 changes            |      1 |      754,190.30 |         286.1 |
| Supervised fake-gh process, 64-KiB response         |     15 |       66,709.92 |         102.2 |
| Restart, recovery and cancellation, one pending run | 24,984 |           40.03 |         118.6 |

### Final gate on the merged tree

`VITEST_MAX_WORKERS=4 bun run check --testTimeout=30000 --hookTimeout=30000` exited zero. Formatting, lint, every package typecheck and all 355 source-file size limits passed. Vitest passed 921 tests with four existing skips across 119 files, including all 97 automation tests. Runtime: 249.58 seconds. No CI run, retry or watch was made; CI is disabled by the repository owner.

The default-worker and later one-worker runs encountered shared test timeouts reproduced on origin/main; the latter hit the same notification catch-up and core delta deadlines even with one worker. Those failed runs were stopped and are not green gate evidence. The final command overrides the runner's default test/hook timeout to 30 seconds while leaving assertions, test files, explicit per-test deadlines and global runner configuration unchanged. This records the actual configuration rather than claiming a default-settings pass. No production automation behavior, ownership cap or hot-path algorithm changed in this round.
