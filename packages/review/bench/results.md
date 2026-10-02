# Re-anchoring measurements

These historical measurements were collected before the repository owner deferred test and benchmark execution to merge time, and before the final anchor corrections. They do not validate the final revision. The current benchmark needs run at merge.

Node 26.8.1 on the shared development machine. Five warm-up batches followed by twenty measured batches. Each batch re-anchors 1,000 comments across 10,000 source lines; all 1,000 changed comments were pending review. This benchmark has no gating timing assertion.

| Transition  | CPU µs/comment | Wall µs/comment | Comments/s | Peak RSS MiB | Load average |
| ----------- | -------------: | --------------: | ---------: | -----------: | -----------: |
| One hunk    |          29.89 |          169.09 |      5,914 |       224.53 |       215.06 |
| 1,000 hunks |          22.38 |          179.62 |      5,567 |       265.09 |       212.81 |

Peak RSS is the process high-water mark, so the second workload includes the first workload's allocations. CPU includes user and system time. Wall measurements on this machine varied from 15 to 540 µs/comment across runs as contention changed; these are measurements of the final recorded run, not a latency promise. Both workloads build one transition index and use binary searches for line and hunk mapping, with bounded fuzzy candidates.

At merge, reproduce with `bun run --filter @ace/review benchmark`.
