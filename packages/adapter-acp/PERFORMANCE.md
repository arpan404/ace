# ACP refresh benchmark

Run `node packages/adapter-acp/bench/refreshes.ts` from the repository root. This offline probe runs translation, core application, and JSON serialization of every emitted event. It sends no provider requests and imposes no timing budget on tests.

Measured on this worktree, Node v26.8.1, after warm-up. Each refresh carries a 512-character unknown field; the initial call contains its original input. Times are informational and machine-dependent.

| Tool refreshes | Emitted bytes | Maximum retained raw frames per tool | Time (ms) |
| -------------- | ------------: | -----------------------------------: | --------: |
| 500            |       539,076 |                                    2 |     29.31 |
| 1,000          |     1,078,076 |                                    2 |     44.73 |
| 2,000          |     2,158,076 |                                    2 |     83.50 |

Bytes scale linearly with refresh count. Each published tool update contains assembled native input/name and the complete latest change, rather than all previous updates. Empty placeholders and partial input refreshes enrich that input snapshot; output-only refreshes reuse it. Full original frames remain available in emitted facts/events. Translator interpretation keeps only fields required for partial updates. Raw retention is bounded by two raw payloads per tool, rather than by refresh history; payload byte size itself is provider-dependent. Assistant error classification retains an 8 KiB prefix, while canonical deltas retain the transcript.

The review's separate workload emitted 59/236/943 MB and took 0.86/2.97/12.10 seconds at the same refresh counts. Its exact frame payload differs from this probe, so those numbers establish the previous quadratic behavior rather than an exact speedup ratio.

| Historical completed children | Notifications | Time (ms) |
| ----------------------------- | ------------: | --------: |
| 500                           |       100,000 |     24.86 |
| 1,000                         |       100,000 |     22.95 |
| 2,000                         |       100,000 |     24.74 |

Routing uses constant-time live-child and key indexes. Cascade traversal visits the selected subtree once using parent adjacency, rather than repeatedly scanning the global history. Completed intermediates remain indexed so a live grandchild is still reachable. Tool refresh and routing costs are independent of earlier refresh/child history; retained entity identity remains proportional to distinct tools and children.

Verifier follow-up measured after the local check completed, without a concurrent test run. A run during heavy machine load took 283.39/164.84/405.43 ms for tool refreshes and 62.14/313.91/94.09 ms for routing, with exactly the same emitted bytes and retention bounds. The tables report the subsequent run; timing variability is not a gating assertion.
