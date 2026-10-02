# Settings verification

This records the original implementation baseline. Current review regressions, mutation results, local gate and expanded benchmarks are in [review verification](REVIEW-VERIFICATION.md).

Each mutation below changed production code, ran the named public behavior test and produced a failing assertion. Each change was reverted before the next run. Commands used `bun run test <test file> -t <behavior>`.

| Production mutation                                              | Failing behavior                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Reverse layer precedence                                         | each key resolves from the highest present layer and reports its provenance             |
| Skip migration write-back                                        | a v1 document migrates on read and is written back exactly once                         |
| Replace the settings container on set, losing unknown keys       | sets retain unknown fields, comments, trailing commas and local indentation             |
| Reserialize before editing, removing comments                    | sets retain unknown fields, comments, trailing commas and local indentation             |
| Reset last-good state on invalid edits                           | invalid external edits retain the last good values, report diagnostics and block writes |
| Stop cancelling replaced debounce timers                         | a watcher burst produces one diagnostic after its debounce boundary                     |
| Notify shadowed subscriptions without effective-value comparison | subscriptions ignore unrelated keys, unchanged assignments and shadowed changes         |
| Disable recursive secret guards                                  | secret-looking fields and values are rejected without echoing their contents            |
| Remove the client blob cap                                       | oversized blobs, invalid values and future documents do not replace valid settings      |
| Ignore provenance when comparing notifications                   | file deletion reports a provenance change even when the fallback value is equal         |
| Publish destination before writing instead of atomic rename      | ace rereads earlier external edits and the last rename wins without torn files          |

## Remote integration mutations

| Production mutation                  | Failing behavior              |
| ------------------------------------ | ----------------------------- |
| Bypass settings read scope           | an operate-only device        |
| Bypass settings write scope          | a pinned read-only device     |
| Disable the settings socket byte cap | settings deliveries exceeding |

## Local gate

`VITEST_MAX_WORKERS=1 bun run check` passed after merging remote access from `origin/main`: 47 test files passed, one skipped; 425 tests passed, four skipped. The settings work adds 27 public behavior tests. Format, lint, file size and all workspace type checks passed. The merged remote CLI test passed in isolation but exceeded its default five-second harness timeout during parallel full-suite runs. Running with one worker passed without changing tests or timeout configuration. GitHub CI was not run.

## Benchmark

Command: `bun run --filter @ace/settings bench`. Node 26.8.1, macOS arm64. No timing thresholds gate tests. The file boundary is in memory, so numbers include validation, JSONC edits, queueing and indexed delivery but exclude disk fsync/rename latency. One warmed run follows; differences between assignment rows include JIT warmup and are not a claim that subscribers make assignments faster.

| Operation                                               | Operations |      Ops/s | Microseconds/op | Peak RSS KiB |
| ------------------------------------------------------- | ---------: | ---------: | --------------: | -----------: |
| Cached get                                              |    100,000 |  1,701,914 |            0.59 |      108,736 |
| Assignment, no subscribers                              |      3,000 |     52,764 |           18.95 |      110,672 |
| Assignment, 1,023 unrelated and one affected subscriber |      3,000 |     63,639 |           15.71 |      111,136 |
| Watcher burst scheduling                                |    100,000 | 18,805,091 |            0.05 |      111,184 |
| External reconciliation, 16 KiB                         |      1,000 |     14,961 |           66.84 |      111,376 |

The indexed assignment run delivered 3,000 relevant notifications; the later external document replacement delivered one fallback/provenance change. Maximum process RSS was 111,376 KiB. Tests separately exercise real file writes, fsync/rename, directory watching, authenticated WebSockets and pinned TLS.
