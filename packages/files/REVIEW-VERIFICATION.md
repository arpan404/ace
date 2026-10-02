# File service verification

Tests use real files, real WebSockets and pinned remote WSS. The 200 MiB download and archive memory assertions sample isolated daemon-side Node processes. Tests synchronize through credits, replies, close events and injected retention clocks. No provider prompts, recorder sessions or GitHub CI runs were used.

## Verification policy

The repo owner now permits only static checks before merge. Current-head behavior tests, mutation checks, benchmarks and runtime probes need run at merge. Earlier executions predated this policy and do not verify the current head. No further runtime checks were executed after the rule arrived. Delivery static checks passed: `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. The final merge includes main through the model catalog commit `19a7e14`.

## Mutation cases

The public behavior tests are designed to kill these production mutations. This checklist records coverage intent; execution belongs to merge time.

| Mutation               | Behavior the test guards                                         | Current-head execution            |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------- |
| version-check          | an agent edit returns a conflict                                 | not executed (tests run at merge) |
| resume-validator       | a changed file cannot resume                                     | not executed (tests run at merge) |
| sha-trailer            | a resumed transfer has the expected SHA-256                      | not executed (tests run at merge) |
| uncredited-send        | no bytes arrive before a credit                                  | not executed (tests run at merge) |
| upload-offset          | the public upload service rejects a physical offset mismatch     | not executed (tests run at merge) |
| upload-checksum        | a mismatched hash leaves the destination unchanged               | not executed (tests run at merge) |
| early-visibility       | the destination is absent until atomic commit                    | not executed (tests run at merge) |
| trash-move             | deletion moves bytes into restorable trash                       | not executed (tests run at merge) |
| scope-check            | a read-only device cannot mutate                                 | not executed (tests run at merge) |
| gitignore              | the archive excludes gitignored content                          | not executed (tests run at merge) |
| mutation-events        | a second device receives successful mutation events              | not executed (tests run at merge) |
| nested-version         | nested edits invalidate directory deletion and movement          | not executed (tests run at merge) |
| relay-binary-kind      | encrypted relay frames deliver exact binary bytes                | not executed (tests run at merge) |
| relay-send-cap         | oversized binary sends reject while the channel remains usable   | not executed (tests run at merge) |
| relay-receive-cap      | oversized authenticated binary messages reject                   | not executed (tests run at merge) |
| relay-fragment-kind    | mixed JSON and binary fragments reject                           | not executed (tests run at merge) |
| shared-upload-offset   | a blob writer never receives an invalid offset                   | not executed (tests run at merge) |
| archive-error-latch    | closing an errored archive preserves the original typed conflict | not executed (tests run at merge) |
| binary-magic           | high-bit aliases of the ACEF bytes reject before uploads write   | not executed (tests run at merge) |
| public-chunk-ownership | retained public download bytes remain stable after another read  | not executed (tests run at merge) |

## Historical transfer benchmark

These measurements were collected before the no-tests rule on 2026-10-02. Current-head benchmarks need run at merge. The historical run used Node 26.8.1 and Bun 1.4.0 on a shared machine. Each mode uses a fresh isolated server process. The 200 MiB local binary repeats a random 64 KiB block, larger than gzip's dictionary window. Archives include that binary and a 32 MiB sparse file. The slow receiver grants one 64 KiB credit every 31.25 ms, simulating a 2 MiB/s ceiling. Uploads sync each 64 KiB frame and hash before commit.

| Mode            | Input   | Throughput                        | Peak RSS            | RSS growth |
| --------------- | ------- | --------------------------------- | ------------------- | ---------- |
| Local download  | 200 MiB | 11.02 MiB/s, 176 frames/s         | 140.38 MiB daemon   | 29.09 MiB  |
| Slow receiver   | 32 MiB  | 1.78 MiB/s, 28.4 frames/s         | 114.33 MiB daemon   | 8.14 MiB   |
| Archive         | 232 MiB | 5.37 MiB/s input, 4.63 MiB/s wire | 148.03 MiB daemon   | 25.88 MiB  |
| Durable upload  | 32 MiB  | 2.99 MiB/s, 47.8 frames/s         | 125.27 MiB daemon   | 18.97 MiB  |
| Encrypted relay | 32 MiB  | 2.28 MiB/s, 36.4 frames/s         | 174.50 MiB combined | 52.88 MiB  |

Relay RSS covers the host, client and relay in one process, unlike the isolated daemon measurements. Its peak reader queue was 202 bytes and peak forwarding buffer was zero. RSS growth is the ending resident set minus the starting resident set; peak RSS is recorded separately.

These are informational measurements, not gating speed thresholds. Shared-machine load varied substantially: earlier local random-file runs measured 103–297 MiB/s and encrypted relay runs measured 56 MiB/s. These measurements predate the final git-test synchronization fix and the current verification policy; concurrent work on the machine makes a single speed comparison inappropriate. Reusing one read buffer and one binary envelope per channel cuts allocation pressure; the public generator preserves retained chunks while transports opt into borrowed bytes. File reads, compression and socket writes remain bounded by their chunk and stream windows. Archives reuse an input buffer and pause after individual gzip output events, avoiding concatenation copies. Download work is proportional to transferred bytes. Resume does not rescan the retained prefix. Metadata fingerprinting and archive planning visit the bounded selected tree, outside the delta hot path.
