# File service verification

Tests use real files, real WebSockets and pinned remote WSS. The 200 MiB download and archive memory assertions sample isolated daemon-side Node processes. Tests synchronize through credits, replies, close events and injected retention clocks. No provider prompts, recorder sessions or GitHub CI runs were used.

## Applied mutations

Each production mutation was applied individually. The focused public-behavior test failed, its JSON report confirmed a failed assertion rather than a timeout, and the file was restored in `finally`. All twelve were killed.

| Mutation         | Failing behavior                      |
| ---------------- | ------------------------------------- |
| version-check    | rejects an agent edit conflict        |
| resume-validator | resumes after disconnect byte-exactly |
| sha-trailer      | resumes after disconnect byte-exactly |
| uncredited-send  | waits for each credit                 |
| upload-offset    | rejects upload checksum, offset       |
| upload-checksum  | rejects upload checksum, offset       |
| early-visibility | resumes uploads across daemon restart |
| trash-move       | deletes into durable trash            |
| scope-check      | allows a read-only device             |
| gitignore        | streams a folder archive              |
| mutation-events  | rejects an agent edit conflict        |
| nested-version   | detects a nested agent edit           |

Commands used `bun run test -- packages/files/src/<file>.test.ts -t <behavior> --reporter=json --outputFile=<temporary-report>`. Temporary runners and reports were removed after recording these results. The clean full gate runs after restoration.

## Transfer benchmark

Run on 2026-10-02 using Node 26.8.1 and Bun 1.4.0 on a shared machine. Each mode uses a fresh isolated server process. The 200 MiB local binary repeats a random 64 KiB block, larger than gzip's dictionary window. Archives include that binary and a 32 MiB sparse file. The slow receiver grants one 64 KiB credit every 31.25 ms, simulating a 2 MiB/s ceiling. Uploads sync each 64 KiB frame and hash before commit.

| Mode           | Input   | Throughput                          | Peak daemon RSS | RSS growth |
| -------------- | ------- | ----------------------------------- | --------------- | ---------- |
| Local download | 200 MiB | 102.85 MiB/s, 1,646 frames/s        | 154.44 MiB      | 48.52 MiB  |
| Slow receiver  | 32 MiB  | 1.89 MiB/s, 30.3 frames/s           | 116.61 MiB      | 11.58 MiB  |
| Archive        | 232 MiB | 66.40 MiB/s input, 57.27 MiB/s wire | 164.36 MiB      | 58.84 MiB  |
| Durable upload | 32 MiB  | 9.02 MiB/s, 144.4 frames/s          | 123.75 MiB      | 15.16 MiB  |

These are informational measurements, not gating speed thresholds. Earlier sparse-file local runs measured 176–340 MiB/s; the revised random dataset and shared-machine load make a single speed comparison inappropriate. Reusing one binary envelope per channel cut allocation pressure; file reads, compression and socket writes remain bounded by their chunk and stream windows. Download work is proportional to transferred bytes. Resume does not rescan the retained prefix. Metadata fingerprinting and archive planning visit the bounded selected tree, outside the delta hot path.
