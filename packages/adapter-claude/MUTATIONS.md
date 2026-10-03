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
