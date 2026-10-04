# Long-thread reliability verification

The numbers below were collected before this review round, on PR head `82b718a4` against main after #88, commit `91b2392f`. They do not measure the #90 merge or the review fixes. Measurements use Node 26.8.1 and real SQLite on the same Mac. Synthetic providers run local Node fixture code and never invoke installed provider CLIs. Raw results remain unchanged in `apps/daemon/bench/long-thread-results.json`.

The owner prohibited tests, probes, benchmarks, mutation runs, `bun run check` and CI execution during this round. All new and amended behaviour tests are **not executed (tests run at merge)**. Current-head performance and the million-item rerun **need run at merge**. No new runtime results are claimed.

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

Before this review round, 73 targeted regressions across 11 files passed. They covered history intake pauses, transient writer locks including the overload notice, SIGKILL after acknowledgement, SDK recovery boundaries, signal-prefixed delta batches, isolated control ownership, mailbox resume, bounded entity pages, snapshot fragments, large replay fallback, deletion during an older page read, subscription pacing and command replay pacing. Those runs do not validate the current head. No repository-wide test suite or provider recorder was run.

## Review corrections

Merged `origin/main` at `98502d93` without rebasing. The #90 turn-index benchmark and client tests keep their original paths; this PR's acceptance workload is now `apps/daemon/bench/long-thread-reliability.ts`, and its client regressions are `packages/client/src/reliability.process.test.ts`.

- Reactivated agents announce their existing metadata and ancestor chain before runs and statuses. The real Engine and Client regression requires a historical nested branch to become visible without a replacement snapshot. Repeated metadata preserves #90's original turn ownership.
- Line intake handles CR, LF and split CRLF with pressure checks between records. SSE checks pressure between physical lines. SSE and OpenCode pressure waits race cancellation and remove abort listeners when the wait settles.
- Oversized `entities.page` responses use correlated `entities.page.part` fragments. The Client validates the completed response's request, thread and sequence. A settled 1.1 MiB plan is read in full before and after reconnect in the new regression. A single page beyond the 64 MiB retained-text budget receives a correlated error.
- Fragment admission limits aggregate retained UTF-16 text to 64 MiB across four sources. An injected absolute 30-second completion deadline does not refresh on later fragments. Byte exhaustion and expiry reconnect safely and clear both data and timers. Tests cover single-source and aggregate exhaustion, plus a late fragment before expiry.
- Agent eviction notifies individual agent, usage and context selectors.
- Deadline minima use the existing indexed expiry heap, now shared through `@ace/core`. Heartbeats update one global floor; branch signals update ancestors once per batch. Fixed wake deadlines remain independent. Live status windows fold changed entities and maintain settled retention and ancestor references incrementally, avoiding a full pending-approval decode on each publication.
- The acceptance workload now retains 5,000 pending approvals through large-gap reconnects. It measures writes both before and during that workload with the same budgets, below 2,048 WAL bytes and one changed SQLite row per delta. Snapshot budgets are 1 MiB for the settled fixture and 4 MiB for the pending fixture. These assertions need execution at merge; pending-approval numbers are not yet available.
- Reconnect pacing now disconnects and reconnects twelve established subscriptions. Replay checks exact item contents, coalescing requires positive deltas and exact durable text, and the line burst is exactly 65,536 bytes. Clock-driven acknowledgement checks replace the host-sensitive 1,500 ms assertion. Pressure, history and writer-lock tests use explicit stream, socket or injected timer barriers.

Current static checks pass: `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run check:size`, `bun run check:deps`, and `bun run docs:protocol --check`. The size check covers 3,070 source files. Dependency-cruiser reports no violations across 773 modules and retains its TypeScript 7 compatibility warning, so its dependency coverage is limited by that tool warning. CI is disabled and was not run or awaited. No UI code was edited.

## Mutation cases

Every case is **not executed (tests run at merge)**. These are tests designed to kill the mutations, not measured mutation kills. Test basenames below are relative to their package; daemon engine tests live in `apps/daemon/src/engine`.

| Mutation                                                                | Behaviour coverage                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remove line pause                                                       | Provider-kit `line-backpressure.process.test.ts`, exact 64 KiB pause/resume; `pressure-framing.process.test.ts`, CR/LF/CRLF                                  |
| Remove JSONL gate                                                       | Provider-kit `line-backpressure.process.test.ts`, held gate and exact buffered suffix                                                                        |
| Skip history wait                                                       | Engine `long-thread.process.test.ts`, flush starts while history owns Store, socket barrier, no ACK or visible append until publication                      |
| Remove busy retry                                                       | Engine `long-thread.process.test.ts`, real SQLite lock and injected retry barrier                                                                            |
| ACK before commit                                                       | Engine `long-thread.process.test.ts`, no ACK during history lease; SIGKILL after ACK retains exact committed text                                            |
| Disable signal/delta coalescing or drop all deltas                      | Engine `long-thread.process.test.ts`, positive bounded event count and exact 1,000-character text                                                            |
| Scan unrelated owners                                                   | Engine `long-thread.process.test.ts`, approval resolution and task stop succeed with an unrelated unavailable snapshot                                       |
| Permanently poison overload                                             | Engine `resource-limits.process.test.ts`, accepted prefix survives and the same thread resumes, including locked overload notice                             |
| Drop SDK recovery offset                                                | Engine `cursor-recovery.process.test.ts`, exact text and durable offset 1,002                                                                                |
| Include all settled approvals                                           | Daemon `status-storage.test.ts`, bounded snapshot and complete history paging                                                                                |
| Reject more than 4,096 pending approvals                                | Client `reliability.process.test.ts`, 10,000 pending approvals through bounded frames                                                                        |
| Remove congested byte split                                             | Daemon `outbox-work.process.test.ts`, exact append total and contiguous sequence coverage below 1 MiB                                                        |
| Remove replay fallback                                                  | Daemon `subscription.process.test.ts`, snapshot fallback, complete paged item text and bounded split replay                                                  |
| Remove deletion journal                                                 | Client `reliability.process.test.ts`, deletion notification and stale page cannot resurrect the item                                                         |
| Remove four subscription slots                                          | Client `reliability.process.test.ts`, actual reconnect admits exactly four, then eight, then twelve subscriptions                                            |
| Remove eight replay slots                                               | Client `reliability.process.test.ts`, twenty offline commands advance only with durable replies                                                              |
| Retry delegation expiry at zero delay                                   | Daemon agent-control `control.process.test.ts`, failing expiry does not repeat at the next millisecond and an unrelated result wakes                         |
| Omit historical branch or ancestors, or repair only with a new snapshot | Engine `reactivation.process.test.ts`, nested working branch visible without reconnect                                                                       |
| Reattribute restored agents to the latest turn                          | Daemon `reactivation-turns.process.test.ts`, original turn reopens and current turn does not acquire the old branch                                          |
| Ignore pressure in CR SSE or ignore cancellation                        | Provider-kit `pressure-framing.process.test.ts`; OpenCode `v2-lifecycle.process.test.ts`, real held streams abort/close                                      |
| Drop oversized page entries or lose fragment correlation                | Client `entity-stream.process.test.ts`, exact 1.1 MiB plan before and after reconnect                                                                        |
| Omit byte budget, aggregate accounting or absolute fragment expiry      | Client `entity-stream.process.test.ts`, bounded incomplete streams recover after exhaustion or late-fragment deadline                                        |
| Omit individual eviction notifications                                  | Client `eviction-notifications.process.test.ts`, retained selectors observe undefined values                                                                 |
| Rebuild all pending entities or evict pending work                      | Daemon `incremental-status.process.test.ts`, unrelated corrupt canonical body is not decoded, recent history stays bounded, same-batch reactivation survives |
| Move fixed wakes with heartbeats or refresh sibling deadlines           | Core `deadline-review.test.ts`, independent minima and wake transitions                                                                                      |

## UI follow-up for the Claude web agent

- Add older-agent, run, approval and background-task history controls using `entitiesBefore` and `client.request({ type: "entities.page", ... })`. Merge pages by entity id and preserve newer live values using the page's `seq`.
- `Client.request` reassembles oversized entity pages; UI callers receive the complete typed page and do not handle fragments. Treat `entity_page_too_large` as a readable request error.
- Use the merged `client.turnsPage`, `client.itemsWindow` and `client.threadCatchUp` APIs for turn navigation and reconnect summaries. Restored agents retain their original turn association.
- Keep open approvals and active work visible while older settled entities load. Show ancestors when navigating historical branches and retain item deletion notifications.
- Verify scroll position and selections after a reconnect replaces the current window with a fresh snapshot.
