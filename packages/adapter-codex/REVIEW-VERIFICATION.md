# Codex adapter verification

All eight 0.159.1 recordings have expectation files. The testkit timeline CLI confirmed every listed checkpoint. Background shell completion remains waiting from t=12290 until t=23076. The round-2 interrupt remains waiting from t=14503 through its late command output until t=67107. Plan review stays pending at t=38723 and t=48897 and expires at the recorder's deliberate exit. Child work prevents early done at t=9062; the current core reports working until t=14153, with the root blocked on its background task.

The offline suite contains 68 adapter tests. Real supervised fake-CLI processes cover commands and process effects; frame promises provide synchronization. No tests send prompts to the installed Codex CLI. The opt-in live initialize handshake passed and stopped its process without starting a thread.

The complete repository check passes with 425 tests and five opt-in skips. It covers formatting, lint, source-size checks, all workspace typechecks and offline tests. The adapter sources are below 400 lines each. Generated protocol files come from the installed CLI rather than handwritten native definitions. Generation was rerun after formatting and produced the same definitions.

## Mutation evidence

`node packages/adapter-codex/scripts/mutations.ts` applies these changes one at a time and restores the original source in `finally`. All 24 mutations from the review, plus one buffer-limit mutation, caused their targeted Vitest suites to exit with test failures. The six previous survivors now fail assertions on public queue status, image URL, raw primitives, historical items, usage events and the real fake-CLI launch mode. Skipping terminal termination fails an explicit remaining-terminal assertion before any timeout. They were all reverted before the final repository check.

| Production mutation                            | Observed failing behaviour                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Omit surviving-shell promotion                 | An interrupted command must keep the thread waiting until its stale-turn completion.        |
| Discard buffered child frames                  | Late registration must retain the child's earlier turn and transcript.                      |
| Make async questions blocking                  | An async final-answer question must allow the model to keep working.                        |
| Omit orphan question item synthesis            | The linked ask-user tool must retain the native question payload.                           |
| Omit plan review                               | The plan-review fixture must require input after the plan completes.                        |
| Leave completed background shells live         | Both background-shell and interrupt fixtures must settle at their command completions.      |
| Drop original native tool inputs               | Completion must preserve original name, arguments and vendor fields alongside the result.   |
| Reopen review on a replayed boundary           | A replayed completion must not reopen a resolved plan review.                               |
| Replace an offered amendment with plain accept | The fake provider must receive the exact selected amendment object.                         |
| Steer queued input                             | Queue delivery must preserve input for later instead of injecting it into the running turn. |

| Ignore provider failure text | Nominal completion must fail after explicit quota text. |
| Keep retry after activity | Native activity must clear the retry status. |
| Steer wrong native turn | Provider must accept steering against the active native turn. |
| Skip cascade child | All descendant turns must be interrupted. |
| Skip terminal termination | A subsequent provider query must observe no remaining terminals. |
| Zero native queue count | Queued input must keep an idle thread waiting on queue. |
| Skip loaded hydration | Unseen descendants must prevent early completion. |
| Corrupt image URL | User content must retain the exact native URL. |
| Drop malformed primitives | Each null, array, string and numeric frame must retain its raw value. |
| Replace usage with invalid signal | Usage must publish token counts without rejected facts. |
| Discard historical turns | Resume must preserve messages and surviving command tasks. |
| Omit usage facts | Native usage must emit input, output and cached token counts. |
| Disable async free text | Async questions must allow a free-text answer. |
| Launch help instead of app-server | The discovered executable must initialize in app-server mode. |
| Remove per-thread replay limit | Lost replay history must hold completion until a full snapshot recovers it. |

An initial mutation attempt exposed a weak orphan-question test: core's fallback item made the link assertion pass. The test was strengthened to require the native payload in the linked tool's raw data, and the mutation then failed as expected.

## Contract limits

The requests and rationale are in [README.md](README.md). Core currently labels active background children as working, can mark a child unresponsive before its first turn, and cannot encode an explicit wait on subagent keys. The adapter keeps all live work unsettled without inventing status facts. Native queue counts and ace's queued input share one counter. Plan preview uses append-only notice text, and completed plan markdown remains on the canonical plan tool. No cumulative markdown upserts remain.

No recorder ran, no committed recording was changed, and no credentials were collected. Other packages were only brought in through dependency merges; the recorder manifest conflict preserves both foundation and provider-kit dependencies.

## Review regressions and performance

Each of the ten blockers was first reproduced through the public translator/session API. Initial regressions failed for two-question correlation, same-chunk turn completion, active resume controls, historical shell hydration, unrelated loaded threads, failed discovery guards, delta-only terminal ownership, aggregate/late shell output, immediate human flags and unsupported subagent variants. Each passes after its fix. Recovery also remains complete after a repeated child registration following a truncated stream.

Session tests discover the executable rather than supplying a discovery result. The executable handles version and login probes and refuses an incorrect app-server launch. Exit notifications are counted, terminal state is queried through the provider, and manual timers synchronize discovery retries without sleeps. No test runs a model.

The non-gating `node --expose-gc packages/adapter-codex/bench/plan.ts` run measured 464,013 / 927,013 / 1,853,013 emitted bytes for 1,000 / 2,000 / 4,000 100-byte chunks. Wall times were 3.42 / 4.70 / 6.71 ms; CPU times were 6.70 / 12.68 / 12.63 ms. Each stream has exactly two plan-tool upserts, including final authoritative markdown. A 10,000-frame probe with unique 4-KiB payloads retained 0.13 MiB after GC and a far-future tick, with repeated runs between 0.13 and 0.34 MiB. Earlier measurements in the review were 50.05 / 200.10 / 800.20 MB of cumulative markdown and 40.88 MiB of retained unknown payloads. The new byte counts include every emitted fact, not only markdown. Wall timings vary substantially with shared-machine load and never gate tests.
