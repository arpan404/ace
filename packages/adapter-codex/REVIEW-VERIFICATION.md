# Codex adapter verification

All eight Codex 0.159.1 recordings have shared-testkit replay tests and expectation files. No raw recording changed. The latest owner integration rule changes active background-child checkpoints at 9062, 11294 and 11357 to working, with done at 14153. Interrupted shell work still waits until 67107. Current replay validation needs run at merge.

## Latest static verifier follow-up

The newest verifier inspected 82088f2. No tests, probes, benchmarks or mutations run in this follow-up. All runtime conclusions below need run at merge.

- V2a and partly fixed retention N1: recreating an unknown buffer now inherits the shared overflow flag. Previously it reset lost to false, so admission replayed only the newer completed turn and skipped the older authoritative transcript. The public translator/core test now evicts an old message and inProgress shell, recreates the buffer with next-turn boundaries before admission, then supplies both completed turns. It requires the old message, no active runs, waiting/background_task with a stoppable shell, and done only after native shell completion. The regression also repeats registration before the global scan finishes, for both spawn and direct-snapshot admission. Known children receive frames directly, so repeated metadata does not consume unknown-buffer loss again; complete snapshots clear the child loss flag. The change retains no additional identifiers or payloads. Runtime and heap validation need run at merge.
- F5 coverage gap: the offline provider returns an owned thread with no turns array on the first read, then a valid transcript. The public session test uses provider response barriers, requires the diagnostic and persistent recovery, and requires the recovered message and done after retry. The existing session rejection/retry rule remains unchanged. Runtime validation needs run at merge.
- B1 inexpensive coverage note: answering either q or q2 first must resolve only that question. Both answer orders now have public session coverage. Runtime validation needs run at merge.
- Documentation drift: fixture analysis section 4.5 now agrees with its working-first precedence and the integration-rehearsal comment. An active child keeps the thread working while its finished parent is blocked/background_task. Existing starting assertions and all fixture expectation files remain. Replay validation needs run at merge.
- Abort timing and other historical check failures: static review cannot establish flakiness or runtime passes. Existing abort/forced-close tests retain injected zero stop grace, public exit assertions and process cleanup. Main now contains the process-test reliability changes from 5494e21. Timing, repeated-run and full-suite conclusions need run at merge; no repeated tests or flakiness probes are executed here.

## Prior verifier follow-up

The verifier inspected d193f17 and found two blockers and two mutation survivors. This round implements changes for all four. The reproductions described below happened before the owner stopped test execution. Current runtime validation needs run at merge:

- **V1:** An isolated Node consumer copies core source and links only declared dependencies. It failed with ERR_MODULE_NOT_FOUND for Zod while exercising public native-wait validation. Adding the direct dependency and lockfile entry makes the consumer pass.
- **V2 / partly fixed N1:** A real offline provider fills 256 recovery timers, supplies a completed child transcript, evicts it with 300 other IDs, then registers the child. The initial test failed with no recovered message. Session ancestry and successful full-history recovery now have separate indexes. Loaded scans read admitted children without recovered history, and admitted children can schedule recovery despite the unknown-timer cap. Successful reads cancel pending retries.
- Complete ID eviction retains conservative loss evidence through the shared overflow flag, without unbounded per-ID tombstones. An admitted child retains its own recovery guard even if a new turn starts and ends before the full snapshot arrives. Public tests check the recovered transcript and final done state, including after all scheduled callbacks drain.
- A second real-process probe recovers the evicted child while the root is still working, before any loaded scan. It settles after root interruption; no further user command is required to initiate recovery.
- **Mutation N1:** The fake provider acknowledges turn/start without its start notification and rejects a second start while active. Omitting acknowledged-turn controls now fails with the explicit provider error "active turn must be steered".
- **Mutation N9:** Three sequential recorded async answers must resolve their respective questions only after successful delivery. Retaining earlier async owner entries leaves a later question pending and fails the public interaction assertion.

Earlier verifier findings B1–B10, N2/N3 and R1–R4 remain guarded by the existing public API tests. Fixtures, injected runtime boundaries, bounded retention and indexed async closure remain in place.

## Integration with updated main

Merged main at 726fb6b, 709f66d, 19a7e14, 50c725f and 50123da without rebasing. The latest main merge is 9fbed53, following 2eb88ef. Main also adds forge and workspace packages. Main adds bounded output summaries, append-only output streams, Git services, orchestration and model catalogs. Core reconciliation now uses the existing stream writer for missing aggregate suffixes. Repeated completion snapshots retain late output and canonical completion. Tests verify exact emitted Unicode bytes and bounded summary metadata, with no duplicate or broken UTF-8 chunks.

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

The latest verifier's 18 planned cases, the new V2a case and its two related registration cases have these behavioral guards. The checked-in script includes the new recreated-buffer, malformed-history and timer-cap cases, plus the core output-boundary cases. Earlier script cases remain. No mutation is applied, and all cases are not executed (tests run at merge). At merge, only behavioral assertions or explicit provider errors count; timeouts, import failures and type errors do not count.

| Case | Planned mutation                                   | Public behavior guard                                                                     | Result                            |
| ---- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| O16  | Force native queue count to zero                   | review-session: native queue remains waiting/queue                                        | not executed (tests run at merge) |
| O18  | Corrupt user image URL                             | review-translator: exact image URL                                                        | not executed (tests run at merge) |
| O19  | Drop primitive frames                              | review-translator: exact null, array, string and number raw data                          | not executed (tests run at merge) |
| O21  | Discard historical turns                           | review-translator/review-session: messages render and surviving shells remain stoppable   | not executed (tests run at merge) |
| O22  | Omit usage facts                                   | review-translator: emitted input, output and cached token counts                          | not executed (tests run at merge) |
| O24  | Launch --help                                      | session: offline CLI rejects the wrong launch and otherwise starts working                | not executed (tests run at merge) |
| N1   | Omit acknowledged turn/start controls              | verifier-session: steering proof before start notification; wrong second start rejected   | not executed (tests run at merge) |
| N9   | Retain resolved asyncOwners                        | verifier-translator: each sequential question resolves only after acknowledgment          | not executed (tests run at merge) |
| F1   | Clear absent-buffer eviction evidence              | verifier-translator: own history guard persists until authoritative recovery              | not executed (tests run at merge) |
| F2   | Loaded scan checks known instead of recovered      | verifier-session: recovered child message despite saturated timers                        | not executed (tests run at merge) |
| F3   | Remove V2 admission recovery scheduling            | verifier-session: child history recovered before root completion                          | not executed (tests run at merge) |
| F4   | Cap admitted recovery at 256 timers                | verifier-session: child history recovered despite unknown-timer saturation                | not executed (tests run at merge) |
| F5   | Accept read snapshots without turns                | verifier-session: diagnostic, retained guard and eventual recovered message               | not executed (tests run at merge) |
| F6   | Bypass conflicting aggregate prefix validation     | core reconciled-item: observed beta bytes, exact raw aggregate and completion             | not executed (tests run at merge) |
| F7   | Measure tail in UTF-16 units                       | core legacy-output: emoji prefix plus exactly the new output suffix                       | not executed (tests run at merge) |
| F8   | Reverse aggregate byte-length comparison           | core reconciled-item: partialmore appears after a growing snapshot                        | not executed (tests run at merge) |
| F9   | Remove item.reconciled validation exemption        | core reconciled-item: nonextending raw and successful completion accepted                 | not executed (tests run at merge) |
| F10  | Exclude background ancestry from working selection | core background-precedence: active grandchild wins over waits, human input wins over work | not executed (tests run at merge) |
| V2a  | Reset loss when an unknown buffer is recreated     | recovery-ordering: older message and live shell recovered after pre-admission next turn   | not executed (tests run at merge) |

## Local gate and delivery

The latest owner instruction permits only format, lint, size and type checks. The surviving test runner was interrupted when that instruction arrived. No test, benchmark, mutation, flakiness run, live CLI probe or CI operation runs afterward. After refreshing dependency links with a frozen install and lifecycle scripts disabled, fast static checks passed: `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. The current size check covers 652 source files, all below 1,500 lines. Full runtime correctness, fixture replay, mutation coverage and final-head performance all need run at merge.

Before the instruction, a full-suite attempt had two Git timeouts at 30 seconds. A submodule timeout also reproduced on a clean origin/main 19a7e14 snapshot under host load. No Git source or tests changed. The nested-repository timeout and final full-suite result need run at merge; this report does not claim a passing full suite.

Tests use exported adapter/core APIs, real supervised offline processes and manual schedulers. No installed-provider prompt, model session or recorder ran. CI is disabled by the repository owner; no CI run, retry or watch is performed. Provider-native and engine-owned queue counts still need combining if both coexist, and plan preview still uses companion notices because generic tool-markdown deltas are absent.
