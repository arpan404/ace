# PR #116 review verification

The owner requires static checks only in this run. Regression tests were written
before the corresponding production fixes, but neither the failing nor passing
version was executed. Every runtime expectation below needs run at merge. No CI,
provider prompts, benchmarks, mutation runs or flakiness runs were started.

## Blocking regressions

| Finding                       | Public behavior guard                                                                            | Static before/after trace                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP catalog identity          | `agent-control/acp.process.test.ts`                                                              | A production-shaped catalog ID differs from the account ID. Admission and cold refresh now filter by all three ACP identity fields; changing the installation, account or agent rejects before another child is created.                  |
| Prepared result input         | `engine/delegation-transports.process.test.ts`                                                   | OpenCode and Cursor SDK translators receive combined switch/merge context and wake input. Text matching previously left user items. Persisted command/message correlation now folds both outgoing input and replay into one settled item. |
| Prototype-named unknown codes | `engine/provider-errors.process.test.ts`                                                         | `constructor`, `__proto__`, `toString` and `hasOwnProperty` previously selected inherited values. Own-property lookup retains their original notice text and allows later assistant/result frames to commit.                              |
| Copied wake text              | `agent-control/results-delivery.process.test.ts`, `engine/delegation-transports.process.test.ts` | A public user send copies an earlier wake verbatim. The new command gets a durable user-origin message identity, retains its user item after restart/replay, and leaves the settled result unchanged.                                     |

Paths above are relative to `apps/daemon/src`. Transport tests use real native
translators with CLI boundary doubles, temporary SQLite and public engine commands.
Adapter session guards additionally exercise correlation before native admission
for OpenCode, Cursor SDK, Claude SDK, ACP and queued Codex fallback. The agent-control
fixture forwards both command ID and origin. The MCP metadata test now accurately
names a transcript-read call rather than claiming cursor paging.

## Mutation cases

These are intended behavioral guards, not claims of measured kills. M =
`agent-control/models.process.test.ts`, I = `agent-control/inline-delegation.process.test.ts`,
R = `agent-control/results-delivery.process.test.ts`, T = `engine/delegation-transports.process.test.ts`,
A = `engine/ace-approvals.process.test.ts`, E = `engine/provider-errors.process.test.ts`,
under `apps/daemon/src`. C/P are the respective Codex/Pi adapter
`src/delegation-context.process.test.ts` files. D is `agent-control/acp.process.test.ts`.

| #   | Mutation                                                     | Behavior intended to reject it                                                                                        | Status                            |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | Remove the account filter                                    | M selected account launches Sonnet even though the foreign account knows the guessed alias                            | not executed (tests run at merge) |
| 2   | Return the guessed model verbatim                            | M `opus-5.5` launches catalog-native Sonnet                                                                           | not executed (tests run at merge) |
| 3   | Skip the configured fallback                                 | M configured Opus wins over an invalid guess                                                                          | not executed (tests run at merge) |
| 4   | Select an arbitrary non-default row                          | M no default rejects instead of choosing available non-default Opus                                                   | not executed (tests run at merge) |
| 5   | Create the child before model rejection                      | M rejected delegation preserves the thread list and active count                                                      | not executed (tests run at merge) |
| 6   | Remove resolved-model alias matching                         | M `claude-opus-5-5` launches native Opus                                                                              | not executed (tests run at merge) |
| 7   | Omit the pre-launch card                                     | I prepared child is readable before opening a provider session                                                        | not executed (tests run at merge) |
| 8   | Complete a card while background work runs                   | I card stays live and parent stays unfinished after the assistant turn                                                | not executed (tests run at merge) |
| 9   | Keep a stale generation/outcome on follow-up                 | I follow-up increments generation, clears outcome and reopens the same card                                           | not executed (tests run at merge) |
| 10  | Disable echo attribution                                     | R/T no ace input appears as a user message                                                                            | not executed (tests run at merge) |
| 11  | Drop durable attribution                                     | R/T replay after engine/SQLite restart keeps one ace result                                                           | not executed (tests run at merge) |
| 12  | Do not consume the waiting result                            | R waiting MCP call returns its outcome with no parent wake                                                            | not executed (tests run at merge) |
| 13  | Consume results when a wait is canceled                      | R canceled wait leaves the child running and later delivers its result                                                | not executed (tests run at merge) |
| 14  | Send idle Codex results as user input                        | C input is empty and untrusted additional context carries the results                                                 | not executed (tests run at merge) |
| 15  | Accept an incorrect Pi control secret                        | P wrong secret sends no message; correct secret sends custom ace context                                              | not executed (tests run at merge) |
| 16  | Classify reads as execution                                  | A transcript reads in ask/auto-review/read-only resolve as read-only actions                                          | not executed (tests run at merge) |
| 17  | Approve execution in read-only mode                          | A delegated execution is denied at the inherited read-only ceiling                                                    | not executed (tests run at merge) |
| 18  | Trust a foreign bare tool name                               | A foreign server and invalid read arguments remain pending for a human                                                | not executed (tests run at merge) |
| 19  | Omit readable details/raw                                    | E known model failure retains readable notice, details and native evidence                                            | not executed (tests run at merge) |
| 20  | Rewrite unknown errors or assistant prose                    | E unknown notice/prose survives verbatim                                                                              | not executed (tests run at merge) |
| 21  | Address ACP catalogs by account ID                           | D unequal catalog/account IDs still resolve the approved model                                                        | not executed (tests run at merge) |
| 22  | Restore bare-wake text matching                              | T combined switch and merge parts still fold into ace results                                                         | not executed (tests run at merge) |
| 23  | Allow inherited error-map properties                         | E prototype-named notices remain strings and later frames commit                                                      | not executed (tests run at merge) |
| 24  | Attribute copied user text to ace                            | R/T copied input stays user-origin and preserves the ace item                                                         | not executed (tests run at merge) |
| 25  | Drop provider correlation callbacks                          | Adapter session guards require the projected native ID to match a host correlation recorded before the outgoing frame | not executed (tests run at merge) |
| 26  | Give all dynamic tools an external-effect or read-only class | Browser/device/screen MCP guards distinguish reads from native actions and JavaScript execution                       | not executed (tests run at merge) |

Additional mutation 27: projecting an oversized native identity into the bounded
item field should be rejected by T's uncorrelated-input regression. It requires
user content and the raw identity to survive without a failed frame transaction.
Status: not executed (tests run at merge).

## Performance evidence

No timing, throughput or RSS numbers were collected for this head. Measurements
need run at merge; the prohibition on benchmarks takes precedence over the earlier
request for measured numbers in the PR description.

Static inspection finds no transcript/history scan in echo attribution. A text
delta performs zero attribution queries. An uncorrelated/user message performs at
most one indexed correlation lookup; an ace echo performs that lookup plus one
indexed command lookup. The primary keys are `(thread_id,native_id)` and
`(thread_id,command_id)`. Correlation admission inserts one row once per native
message, rejects identity reuse by another command, and does not rewrite it on
replay. The attribution record stores at most 64 result previews of 128 UTF-16 code
units each; it no longer stores the full prepared/wake text. Rows cascade on thread
deletion. Pure attribution is separate from SQLite I/O.

The existing merge-only harness is `apps/daemon/bench/agent-control.ts`. It compares
the following identical workloads with `ACE_BENCH_HISTORY=0`, `3000` and `9000`:

| Workload                   | Operations per sample               | Measured result at this head      |
| -------------------------- | ----------------------------------- | --------------------------------- |
| Delegation admission       | 32 children                         | not executed (tests run at merge) |
| Inline live status updates | 10,000 updates over 32 children     | not executed (tests run at merge) |
| Usage streaming            | 10,000 events                       | not executed (tests run at merge) |
| Bounded context production | 10,000 summaries, 8,192-byte budget | not executed (tests run at merge) |
| Resource retention         | Peak RSS across each workload       | not executed (tests run at merge) |

Compare the same harness on base and head, retain raw results, report admission
microseconds, status/usage/summary throughput and peak RSS. End-to-end streaming,
cleanup and memory behavior remain needs run at merge; bounded/indexed source
inspection is not a substitute for measurements.
