# Context verification

The local gate passed on Node v26.8.1, macOS arm64 after merging remote-access PR #13, the fixture correction #30 and MCP PR #21 from origin/main. `bun run check` passed format, lint, the 1,500-line limit, TypeScript and Vitest: 506 passed, four existing opt-in live-provider tests skipped. This feature adds 56 behavior tests using real Git repositories, files, symlinks, temporary SQLite and WS/WSS. No provider prompts, recorder sessions or GitHub CI runs were used.

An early socket backpressure test depended on whether two packets arrived before the first operation completed. Its replacement uses an explicit authorization boundary barrier and tests the observable busy response and later successful result. The existing remote CLI test timed out at Vitest's default five seconds in two loaded full-suite runs, while its focused run passed. The subsequent MCP merge brought its upstream lazy CLI import and timeout adjustment. The full gate then passed. No timing budget was added to this feature's tests.

## Mutation evidence

`node packages/context/bench/mutations.ts` applies each mutation alone, runs the named public behavior test, requires an AssertionError, and restores the original production file in a finally block. All sixteen were killed and reverted. The global quota mutation removes both overlapping logical and occupied-byte checks; the GIF mutation removes both frame admission and trailer frame-count gates. Other safety checks remain active.

| Mutation                         | Assertion that fails                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Bypass workspace confinement     | Outside absolute paths and parent traversal yield no file bytes                 |
| Accept Git ignored paths         | Ignored tracked files cannot resolve                                            |
| Decode NUL bytes as text         | Binary files produce diagnostics rather than context                            |
| Drop file-cap truncation markers | Capped context has a marker and truncation flag                                 |
| Shift inclusive line ranges      | Only the requested one-based lines appear                                       |
| Bypass per-thread byte quota     | Pending and retained bytes block excess uploads                                 |
| Bypass global byte quota         | Reservations across threads cannot exceed the global limit                      |
| Accept hash mismatches           | Bad hashes fail and release reservations                                        |
| Bypass image pixel-area limit    | A 10,000-by-10,000 header is refused before decode                              |
| Ignore image magic bytes         | A PNG named document.txt is identified as PNG                                   |
| Bypass GIF animation gates       | A second frame is refused                                                       |
| Remove PNG header checksum check | Corrupt IHDR CRC is refused                                                     |
| Disable Codex image projection   | Codex gets a localImage native part                                             |
| Collect referenced blobs         | Shared retained bytes survive GC                                                |
| Bypass occupied disk quota       | Releasing a reference cannot free disk quota before GC, including after restart |
| Allow another device to resume   | Upload status is bound to its owning device                                     |

Additional regression tests cover retry identity, gaps, durable offsets, unacknowledged trailing bytes, per-entry/file caps, expired reservations, queued access revocation, lying image extensions, truncated containers, shared references, orphan batches, rename-before-transaction recovery, released commit replay, and publication after an interrupted GC. Native formats and fallbacks are tested for Claude, Codex, OpenCode and ACP. Remote tests use actual pinned WSS and paired read/operate credentials.

## Benchmarks

Final runs used a real 50,000-file Git repository and a streamed 16 MiB payload in 64 KiB chunks. Timings are informational and vary with shared-machine load.

| Measurement                                        |             Final run |
| -------------------------------------------------- | --------------------: |
| Cold file/folder index                             |              225.1 ms |
| Completion median, 600 mixed fuzzy queries         |  2,791.0 microseconds |
| Completion p95                                     |  4,713.3 microseconds |
| Incremental file update, including Git ignore I/O  | 13,268.9 microseconds |
| Mention resolution, including Git validation I/O   | 26,120.8 microseconds |
| Durable direct upload, including commit/hash       |           11.79 MiB/s |
| Projection of 64 parts                             |    23.67 microseconds |
| One GC batch                                       |               2.33 ms |
| Peak RSS, including repository setup               |            231.20 MiB |
| Durable real loopback WebSocket upload             |           10.53 MiB/s |
| Peak RSS, daemon WebSocket benchmark including MCP |            158.78 MiB |

Run `bun run --filter @ace/context bench` and `bun run --filter @ace/daemon bench:context`. The repository benchmark includes file creation in peak RSS, not in operation timings. Earlier loaded runs measured 6.06 to 11.79 MiB/s direct upload and 2.68 to 3.43 ms completion median. The WebSocket benchmark includes JSON/base64, authentication, chunk acknowledgments, SQLite commits and streaming sha256. It measures loopback, not cellular RTT or TLS throughput.

Watch updates maintain directory counts and child sets in O(path depth). Subtree expansion visits descendants only. Fuzzy search chooses the smallest character posting, checks subsequences and retains at most 50 best results. Startup and ignore invalidation rebuild the bounded index; normal completion does no filesystem work. Upload chunks do O(chunk) decode/write plus a durable sync; commit streams the file once for hashing and walks capped metadata blocks without pixel decode. Prepared provider bytes have a separate aggregate cap. GC uses indexed reference/expiry queries and retained directory cursors, without rescanning all blobs each tick.
