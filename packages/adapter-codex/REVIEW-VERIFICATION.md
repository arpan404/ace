# Codex adapter verification

All eight Codex 0.159.1 recordings replay through the shared testkit with their original checkpoints. No raw recording changed. Background-child waiting remains at 9062 and 11294, with done at 14153; interrupted shell work remains live until 67107.

## Latest verifier follow-up

The verifier inspected d193f17 and found two blockers and two mutation survivors. This round addresses all four:

- **V1:** An isolated Node consumer copies core source and links only declared dependencies. It failed with ERR_MODULE_NOT_FOUND for Zod while exercising public native-wait validation. Adding the direct dependency and lockfile entry makes the consumer pass.
- **V2 / partly fixed N1:** A real offline provider fills 256 recovery timers, supplies a completed child transcript, evicts it with 300 other IDs, then registers the child. The initial test failed with no recovered message. Session ancestry and successful full-history recovery now have separate indexes. Loaded scans read admitted children without recovered history, and admitted children can schedule recovery despite the unknown-timer cap. Successful reads cancel pending retries.
- Complete ID eviction retains conservative loss evidence through the shared overflow flag, without unbounded per-ID tombstones. An admitted child retains its own recovery guard even if a new turn starts and ends before the full snapshot arrives. Public tests check the recovered transcript and final done state, including after all scheduled callbacks drain.
- A second real-process probe recovers the evicted child while the root is still working, before any loaded scan. It settles after root interruption; no further user command is required to initiate recovery.
- **Mutation N1:** The fake provider acknowledges turn/start without its start notification and rejects a second start while active. Omitting acknowledged-turn controls now fails with the explicit provider error "active turn must be steered".
- **Mutation N9:** Three sequential recorded async answers must resolve their respective questions only after successful delivery. Retaining earlier async owner entries leaves a later question pending and fails the public interaction assertion.

Earlier verifier findings B1–B10, N2/N3 and R1–R4 remain guarded by the existing public API tests. Fixtures, injected runtime boundaries, bounded retention and indexed async closure remain in place.

## Integration with updated main

Merged main at 726fb6b, then at 709f66d, without rebasing. Main adds bounded output summaries, append-only output streams, Git services and orchestration. Core reconciliation now uses the existing stream writer for missing aggregate suffixes. Repeated completion snapshots retain late output and canonical completion. Tests verify exact emitted Unicode bytes and bounded summary metadata, with no duplicate or broken UTF-8 chunks.

A nonextending native aggregate cannot rewrite an append-only stream. It stays in exact raw data while verified chunks and completion are preserved. This matters for the interrupt recording, whose deltas begin at tick 2 while final aggregatedOutput includes tick 1. Supporting stream corrections would require an explicit protocol operation; this adapter never invents or corrupts an append-only suffix.

Core edits are isolated in focused commits: dependency declaration and reconciliation integration. The latest user instruction explicitly requests the core dependency blocker. Other shared packages changed only through main merges. The translator remains pure; clocks, IDs, schedulers, discovery and process spawning stay injected at the I/O boundary. New external-data handling uses schemas and guards.

## Performance

Non-gating measurements on Node 26.8.1 under host load above 250:

| Probe                                                           | Result                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1k / 2k / 4k plan chunks, 100 bytes each                        | 464,013 / 927,013 / 1,853,013 emitted bytes; two plan-tool upserts each |
| Plan wall / CPU milliseconds                                    | 35.66 / 10.73; 116.40 / 24.67; 35.68 / 20.29                            |
| 10,000 unique 4-KiB payloads, one unknown ID                    | 0.44 MiB retained after GC and tick                                     |
| 10,000 distinct unknown IDs                                     | 0.35 MiB retained after GC and tick                                     |
| 10,000 keyed closures with 1k / 2k / 4k / 10k historical agents | 143.65 / 157.35 / 221.37 / 149.02 ms; 10,000 closures per run           |
| Closure CPU milliseconds                                        | 22.66 / 48.58 / 21.27 / 29.18                                           |

Commands: `node --expose-gc packages/adapter-codex/bench/plan.ts` and `node --expose-gc packages/adapter-codex/bench/ownership.ts`. Traffic remains linear, retained unknown metadata remains bounded, and keyed closure does not scan agent history. Timings vary under host load and never gate tests.

## Mutation checks

The script retains the earlier mutation cases and adds the four latest coverage guards plus recovery before root completion. The former shutdown-grace mutation depended only on a framework timeout; it is replaced by a behavior assertion against conflicting aggregate output. The runner now rejects import failures and timeouts as mutation evidence and uses one worker with a longer framework watchdog for this heavily loaded host.

This round applies ten meaningful production mutations, restores each in finally, and checks these behaviors:

- Restoring resume controls after awaiting a reply fails the same-chunk completion probe.
- Applying stale read controls fails the child interrupt probe.
- Duplicating native aggregate output fails the exact output assertion.
- Discarding the first raw payload fails exact input preservation.
- Appending a conflicting aggregate fails verified output preservation.
- Omitting acknowledged-turn controls fails steering before notification.
- Retaining resolved async owners leaves a subsequent interaction pending.
- Equating ancestry with recovery loses an evicted child's transcript.
- Losing complete eviction evidence releases recovery prematurely.
- Skipping admitted-child recovery loses history while the root stays active.

All failures must be assertions or explicit provider errors, with no timeout, import or type error accepted. No mutation remains applied after the run.

## Local gate and delivery

The first targeted run after stream integration passed 93 tests and skipped the opt-in live handshake. The added recovery-before-root-completion probe also passed with all seven session-verifier tests. Tests use exported adapter/core APIs, real supervised offline processes and manual schedulers. No installed-provider prompt, model session or recorder ran.

The final local gate result is recorded in the PR description. CI is disabled by the repository owner; no CI run, retry or watch is performed. Provider-native and engine-owned queue counts still need combining if both coexist, and plan preview still uses companion notices because generic tool-markdown deltas are absent.
