# Codex adapter verification

All eight Codex 0.159.1 recordings have expectation files and replay through the shared testkit. The timeline CLI now confirms waiting/background_task at 9062 and 11294 and done at 14153 for subagent-background. Background shells and interrupted commands retain the original late-completion checkpoints. Raw recordings were not changed.

## Independent verifier follow-up

The first nine added public-API regressions all failed against the previous implementation. They reproduced same-chunk resume completion, shell completion after 1,025 newer items, repeated aggregate duplication, loss of exact start raw, unbounded unknown-agent metadata, background-child waiting, starting grace, failed child recovery after ancestry registration, and a provider ignoring SIGTERM. Each passes after its fix. The native wait test also first failed with working/tool instead of blocked/subagents. A further read/completion-in-one-chunk test fails with a rejected stale interrupt when original hydration ordering is restored, then passes with revision-aware hydration. Additional tests cover output-only work first seen after turn end and replayed starts during a newer turn.

- Start/resume controls are applied at their wire position. Read controls are skipped after a newer control notification. Awaiting replies cannot resurrect completed turns.
- `item.reconciled` uses canonical core state, preserving completed shells, exact first raw input and streamed output covered by repeated aggregates. Evictable hints cannot prove unfinished work.
- Child recovery reads retry independently of known ancestry. Their guards survive failed reads and loaded-thread scans until complete snapshots recover them.
- Unknown frames emit raw facts immediately. Compact metadata caps at 256 IDs, with one aggregate guard surviving ID eviction until authoritative reconciliation; confirmed truncated children get independent guards. Unconfirmed IDs do not allocate heavy Agent records.
- Background descendants retain their own working state while a finished parent makes the thread waiting/background_task. Successful spawn announcements keep children starting through silence grace. Native wait tools explicitly block on live target children without changing their tool kind.
- Async question closure uses an owner index rather than scanning historical agents. Exact raw shell start input survives completion in the current item.
- Process shutdown grace is injectable. Offline processes use zero grace and a deliberate SIGTERM-ignoring fake proves forced cleanup, one exit, and rejection of later work. Defaults remain five seconds. This removes the known overlap between the default supervisor's five-second fallback and Vitest's default timeout; no synchronization sleeps or time-budget assertions were added.
- The redundant image existence assertion was removed; the exact URL assertion remains.

These changes include a separately committed shared-core fix, as explicitly requested by the latest instruction to fix every not-fixed verifier finding. Earlier ownership guidance prohibited such edits; the latest instruction covers canonical snapshot state, waiting/starting and native wait behavior. No provider-kit, protocol, projection, engine-api, testkit or daemon code was edited.

## Performance

Non-gating Node 26.8.1 measurements, through the exported translator:

| Probe                                                           | Result                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1k / 2k / 4k plan chunks, 100 bytes each                        | 464,013 / 927,013 / 1,853,013 emitted bytes, including final aggregate; two plan-tool upserts each |
| Plan wall / CPU milliseconds                                    | 3.46 / 6.73; 5.40 / 13.61; 6.63 / 12.56                                                            |
| 10,000 unique 4-KiB payloads, one unknown ID                    | 0.43 MiB retained after GC and tick                                                                |
| Same payloads, 10,000 distinct unknown IDs                      | 0.35 MiB retained after GC and tick, versus verifier's 13.85 MiB                                   |
| 10,000 keyed closures with 1k / 2k / 4k / 10k historical agents | 5.96 / 5.49 / 5.48 / 8.27 ms; all 10,000 interaction-closed facts emitted in each run              |
| Closure CPU milliseconds                                        | 15.46 / 14.62 / 12.53 / 19.14                                                                      |

Commands: `node --expose-gc packages/adapter-codex/bench/plan.ts` and `node --expose-gc packages/adapter-codex/bench/ownership.ts`. Timings vary under host load and do not gate tests. Delta traffic is proportional to input bytes; keyed closure is independent of transcript history. Full snapshot reconciliation performs work proportional to the supplied aggregate, at snapshot boundaries rather than per delta. Canonical history remains engine-owned.

## Final local gate

After merging origin/main at 94b2170 and installing its dependencies, `bun run check` passed. Formatting, lint, all workspace typechecks and the 1,500-line check passed. Vitest reported 539 passed and five skipped across 67 files. All 294 source files passed the size check; the largest adapter source is 398 lines.

Three consecutive `bun run test packages/adapter-codex` runs each passed 81 tests and skipped the opt-in live test. Durations were 14.64, 9.28 and 8.34 seconds. The first ran alongside the full repository check under load. The previously intermittent abort test and the SIGTERM-ignoring shutdown test passed in every run.

## Mutation checks

The checked-in script applies production mutations one at a time and restores sources in `finally`. The original 24 review mutations and replay-buffer mutation remain represented, including all six previous survivors: queue count, image URL, malformed raw primitives, historical turns, usage facts and CLI launch mode. Ten further mutations target resume ordering, read ordering, recovery retry, canonical completion, aggregate replay, first raw preservation, discovery after ID eviction, background precedence, native wait and shutdown grace. All 35 mutations were caught and reverted. The recovery-retry mutation was rerun after adding an offline I/O barrier and failed its final-state assertion in 352 ms. Shutdown-grace removal deterministically restored the five-second supervisor fallback and exceeded Vitest's default timeout; the other cases produced assertions or explicit request failures. The mutation list is in the PR description.

## Remaining integration notes

Provider-native queue counts and engine-owned queued input share one counter; the engine should combine them if it holds both simultaneously. Plan preview uses append-only companion notice text because generic tool markdown deltas are absent; full authoritative markdown remains on the completed plan tool. These are integration notes, not outstanding verifier failures.

CI is disabled by the repository owner. No CI run, retry or watch was requested. The local `bun run check` is the delivery gate. Tests use real supervised offline processes and manual timers; no installed-provider prompts, model threads or recorder ran in this round.
