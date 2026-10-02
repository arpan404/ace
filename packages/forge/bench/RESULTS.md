# Forge verification

Run on 2026-10-02 in the feature worktree with Node 26.8.1 on Darwin arm64 using native TypeScript execution. Benchmarks are non-gating; process RSS is the cumulative high-water mark, including the in-memory SQLite benchmark database. The production ledger uses a file database and removes acknowledged payloads.

| Operation                                        | Samples |     Ops/s |  µs/op | Peak RSS MiB |
| ------------------------------------------------ | ------: | --------: | -----: | -----------: |
| Check mapping                                    | 100,000 |   353,505 |   2.83 |        100.0 |
| Review diff, two current records                 | 100,000 |   661,071 |   1.51 |        104.9 |
| Streamed tail, 50 KB chunk                       |   2,000 |     1,464 | 683.08 |        121.3 |
| SQLite admission and acknowledgement             |  10,000 |    34,202 |  29.24 |        170.5 |
| Indexed duplicate lookup after 10,000 deliveries | 100,000 | 1,591,358 |   0.63 |        182.4 |

`bun run --filter @ace/forge bench` reproduces these workloads. Incoming log processing is linear in chunk bytes. Review diffing indexes only the current capped snapshot. Duplicate detection uses SQLite's primary-key index rather than an in-memory session history scan.

## Deliberate mutations

Each mutation was applied to production code alone, killed by the listed behaviour test, and reverted. No mutation remains in the delivered implementation. All twelve exited with a failed Vitest test, rather than a tooling error.

| Mutation                                      | Broken behaviour caught by test                                   |
| --------------------------------------------- | ----------------------------------------------------------------- |
| M1: ignore merged flags                       | Merged PR stays merged even when GitHub also reports closed       |
| M2: report CI failures as success             | Failure outranks pending and successful checks                    |
| M3: report in-progress checks as success      | Running checks remain pending even with a success conclusion      |
| M4: reject cached 304 responses               | ETags reuse unchanged resources while new comments remain visible |
| M5: stop after the first REST page            | Checks and comments on subsequent pages are returned              |
| M6: retain recognised GitHub tokens           | Unknown fields are preserved only after token redaction           |
| M7: double the log ring allocation            | The log tail never exceeds its configured byte cap                |
| M8: delete acknowledged delivery identities   | The same feedback never queues again after restart                |
| M9: ignore server retry deadlines             | Polling waits through the full rate-limit deadline                |
| M10: omit expected merge SHA                  | Merge requests carry the head guard                               |
| M11: ignore inactive review-thread membership | Resolved and outdated feedback never queues                       |
| M12: double the snapshot byte budget          | Oversized paginated snapshots fail visibly                        |

The full repository check after merging origin/main passed 389 tests, with four opt-in tests skipped. Forge's 32 tests use a temporary executable fake `gh`, synthetic recorded JSON responses, real git repositories, real subprocess cancellation handshakes and temporary SQLite. No coding-provider prompts or recorder sessions were run.

A read-only smoke test through the real logged-in `gh` read ace PR #10 as merged with two successful checks and no review threads. It printed only aggregate status fields. No live mutation calls were made.
