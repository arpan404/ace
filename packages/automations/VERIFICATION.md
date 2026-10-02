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
