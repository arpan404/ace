# SDK gap mutation cases

All cases are **not executed (tests run at merge)**. Each describes a production
mutation and the public behavior test designed to reject it. No mutation was
applied or run during implementation.

| Production mutation                                                           | Behavior test designed to kill it                                                                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Replace native title/description with reconstructed tool text.                | Permission metadata and destination test checks native prompt text and decline defaults.                                    |
| Ignore suppression when offering or accepting a permission update.            | Suppressed native permission process test rejects a forged grant and sends deny.                                            |
| Return only the first permission suggestion.                                  | Native permission process test checks both session and project updates in the provider response.                            |
| Delete pending asks before validating elicitation content.                    | Form process test rejects invalid content and subsequently delivers the valid answer.                                       |
| Resolve a pending request twice.                                              | Form/URL and existing approval process tests reject the second device answer.                                               |
| Cancel pending asks on process shutdown instead of expiring them.             | Process-close elicitation test checks an expired lifecycle fact.                                                            |
| Put inclusive total cost into main-loop agent usage.                          | Duplicate-root accounting test checks that agent samples have no inclusive cost; usage storage test checks additive totals. |
| Add model/session snapshots to daily agent rollups.                           | Usage-store reopen test keeps root+child total at 14 while model estimate is 110.                                           |
| Replace saved snapshot counters with zero/lower reports.                      | Usage-store reopen test reports zeros and preserves 110 tokens/$3.10.                                                       |
| Reuse the cumulative key across conversation reset.                           | Clear/startup accounting test expects distinct snapshot keys.                                                               |
| Process a duplicate result before its queue/turn effects are suppressed.      | Duplicate-root test retains the later turn working with one first-turn sample.                                              |
| Clear every retry on an allowed rate event.                                   | Allowed-window test preserves the other bucket and a later network retry.                                                   |
| Treat an absent result queue count as zero despite known interrupt survivors. | Interrupt-survivor test stays unfinished until the consumed UUID arrives.                                                   |
| Read default daemon home for filesystem fork.                                 | Concurrent fork process test checks private transcript content, source hashes and UUID chains in two homes.                 |
| Send a dummy user message during SDK model discovery.                         | Existing synthetic discovery CLI rejects every non-initialize message; discovery cleanup test checks resulting models.      |
| Skip discovery shutdown after metadata/cancellation failure.                  | Discovery process test awaits the synthetic child exit after each outcome.                                                  |
| Parse partial tool JSON as finished input.                                    | Partial-tool test produces no canonical tool before the completed block, then checks its completed path.                    |
| Stop a cascade at the first task error.                                       | Claude cascade process test observes the later shell stop and the aggregate failure.                                        |
| Remove Codex terminal cursor repetition guard.                                | Codex repeated-cursor process test requires a visible rejection instead of an unresolved Stop.                              |

The non-gating `bench/sdk-controls.ts` workload measures the public translator's
new accounting/queue path. It has not run. Ops/s, µs/turn and peak RSS need
measurement at merge; no numbers are claimed here.

## Review regressions

All additional cases are **not executed (tests run at merge)**. No caught or
survived result is claimed.

| Production mutation                                                              | Behavior test designed to kill it                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop scope in daemon SQL replay.                                                 | Canonical replay keeps root+child input at 14 while storing every inclusive model/session total across restart.                                                     |
| Route inclusive snapshots to the agent projection.                               | Client live delivery and forced snapshot reconnect preserve root activity plus two models and provider totals separately.                                           |
| Skip scoped materialization migration.                                           | Replay restart repairs an emulated old agent-keyed view from retained canonical history.                                                                            |
| Fail to publish zero after the last survivor is consumed without a native count. | The survivor regression now omits its explicit queue-count field.                                                                                                   |
| Keep an overflow guard after authoritative empty queue.                          | Overflow recovery with and without UUID echoes finishes; independent shell work stays unfinished.                                                                   |
| Accept inclusive scope without a counter key.                                    | Retained malformed snapshot is omitted and healthy replay advances; canonical admission rejects that malformed usage.                                               |
| Drop child cache-write counts or root/child one-hour subsets.                    | Root/refined-child public translation and usage pricing produce 71 input tokens, 36 writes, 13 one-hour writes and $0.0001423 equivalent cost under explicit rates. |
| Leave default daemon Claude discovery disconnected from MCP/account callbacks.   | Discovery-to-engine process test observes ace tools, persistent service lease ownership and thread-attributed rate metadata.                                        |
| Permit an unauthorized native MCP mutation or scoped total read.                 | Real socket service tests reject read-only mutations and operate-only snapshot reads.                                                                               |
| Lose process-exit unbinding for native controls.                                 | Provider exit makes the live control unavailable and the socket request fails visibly.                                                                              |
| Add a 60-second SDK callback deadline.                                           | The process callback test advances injected timers by 120 seconds, observes child progress and returns a valid typed answer.                                        |
| Open a human interaction for an unsupported dialog.                              | Unsupported dialog process test checks both native cancellation and absence of canonical interaction facts.                                                         |
| Retain all completed tasks or drop required completed ancestry.                  | Completed-task churn still admits/stops a later shell; a targeted cascade reaches a live descendant through a completed middle agent.                               |
| Evict live tasks or silently overrun accounting admission.                       | Live-task overflow exits visibly; child accounting overflow warns once while retained refinements remain idempotent.                                                |
| Reject SDK-native null cache counts.                                             | Child usage with null cache metadata still records ordinary input/output with zero cache subsets.                                                                   |
