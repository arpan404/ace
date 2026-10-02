# File service verification

Tests use real files, real WebSockets and pinned remote WSS. The 200 MiB download and archive memory assertions sample isolated daemon-side Node processes. Tests synchronize through credits, replies, close events and injected retention clocks. No provider prompts, recorder sessions or GitHub CI runs were used.

## Applied mutations

Each production mutation was applied individually. The focused public-behavior test failed, its JSON report confirmed a failed assertion rather than a timeout, and the file was restored in `finally`. All eighteen were killed after the relay integration and archive buffer rewrite. The final check also removed the archive error latch and confirmed that the public conflict test failed with an incorrect abort error. The original twelve checks were repeated, including direct public-service offset validation in addition to the transport guard.

| Mutation             | Failing behavior                                                 |
| -------------------- | ---------------------------------------------------------------- |
| version-check        | an agent edit returns a conflict                                 |
| resume-validator     | a changed file cannot resume                                     |
| sha-trailer          | a resumed transfer has the expected SHA-256                      |
| uncredited-send      | no bytes arrive before a credit                                  |
| upload-offset        | the public upload service rejects a physical offset mismatch     |
| upload-checksum      | a mismatched hash leaves the destination unchanged               |
| early-visibility     | the destination is absent until atomic commit                    |
| trash-move           | deletion moves bytes into restorable trash                       |
| scope-check          | a read-only device cannot mutate                                 |
| gitignore            | the archive excludes gitignored content                          |
| mutation-events      | a second device receives successful mutation events              |
| nested-version       | nested edits invalidate directory deletion and movement          |
| relay-binary-kind    | encrypted relay frames deliver exact binary bytes                |
| relay-send-cap       | oversized binary sends reject while the channel remains usable   |
| relay-receive-cap    | oversized authenticated binary messages reject                   |
| relay-fragment-kind  | mixed JSON and binary fragments reject                           |
| shared-upload-offset | a blob writer never receives an invalid offset                   |
| archive-error-latch  | closing an errored archive preserves the original typed conflict |

Commands used `bun run test -- <behavior-test-file> -t <behavior> --reporter=json --outputFile=<temporary-report>`. Temporary runners and reports were removed after recording these results. The clean full gate runs after restoration.

## Transfer benchmark

Run on 2026-10-02 using Node 26.8.1 and Bun 1.4.0 on a shared machine. Each mode uses a fresh isolated server process. The 200 MiB local binary repeats a random 64 KiB block, larger than gzip's dictionary window. Archives include that binary and a 32 MiB sparse file. The slow receiver grants one 64 KiB credit every 31.25 ms, simulating a 2 MiB/s ceiling. Uploads sync each 64 KiB frame and hash before commit.

| Mode            | Input   | Throughput                          | Peak RSS            | RSS growth |
| --------------- | ------- | ----------------------------------- | ------------------- | ---------- |
| Local download  | 200 MiB | 45.59 MiB/s, 729 frames/s           | 121.27 MiB daemon   | 10.45 MiB  |
| Slow receiver   | 32 MiB  | 1.77 MiB/s, 28.4 frames/s           | 117.16 MiB daemon   | 8.16 MiB   |
| Archive         | 232 MiB | 16.01 MiB/s input, 13.81 MiB/s wire | 126.58 MiB daemon   | 21.22 MiB  |
| Durable upload  | 32 MiB  | 2.23 MiB/s, 35.6 frames/s           | 122.91 MiB daemon   | 14.98 MiB  |
| Encrypted relay | 32 MiB  | 5.38 MiB/s, 86.1 frames/s           | 180.83 MiB combined | 50.63 MiB  |

Relay RSS covers the host, client and relay in one process, unlike the isolated daemon measurements. Its peak reader queue was 202 bytes and peak forwarding buffer was zero. RSS growth is the ending resident set minus the starting resident set; peak RSS is recorded separately.

These are informational measurements, not gating speed thresholds. Shared-machine load varied substantially: earlier local random-file runs measured 103–297 MiB/s and encrypted relay runs measured 56 MiB/s. These final measurements use the final production code; concurrent work on the machine makes a single speed comparison inappropriate. Reusing one binary envelope per channel cut allocation pressure; file reads, compression and socket writes remain bounded by their chunk and stream windows. Archives reuse an input buffer and pause after individual gzip output events, avoiding concatenation copies. Download work is proportional to transferred bytes. Resume does not rescan the retained prefix. Metadata fingerprinting and archive planning visit the bounded selected tree, outside the delta hot path.
