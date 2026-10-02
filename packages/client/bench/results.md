# SDK benchmark results

Historical measurements taken before the owner prohibited tests, probes and benchmarks. They describe the measured fix-round revision; performance of the final revision needs run at merge. No benchmarks were executed after the new rule.

Node 26.8.1 on macOS, 2026-10-02. Non-gating measurements on the shared development machine while other worktrees were checking; scheduling contention makes these unsuitable for absolute comparison with earlier runs. Store cases apply 200,000 events, do not include wire parsing, and include the bounded reconciliation journal. RSS is the process high-water mark, cumulative across cases. Multipart prefixes remain 199 empty text parts plus the changing tail throughout this run.

| Case                                            | Operations/s |     µs/op | Peak RSS MiB |
| ----------------------------------------------- | -----------: | --------: | -----------: |
| One-part delta application                      |      173,434 |     5.766 |        199.6 |
| 200-part delta application                      |      151,353 |     6.607 |        229.2 |
| One matching, 1,000 unrelated selectors         |      251,430 |     3.977 |        229.4 |
| 100 matching, 1,000 unrelated selectors         |       32,206 |    31.050 |        253.9 |
| One agent, 100,000 distinct parents, entities:1 |      434,001 |     2.304 |        115.4 |
| 64 KiB output reads over daemon/socket          |          205 | 4,888.320 |        203.0 |
| Cold one-byte reads, 1,000 history events       |          818 | 1,222.412 |        223.5 |
| Cold one-byte reads, 10,000 history events      |          649 | 1,540.004 |        227.6 |

Reparenting retained 0.157 MiB additional heap after GC. Cold reads release the subscription and cross a socket barrier before measuring. They use the daemon's indexed stream API, with no transcript reconstruction. The 200-part case costs 14.6% more per event than the one-part case, rather than scanning/copying all 200 parts per delta. Accessing the lazy public parts array materializes that bounded array on demand.

For the authorized merge-time workflow, run from the repository root:

```
node packages/client/bench/events.ts
node --expose-gc packages/client/bench/parents.ts
node packages/client/bench/reads.ts
```

## Verifier follow-up workloads

`ranges.ts` adds one-byte reads inside single 1 MiB and 16 MiB blobs, plus daemon persistence into one-part and 200-part text messages. These exercise SQLite range slicing and the new text-source append path. No measurements were taken: **needs run at merge**. The historical numbers above do not measure these changes.
