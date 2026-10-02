# Context verification

`bun run check` passes format, lint, the 1,500-line source limit, TypeScript and Vitest: 619 passed, four existing opt-in provider tests skipped. The feature has 70 behavior tests through public APIs using real Git repositories, files, symlinks, temporary SQLite, WS and paired pinned WSS. The latest main merge includes relay and notifications. No provider prompts, recorder sessions or GitHub CI runs were used.

An unmodified full gate passed. Later overloaded rechecks hit existing daemon, notification and core timeouts. Final validation uses `bun run check -- --maxWorkers=2` to reduce test-worker contention without changing timeouts or assertions. The earlier focused daemon lifecycle rerun also passed. Tests add no gating performance budgets or synchronization sleeps.

## Review regressions

All three blockers were reproduced before fixing production code. A chunked 4 MiB PDF raised a V8 stack overflow during composition. A composed Codex local image disappeared after thread release and GC. A 44-byte WebP with a 1x1 canvas and 10000x10000 lossless frame committed successfully. Their behavior tests now pass, including Claude and ACP large documents, both VP8 frame encodings, atomic batch pinning during preparation, explicit consumption release, preparation-failure cleanup, lease admission caps and descriptor mutation safety.

Real Git subtree tests reproduced ignored tracked filenames reappearing and deleted descendants remaining. An owned Node executable emits 9000 bytes, ignores SIGTERM and holds stdout open; overflow and cancellation tests assert its PID is gone after rejection. A real filesystem watcher plus an injected update barrier verifies cached completion returns the published index before the update completes.

A failed injected storage durability barrier must leave the acknowledged offset unchanged across reopen. This tests the acknowledgement contract, not a physical power loss. An oversized PNG with invalid compressed pixels must produce the dimension diagnostic before compression failure, without decoding a large raster. Malformed WebP framing and mismatched frame/canvas tests detect omitted container validation. A pong ordering barrier detects missing socket-overlap rejection through an assertion, rather than a timeout.

## Mutation evidence

`node packages/context/bench/review-mutations.ts` applied all **28 reviewer mutations** individually, required an **AssertionError** from the named public behavior test, and reverted each in `finally`. All 28 were killed, including all three survivors. The socket-overlap mutation now fails an assertion using a pong ordering barrier, rather than the test timeout. The original 16-case runner remains available.

1. Bypass workspace confinement.
2. Accept Git ignored paths.
3. Decode NUL bytes as text.
4. Drop file-cap truncation markers.
5. Shift inclusive line ranges.
6. Bypass per-thread byte quota.
7. Bypass both global byte checks.
8. Accept sha256 mismatches.
9. Bypass image pixel-area limit.
10. Ignore PNG magic bytes.
11. Bypass both GIF animation gates.
12. Remove PNG header checksum checking.
13. Disable Codex native image projection.
14. Collect referenced blobs.
15. Bypass occupied-disk quota.
16. Allow another device to resume.
17. Persist acknowledged offset as zero.
18. Accept changed chunk retries.
19. Remove chunk fsync. Killed by a durability-failure result and unchanged offset across reopen.
20. Disable Claude native images.
21. Break OpenCode file URLs.
22. Disable ACP embedded resources.
23. Remove fallback diagnostics.
24. Remove socket overlap rejection. Killed by assertion before releasing the held request.
25. Retain deleted indexed files.
26. Inflate PNG before dimension rejection. Killed by dimension-error precedence over corrupt deflate data.
27. Skip WebP container validation. Killed by conflicting frame dimensions and missing image chunks.
28. Omit composed attachments.

## Benchmarks

Non-gating runs on macOS arm64 / Node v26.8.1, with a real 50,000-file Git repo and a streamed 16 MiB upload in 64 KiB chunks:

| Operation                                                            |  First review-fix run |       Loaded final run |
| -------------------------------------------------------------------- | --------------------: | ---------------------: |
| Cold file/folder index                                               |              807.2 ms |             1,629.9 ms |
| Completion median / p95, 600 mixed queries                           |  3,571.5 / 9,724.1 us | 4,587.7 / 146,126.3 us |
| Cached completion during a held watcher update, median / p95         | 3,432.9 / 26,546.0 us |  3,794.5 / 77,941.6 us |
| Incremental file update, including Git I/O                           |           32,974.8 us |           103,970.1 us |
| Subtree reconciliation, 100 files including Git I/O                  |          167,755.7 us |           194,716.3 us |
| Mention resolution, including Git I/O                                |           93,787.9 us |           128,640.8 us |
| Durable direct upload with hash/commit                               |            7.35 MiB/s |             4.05 MiB/s |
| Acquire/release one blob lease                                       |              31.87 us |              135.41 us |
| Projection of a 4 MiB document                                       |           10,595.2 us |            68,622.2 us |
| Projection of 64 parts                                               |              28.99 us |              133.17 us |
| GC batch                                                             |               4.85 ms |               19.80 ms |
| Peak RSS, index benchmark including repo setup                       |            292.11 MiB |             280.33 MiB |
| Real loopback JSON/base64 WebSocket upload                           |            5.27 MiB/s |           not repeated |
| Peak RSS, daemon WebSocket benchmark including MCP and notifications |            198.13 MiB |           not repeated |

The final run overlapped many other worktrees' Vitest workers on the shared machine. Both runs are reported because scheduling affects throughput and latency tails substantially. The held-update benchmark measures completion while a real watcher update is deliberately blocked, rather than waiting for it to drain.

Commands: `bun run --filter @ace/context bench` and `bun run --filter @ace/daemon bench:context`. Earlier shared-load runs varied; these are measurements, not timing gates or cellular-throughput guarantees. Upload hashing streams; no complete upload is buffered. Inline provider bytes are necessarily materialized under a separate cap.

Uploads do work proportional to chunk bytes, with durability before acknowledgement. Commit hashes one streamed pass and walks bounded metadata blocks without raster decode. Composition holds at most 128 leases of 64 references, and inline preparation has a separate aggregate cap. GC excludes leases using an indexed temporary table and keeps occupied storage charged until files are removed. The lease's internal hash snapshot cannot be changed by caller edits to returned descriptors.

The cache serves its current index during updates, with four LRU entries and 4096 pending paths per entry. Changed subtrees enumerate only their descendants and apply ignore/deletion filters. Git process ownership supplies bounded pipes, cancellation, deadlines and group reaping. Completion retains bounded top results from the smallest character posting; it does no filesystem I/O.
