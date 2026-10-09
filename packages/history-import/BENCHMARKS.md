# History benchmark baseline

Historical measurements from pre-review head `2c8a9a3`, not validation of the revised implementation. Current owner-scale measurements follow the historical notes below.

Measured with Node v24.21.0 on macOS arm64, 16 physical cores and 128 GiB RAM. Other workstreams were active, so these are observations, not gating budgets. Cold means a new ace index; the synthetic files were just written and may be in the OS cache. Peak RSS covers the whole process, including the worker and fixture creation, and is cumulative within each script.

Merge-time benchmark scripts, not executed in this revision:

```sh
bunx --package node@24 node packages/history-import/bench/scan.ts
bunx --package node@24 node packages/history-import/bench/native-stores.ts
bunx --package node@24 node packages/history-import/bench/tools.ts
bunx --package node@24 node apps/daemon/bench/history.ts
bunx --package node@24 node apps/daemon/bench/history-live.ts
```

| Path                                                                    |       Time |          Throughput |  Peak RSS |
| ----------------------------------------------------------------------- | ---------: | ------------------: | --------: |
| 5,000 JSONL files, cold index                                           | 2,395.5 ms |       2,087 files/s | 179.2 MiB |
| 5,000 JSONL files, warm index                                           |   215.7 ms |      23,176 files/s | 179.7 MiB |
| 20,000 messages, external discard sink                                  |   328.1 ms |      60,949 items/s | 284.3 MiB |
| 20,000 messages, persistent worker archive                              |   561.9 ms |      35,593 items/s | 338.6 MiB |
| 100 history pages of up to 200 items                                    |   256.3 ms |         390 pages/s | 345.9 MiB |
| OpenCode SQLite plus legacy storage, cold index                         |   151.9 ms | two session sources | 170.9 MiB |
| OpenCode SQLite plus legacy storage, warm index                         |   500.2 ms | two session sources | 187.1 MiB |
| 5,000 OpenCode SQLite messages, persistent import                       |   177.6 ms |   28,159 messages/s | 221.4 MiB |
| 1,000 legacy storage messages, timestamp ordering and persistent import | 1,092.0 ms |      916 messages/s | 244.0 MiB |

In the historical runs, both warm scans opened zero unchanged content readers and sampled zero JSONL bytes. Legacy storage still stats its message and part paths, so its warm index cost depends on that inventory. Live SQLite snapshots copy the database and WAL before querying to preserve source shared-memory bytes. The scan byte counter measures sampled JSONL windows, not SQLite page reads or snapshot copying.

Historical bounds included 16 concurrent file samples, 128 KiB of samples per file, 1 MiB per decoded record, 64 KiB blob chunks, 16 packets per external pull, 512 agents, 32 path components, 100,000 inventory entries, 200 items or 1 MiB per item page, and 256 KiB per blob read. Legacy message sorting uses a private SQLite file rather than an in-memory transcript array. Small part inventories sort at most 16 paths before spilling to disk. SQLite scalar records above the decoder limit are refused before loading them.

New correlation and publication paths have benchmark scripts, but no revised throughput or RSS measurements. `bench/tools.ts` covers 2,000 native calls with 4-KiB results and streamed output. `apps/daemon/bench/history.ts` covers 20,000 selected Claude ancestry records and publication through an authenticated socket. Cold/warm scans, bounded import memory, tool correlation and daemon publication all need run at merge.

The verifier fix adds no history scan on a live callback: current-native identity requires one indexed root-agent lookup per new continuation, and publication pauses/resumes ingress once per import. `apps/daemon/bench/history-live.ts` measures authenticated publication overlapped with 2,000 synthetic live frames and an exit, reporting frames/s, microseconds/frame and peak RSS. The transport produces one callback at a time under backpressure. No current publication-throughput numbers are claimed; this benchmark needs run at merge.

## October 2026 owner-scale checks

Node v26.8.1, macOS arm64, shared 16-core host. The worker limit remains 128 MiB old generation plus 16 MiB young generation. Timing observations are not gating tests. Fixture generation runs in a separate process so its allocator retention does not contaminate scan RSS.

The fixtures contain 6,000 legacy OpenCode sessions (18,000 session/message/part files), 5,352 Codex transcripts, 1,027 Claude transcripts, 5,351 Codex database rows duplicating file sessions, and 802 OpenCode database sessions with 48,120 messages. Titles include 126-KiB injected plans; one SQLite message is 27,350,606 bytes. Sparse JSONL files reproduce measured median, p95 and maximum lengths, including a 1,876,966,062-byte Codex file and a 154,914,603-byte Claude file. Their oversized padding is intentionally opaque. They do not replay every real message or reproduce the owner's 33-GB database's unused pages.

| Measurement                                | Main `cf1234089` |   Revised |
| ------------------------------------------ | ---------------: | --------: |
| Cold scan, 12,381 inventory entries        |        15,162 ms | 18,481 ms |
| Warm scan, zero content reads              |           718 ms |  1,175 ms |
| History process peak RSS                   |        275.7 MiB | 249.8 MiB |
| Worker sampled peak JS heap                |         41.7 MiB |  41.5 MiB |
| History process RSS after two idle minutes |        194.6 MiB | 176.2 MiB |

The full compiled daemon completed a ten-minute scan/idle soak: 242.2 MiB final RSS and 243.5 MiB maximum from two minutes onward. A revised compiled build then scanned, completed four synthetic agent turns and idled for ten minutes: 234.7 MiB final RSS and 234.7 MiB maximum from two minutes onward. Initial post-scan RSS in that run was 277.6 MiB. The matched main build finished the same light-use soak at 241.3 MiB, with a settled maximum of 254.9 MiB. Both fresh fixture runs meet the budget; the revised run lowers the settled peak by 20.2 MiB. The performance gate also covers history followed by four completed synthetic agent turns before measuring idle RSS. Its short mode waits two minutes and its long mode ten minutes; every sample after the settling interval must stay within 256 MiB. No forced collection is used in this history check.

Heap snapshots from scratch source-runtime runs showed schema objects, closure contexts and arrays among the largest JS retainers. History now imports an entity-schema entry instead of the entire protocol graph, reuses provider SQLite statements across rows, and reuses its progress schema. Files are sampled two at a time; fallback metadata decoding is limited to 128 KiB per record. Incremental summaries remain in SQLite, and unchanged content is skipped. Oversized first requests are marked unavailable rather than decoded for previews. Import retains its 1-MiB record decoder and streams larger opaque records into raw blob chunks.

A read-only measurement also scanned the owner's allowlisted history roots, with all persisted metadata anonymized before entering its scratch index. It read 6,004 inventory entries and iterated 6,154 database sessions through immutable read-only handles, without copying transcripts or database snapshots. Revised peak heap was 29.2 MiB and process RSS 157.5 MiB; the corresponding main scan measured 31.3 MiB and 175.2 MiB. The runs took 24.3 and 13.6 seconds respectively, read 2.46 and 2.23 GB of sample/fallback data, and reported 212 versus 3 unsupported entries because of the stricter preview bound. Immutable database measurements may omit recent WAL commits. These measurements exercise scan logic, not the complete worker RPC/import shell.

The original heap exhaustion from the real-data audit was not reproduced by either baseline measurement. These results establish bounds and recovery behavior; they do not establish the exact retainer responsible for that crash, nor reproduce the owner's reported 480–510-MB light-use session. Credentials, provider prompts, real projects and the live ace home were not used. Only allowlisted native history and log measurements were read.

Reproduce the isolated scan with `node packages/history-import/bench/scale.ts`; add `--snapshot` for synthetic worker/main heap snapshots. Compile the daemon with `node apps/daemon/bench/compile.ts --output=<scratch-build>`, then run `node apps/daemon/bench/history-idle.ts --entry=<scratch-build>/ace.mjs`. The latter isolates HOME, PATH, provider homes and the ace data directory. `--snapshot` retains its scratch directory and captures a SIGUSR2 heap snapshot; `--idle-ms=120000` selects the short check.

Artifacts: `/tmp/ace-orch/history-{baseline-matched,scale-final,bundled-after,light-use-soak,baseline-light-use-soak,readonly-before,readonly-after,final-perf}.log`; synthetic heap snapshots `/tmp/ace-history-{before,worker,daemon}.heapsnapshot`; fixture screenshots `/tmp/ace-orch/shots/fix-history-memory/`.
