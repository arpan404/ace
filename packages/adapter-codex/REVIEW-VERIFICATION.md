# Codex adapter verification

All eight Codex 0.159.1 recordings have shared-testkit replay tests and expectation files. No raw recording changed. The latest owner integration rule changes active background-child checkpoints at 9062, 11294 and 11357 to working, with done at 14153. Interrupted shell work still waits until 67107. Current replay validation needs run at merge.

## Latest verifier follow-up

The verifier inspected d193f17 and found two blockers and two mutation survivors. This round implements changes for all four. The reproductions described below happened before the owner stopped test execution. Current runtime validation needs run at merge:

- **V1:** An isolated Node consumer copies core source and links only declared dependencies. It failed with ERR_MODULE_NOT_FOUND for Zod while exercising public native-wait validation. Adding the direct dependency and lockfile entry makes the consumer pass.
- **V2 / partly fixed N1:** A real offline provider fills 256 recovery timers, supplies a completed child transcript, evicts it with 300 other IDs, then registers the child. The initial test failed with no recovered message. Session ancestry and successful full-history recovery now have separate indexes. Loaded scans read admitted children without recovered history, and admitted children can schedule recovery despite the unknown-timer cap. Successful reads cancel pending retries.
- Complete ID eviction retains conservative loss evidence through the shared overflow flag, without unbounded per-ID tombstones. An admitted child retains its own recovery guard even if a new turn starts and ends before the full snapshot arrives. Public tests check the recovered transcript and final done state, including after all scheduled callbacks drain.
- A second real-process probe recovers the evicted child while the root is still working, before any loaded scan. It settles after root interruption; no further user command is required to initiate recovery.
- **Mutation N1:** The fake provider acknowledges turn/start without its start notification and rejects a second start while active. Omitting acknowledged-turn controls now fails with the explicit provider error "active turn must be steered".
- **Mutation N9:** Three sequential recorded async answers must resolve their respective questions only after successful delivery. Retaining earlier async owner entries leaves a later question pending and fails the public interaction assertion.

Earlier verifier findings B1–B10, N2/N3 and R1–R4 remain guarded by the existing public API tests. Fixtures, injected runtime boundaries, bounded retention and indexed async closure remain in place.

## Integration with updated main

Merged main at 726fb6b, 709f66d and 19a7e14 without rebasing. Main adds bounded output summaries, append-only output streams, Git services, orchestration and model catalogs. Core reconciliation now uses the existing stream writer for missing aggregate suffixes. Repeated completion snapshots retain late output and canonical completion. Tests verify exact emitted Unicode bytes and bounded summary metadata, with no duplicate or broken UTF-8 chunks.

A nonextending native aggregate cannot rewrite an append-only stream. It stays in exact raw data while verified chunks and completion are preserved. This matters for the interrupt recording, whose deltas begin at tick 2 while final aggregatedOutput includes tick 1. Supporting stream corrections would require an explicit protocol operation; this adapter never invents or corrupts an append-only suffix.

The newer integration-rehearsal comment requires needs_you > working > waiting > unresponsive > done. Removed the adapter fix round's exclusion of background descendants from working status. Public tests assert an active child after root completion, nested active descendants above retry/shell waits, human-input precedence, and waiting only after active work ends. Fixture expectations follow that newer instruction rather than the older research waiting rule. These tests and the affected fixture replays need run at merge.

Core edits are isolated in focused commits: dependency declaration and reconciliation integration. The latest user instruction explicitly requests the core dependency blocker. Other shared packages changed only through main merges. The translator remains pure; clocks, IDs, schedulers, discovery and process spawning stay injected at the I/O boundary. New external-data handling uses schemas and guards.

## Performance

Historical non-gating measurements on Node 26.8.1, collected before the owner stopped tests and benchmarks, under host load above 250. Current performance validation needs run at merge:

| Probe                                                           | Result                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1k / 2k / 4k plan chunks, 100 bytes each                        | 464,013 / 927,013 / 1,853,013 emitted bytes; two plan-tool upserts each |
| Plan wall / CPU milliseconds                                    | 35.66 / 10.73; 116.40 / 24.67; 35.68 / 20.29                            |
| 10,000 unique 4-KiB payloads, one unknown ID                    | 0.44 MiB retained after GC and tick                                     |
| 10,000 distinct unknown IDs                                     | 0.35 MiB retained after GC and tick                                     |
| 10,000 keyed closures with 1k / 2k / 4k / 10k historical agents | 143.65 / 157.35 / 221.37 / 149.02 ms; 10,000 closures per run           |
| Closure CPU milliseconds                                        | 22.66 / 48.58 / 21.27 / 29.18                                           |

The checked-in plan and ownership benchmark scripts produced these historical numbers. Static review shows append-only plan deltas, bounded unknown retention and indexed keyed closure. Timing and memory claims for the final head need run at merge.

## Mutation checks

The script retains the earlier mutation cases and adds the four latest coverage guards plus recovery before root completion. The former shutdown-grace mutation depended only on a framework timeout; it is replaced by a behavior assertion against conflicting aggregate output. The runner now rejects import failures and timeouts as mutation evidence and uses one worker with a longer framework watchdog for this heavily loaded host.

The tests are designed to kill these mutations. Every case below is **not executed (tests run at merge)** for the delivered head:

- Restore resume controls after awaiting a reply, guarded by same-chunk completion coverage; not executed (tests run at merge).
- Apply stale read controls, guarded by child interruption coverage; not executed (tests run at merge).
- Duplicate native aggregate output, guarded by exact output assertions; not executed (tests run at merge).
- Discard the first raw payload, guarded by exact input preservation; not executed (tests run at merge).
- Append a conflicting aggregate, guarded by verified output preservation; not executed (tests run at merge).
- Omit acknowledged-turn controls, guarded by steering before notification; not executed (tests run at merge).
- Retain resolved async owners, guarded by sequential question resolution; not executed (tests run at merge).
- Equate ancestry with recovery, guarded by recovered child transcript assertions; not executed (tests run at merge).
- Lose complete eviction evidence, guarded by the independent recovery guard assertion; not executed (tests run at merge).
- Skip admitted-child recovery, guarded by recovery before root completion; not executed (tests run at merge).
- Hide active background children from thread status, guarded by working-after-parent-completion coverage; not executed (tests run at merge).

Earlier mutation cases remain in the script, also not executed (tests run at merge). At merge, only behavioral assertion failures or explicit provider errors count; timeout, import or type errors do not count. No mutation is applied in the delivered worktree.

## Local gate and delivery

The latest owner instruction permits only format, lint, size and type checks. The surviving test runner was interrupted when that instruction arrived. No test, benchmark, mutation, flakiness run, live CLI probe or CI operation runs afterward. Fast static checks passed: `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. The size check covers 482 source files, all below 1,500 lines. Full runtime correctness, fixture replay, mutation coverage and final-head performance all need run at merge.

Before the instruction, a full-suite attempt had two Git timeouts at 30 seconds. A submodule timeout also reproduced on a clean origin/main 19a7e14 snapshot under host load. No Git source or tests changed. The nested-repository timeout and final full-suite result need run at merge; this report does not claim a passing full suite.

Tests use exported adapter/core APIs, real supervised offline processes and manual schedulers. No installed-provider prompt, model session or recorder ran. CI is disabled by the repository owner; no CI run, retry or watch is performed. Provider-native and engine-owned queue counts still need combining if both coexist, and plan preview still uses companion notices because generic tool-markdown deltas are absent.
