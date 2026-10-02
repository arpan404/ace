# Codex adapter verification

All eight 0.159.1 recordings have expectation files. The testkit timeline CLI confirmed every listed checkpoint. Background shell completion remains waiting from t=12290 until t=23076. The round-2 interrupt remains waiting from t=14503 through its late command output until t=67107. Plan review stays pending at t=38723 and t=48897 and expires at the recorder's deliberate exit. Child work prevents early done at t=9062; the current core reports working until t=14153, with the root blocked on its background task.

The offline suite contains 47 adapter tests. Real supervised fake-CLI processes cover commands and process effects; frame promises provide synchronization. No tests send prompts to the installed Codex CLI. The opt-in live initialize handshake passed and stopped its process without starting a thread.

The complete repository check passes formatting, lint, source-size checks, all workspace typechecks and offline tests. The adapter sources are below 400 lines each. Generated protocol files come from the installed CLI rather than handwritten native definitions. Generation was rerun after formatting and produced the same definitions.

## Mutation evidence

`node packages/adapter-codex/scripts/mutations.ts` applies these changes one at a time and restores the original source in `finally`. Each mutation caused its targeted Vitest suite to exit with test failures. They were all reverted before the final repository check.

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

An initial mutation attempt exposed a weak orphan-question test: core's fallback item made the link assertion pass. The test was strengthened to require the native payload in the linked tool's raw data, and the mutation then failed as expected.

## Contract limits

The requests and rationale are in [README.md](README.md). Core currently labels active background children as working, can mark a child unresponsive before its first turn, and cannot encode an explicit wait on subagent keys. The adapter keeps all live work unsettled without inventing status facts. Native queue counts and ace's queued input share one counter. Plan markdown requires cumulative upserts; the recorded-plan benchmark measures their cost and explains the requested markdown delta field.

No recorder ran, no committed recording was changed, and no credentials were collected. Other packages were only brought in through dependency merges; the recorder manifest conflict preserves both foundation and provider-kit dependencies.
