# History benchmark evidence

Measured with Node v24.21.0 on macOS arm64, 16 physical cores and 128 GiB RAM. Other workstreams were active, so these are observations, not gating budgets. Cold means a new ace index; the synthetic files were just written and may be in the OS cache. Peak RSS covers the whole process, including the worker and fixture creation, and is cumulative within each script.

Run from the repository root:

```sh
bunx --package node@24 node packages/history-import/bench/scan.ts
bunx --package node@24 node packages/history-import/bench/native-stores.ts
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

Both warm scans opened zero unchanged content readers and sampled zero JSONL bytes. Legacy storage still stats its message and part paths, so its warm index cost depends on that inventory. Live SQLite snapshots copy the database and WAL before querying to preserve source shared-memory bytes. The scan byte counter measures sampled JSONL windows, not SQLite page reads or snapshot copying.

Bounds enforced by the implementation include 16 concurrent file samples, 128 KiB of samples per file, 1 MiB per decoded record, 64 KiB blob chunks, 16 packets per external pull, 512 agents, 32 path components, 100,000 inventory entries, 200 items or 1 MiB per item page, and 256 KiB per blob read. Legacy message sorting uses a private SQLite file rather than an in-memory transcript array. Small part inventories sort at most 16 paths before spilling to disk. SQLite scalar records above the decoder limit are refused before loading them.
