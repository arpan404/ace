# Static verification and merge-time work

The owner requires tests to run only at merge. No test, mutation, provider prompt,
recorder, benchmark or runtime probe was executed for this feature. The tests
below express the intended behaviour and need run at merge. Static checks cannot
establish runtime correctness.

The behavioural suites are `thread-fork.process.test.ts`,
`thread-switch.process.test.ts`, `thread-merge-account.process.test.ts`, Codex's
`fork-selection.process.test.ts`, Claude's `fork-selection.process.test.ts`,
`handoff-read.process.test.ts`, and `packages/handoff/src/index.test.ts`.
They use fake providers, temporary SQLite, native account rollouts and real git
patch application. Synchronisation uses engine flushes, frame delivery and
explicit I/O barriers, with no sleeps or wall-clock performance assertions.

| Production mutation                                      | Behaviour test designed to kill it                              | Status                           |
| -------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| Disable the native-fork path                             | Native fork retains provider history and lineage                | Not executed, tests run at merge |
| Force native fork without supported boundaries           | Portable fallback contains cited handoff and pointers           | Not executed, tests run at merge |
| Reject failed run outcomes                               | Failed run forks its native history                             | Not executed, tests run at merge |
| Reject terminal quota-limited roots                      | Usage-limited finished run forks before reset                   | Not executed, tests run at merge |
| Replace the chosen native boundary with the session tail | Older source point excludes later messages                      | Not executed, tests run at merge |
| Close the current session when accepting a switch        | Queued switch leaves the current turn running                   | Not executed, tests run at merge |
| Ignore live background tasks when checking readiness     | Queued switch waits for the background task                     | Not executed, tests run at merge |
| Clear the native session ID on model changes             | Same-provider model change retains identity and history         | Not executed, tests run at merge |
| Skip accounts migration or ancestor copying              | Destination contains source transcript and ancestor before fork | Not executed, tests run at merge |
| Discard merge provenance                                 | Synthetic merged context retains source and citations           | Not executed, tests run at merge |
| Share one options record across models                   | Returning to a provider/model restores its own options          | Not executed, tests run at merge |
| Store fork lineage as live parent ownership              | Fork root has lineage and null parent, source can finish        | Not executed, tests run at merge |
| Count text characters instead of serialized UTF-8 bytes  | Unicode/escaping handoff remains within budget                  | Not executed, tests run at merge |
| Drop queued switches during restart recovery             | Latest queued selection survives restart                        | Not executed, tests run at merge |
| Release session ownership after a failed close           | Failed close preserves old native session and refuses switch    | Not executed, tests run at merge |
| Remove patch-merge guards                                | Both trees reject racing sends until patch completion           | Not executed, tests run at merge |
| Continue after configuration and rollback fail           | Uncertain configuration prevents a later turn                   | Not executed, tests run at merge |
| Ignore recipient grants or their sequence cutoff         | Handoff tools deny unrelated threads and later source streams   | Not executed, tests run at merge |
| Delete history grants after prompt delivery              | Portable fork can page and reconstruct full text after delivery | Not executed, tests run at merge |

The non-gating benchmarks are `packages/handoff/bench/selection.ts` and
`apps/daemon/bench/thread-transitions.ts`. The first selects 200 previews over a
million-item source count. The second streams with a queued switch and 1,000
retired agents. They emit ops/s, microseconds/op and peak RSS. Numbers are
unmeasured, needs run at merge. The readiness index updates changed agents in
the same transaction as the engine snapshot; item deltas do not enumerate
historical agents for switch readiness. Handoff construction is a cold operation
with bounded pages, excerpts and metadata.

Provider integration must be checked after the parallel adapter branches land.
Native fork requires explicit `forkPoints`; the legacy `fork` boolean alone does
not establish that an adapter consumes `SessionContext.fork`. This prevents a
new empty session from being advertised as a full-history fork.
