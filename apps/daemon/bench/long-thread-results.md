# Long-thread benchmark results

Measured on 2026-10-03 with Node v26.8.1, macOS arm64. These are local SQLite `Store` API measurements after closing and reopening the database. No provider CLI or repository test suite ran.

The final fixture contains 1,000,000 main-thread items and 48 child-thread messages, 2,000 root turns, 2,000 approvals and 48 linked child threads over five simulated days. It was streamed through the canonical `Store.appendEvents` API with the final writer schema, producing 1,020,531 canonical events. Seed time was 643.39 seconds; database size was 6,556,184,576 bytes.

```sh
node --expose-gc apps/daemon/bench/long-thread.ts --phase=seed-only --database=/tmp/ace-long-thread-final.sqlite
node --expose-gc apps/daemon/bench/long-thread.ts --phase=read --database=/tmp/ace-long-thread-final.sqlite
```

Each query measurement contains 100 samples. Turn pages contain up to 50 entries, searches up to 30 results and item windows up to 101 items. The first call appears separately because the remaining samples reuse the reopened connection.

| API and workload           | First call, ms | Median, ms | p95, ms | Maximum, ms |
| -------------------------- | -------------: | ---------: | ------: | ----------: |
| `turns.page`               |          17.61 |       9.69 |   14.03 |       18.23 |
| `thread.search.common`     |          24.51 |       8.53 |   12.11 |       24.51 |
| `thread.search.blob`       |          67.25 |      21.36 |   22.18 |       67.25 |
| `thread.search.toolOutput` | 9.07 | 3.25 | 3.49 | 9.07 |
| `thread.search.tree`       |          32.56 |       7.26 |    7.72 |       32.56 |
| `thread.catchUp.recent`    |          20.59 |       1.12 |    1.44 |       20.59 |
| `thread.catchUp.all`       |          11.54 |       1.19 |    1.48 |       11.54 |
| `items.window`             |          20.94 |       7.69 |    9.55 |       20.94 |

All measured pages met the requested targets of 50 ms for turns and catch-up, and 150 ms for search. Catch-up workloads cover the latest 25 turns and all 2,000 root turns.

The coverage read reported `ready: true`, zero pending documents and an indexed sequence equal to host head 1,020,531. Blob-only search and full tool-output search each found the selected checkpoint; tree search found all 48 child reports. Catch-up counted 18,000 commands, 181 failed commands, 20,000 file-edit calls, 2,000 approvals asked and answered, 666 explicit auto-reviews, 48 subagents started and finished, 2,000,000 input tokens, 800,000 output tokens and 6,181 errors. It returned 64 file and 64 command previews with `truncated: true`, while counters remained exact. The first file preview had 200 added and 100 removed lines. Initiating and latest agent-message previews identified the expected checkpoints.

Seed memory stayed near 193 to 200 MiB RSS from 100,000 through 1,000,000 items, with temporary garbage-collection spikes. Seed peak RSS was 283.48 MiB and final heap was 35.69 MiB. Batches retained at most 128 records or approximately 512 KiB plus the current record. The iterator retained no transcript array.

The query process reopened at 129.02 MiB RSS and 25.12 MiB heap. After all 800 query samples and coverage reads, forced GC left 29.28 MiB heap. RSS was 322.89 MiB, including native SQLite and runtime allocations; query peak RSS was 323.00 MiB. This measurement documents retained memory at one million items rather than inferring an unlimited-history bound from latency alone.

Search results follow chronological chunk-indexing order. Late appends may update an item's existing tail below the cursor ceiling. Disjoint common multi-term queries can scan many postings even though response and candidate buffers remain bounded. The measured fixture meets the targets; these measurements do not establish a latency guarantee for arbitrary queries or thread families.

Behavior tests and their listed mutation cases were written but not executed. They need run at merge.
