# Long-thread reliability verification

Baseline is main after #88, commit `91b2392f`. Measurements use Node 26.8.1 and real SQLite on the same Mac. Synthetic providers run local Node fixture code and never invoke installed provider CLIs. Raw results are in `apps/daemon/bench/long-thread-results.json`.

| Matched fixture                                                        |      Before |       After |
| ---------------------------------------------------------------------- | ----------: | ----------: |
| WAL bytes per delta, 1,000 one-character tokens with transport signals | 101,949.432 |     337.872 |
| Changed SQLite rows per delta                                          |          13 |       0.044 |
| Snapshot bytes, 10,000 items, 5,000 approvals and 48 subagents         |   2,128,087 |     222,576 |
| Retained closed approvals in that snapshot                             |       5,000 |         200 |
| RSS at completion of the matched delta probe                           | 254,787,584 | 237,780,992 |

The write probe truncates WAL before measurement and disables checkpointing during that sample, so file growth reflects newly written pages. These are burst measurements. Individually awaited frames still commit before acknowledgement; their minimum physical SQLite page cost remains. The delta probe's RSS samples are process snapshots, not a multi-day memory comparison.

The pre-fix reconnect soak cannot complete: this approval fixture already exceeds both the client's 4,096-entity cap and its 2 MiB frame budget. The corresponding regressions fail on the baseline. SQLite contention poisons the baseline actor, and its congested outbox emits a 2,457,824-byte batch. The indexed-control regression also fails because resolution decodes an unrelated unavailable snapshot.

The large acceptance run seeded 1,000,000 items, 5,000 answered approvals and 48 subagents, then added 73,728 items across 12 reconnects. It published an actual history archive concurrently with a 64 KiB stdout burst. No thread was poisoned, the durable item count matched, all 13 snapshots arrived, and the largest frame was 223,831 bytes. Snapshot size was 223,369 bytes. After the first warm-up cycle, RSS ranged from 305,315,840 to 318,504,960 bytes, and heap grew by 1,435,600 bytes over the recorded cycles. The isolated delta sample in this populated database used 461.472 WAL bytes and 0.048 changed rows per delta.

The fast workload checks exact durable text length as well as item counts. The opt-in `--long` workload seeds one million items and runs for two days, retaining its original warm baseline while rotating a bounded telemetry ring. The two-day duration has not been executed here. The one-million-item run and fast reconnect runs were executed. SQLite checkpointing resumes after the write-volume sample.

The daemon performance gate passes, including the fast acceptance workload and a freshly bundled daemon. It measured 495.98 delivered deltas/s and 4.24 ms p99, with no budget violations. Its retained RSS changed from 253,018,112 to 251,805,696 bytes, and retained heap from 44,473,984 to 42,025,968 bytes. Reducing the batching timer from 20 ms to 1 ms preserved burst coalescing while avoiding a 50-frame/s ceiling for adapters awaiting each durable acknowledgement.

All 73 targeted regressions across 11 files passed. They cover history intake pauses, transient writer locks (including the overload notice), SIGKILL after acknowledgement, SDK recovery boundaries, signal-prefixed delta batches, isolated control ownership, mailbox resume, bounded entity pages, snapshot fragments, large replay fallback, deletion during an older page read, subscription pacing and command replay pacing. Typecheck, lint, formatting, file-size, dependency-boundary and protocol-documentation checks passed. Dependency-cruiser reports its existing TypeScript 7 compatibility warning. No repository-wide test suite or provider recorder was run.

## UI follow-up for the Claude web agent

- Add older-agent, run, approval and background-task history controls using `entitiesBefore` and `client.request({ type: "entities.page", ... })`. Merge pages by entity id and preserve newer live values using the page's `seq`.
- Keep open approvals and active work visible while older settled entities load. Show ancestors when navigating historical branches and retain item deletion notifications.
- Verify scroll position and selections after a reconnect replaces the current window with a fresh snapshot.
