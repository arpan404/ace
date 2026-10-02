# File service verification

Tests use real files, real WebSockets and pinned remote WSS. The 200 MiB download and archive memory assertions sample isolated daemon-side Node processes. Tests synchronize through credits, replies, close events and injected retention clocks. No provider prompts, recorder sessions or GitHub CI runs were used.

## Verification policy

The repo owner now permits only static checks before merge. Current-head behavior tests, mutation checks, benchmarks and runtime probes need run at merge. Earlier executions predated this policy and do not verify the current head. No further runtime checks were executed after the rule arrived. Delivery static checks passed: `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. The final merge includes main through `4c2d6fb`, including reviewed workspace, diagnostics and shared audit fixes.

## Mutation cases

The public behavior tests are designed to kill these production mutations. This checklist records coverage intent; execution belongs to merge time.

| Mutation               | Behavior the test guards                                                     | Current-head execution            |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| version-check          | an agent edit returns a conflict                                             | not executed (tests run at merge) |
| resume-validator       | a changed file cannot resume                                                 | not executed (tests run at merge) |
| sha-trailer            | a resumed transfer has the expected SHA-256                                  | not executed (tests run at merge) |
| uncredited-send        | no bytes arrive before a credit                                              | not executed (tests run at merge) |
| upload-offset          | the public upload service rejects a physical offset mismatch                 | not executed (tests run at merge) |
| upload-checksum        | a mismatched hash leaves the destination unchanged                           | not executed (tests run at merge) |
| early-visibility       | the destination is absent until atomic commit                                | not executed (tests run at merge) |
| trash-move             | deletion moves bytes into restorable trash                                   | not executed (tests run at merge) |
| scope-check            | a read-only device cannot mutate                                             | not executed (tests run at merge) |
| gitignore              | the archive excludes gitignored content                                      | not executed (tests run at merge) |
| mutation-events        | a second device receives successful mutation events                          | not executed (tests run at merge) |
| nested-version         | nested edits invalidate directory deletion and movement                      | not executed (tests run at merge) |
| relay-binary-kind      | encrypted relay frames deliver exact binary bytes                            | not executed (tests run at merge) |
| relay-send-cap         | oversized binary sends reject while the channel remains usable               | not executed (tests run at merge) |
| relay-receive-cap      | oversized authenticated binary messages reject                               | not executed (tests run at merge) |
| relay-fragment-kind    | mixed JSON and binary fragments reject                                       | not executed (tests run at merge) |
| shared-upload-offset   | a blob writer never receives an invalid offset                               | not executed (tests run at merge) |
| archive-error-latch    | closing an errored archive preserves the original typed conflict             | not executed (tests run at merge) |
| binary-magic           | high-bit aliases of the ACEF bytes reject before uploads write               | not executed (tests run at merge) |
| public-chunk-ownership | retained public download bytes remain stable after another read              | not executed (tests run at merge) |
| transfer-cap/release   | four cross-device transfers fill capacity; completion permits the fifth      | not executed (tests run at merge) |
| no-replace-commit      | an agent-created destination survives a barrier-controlled commit            | not executed (tests run at merge) |
| cancel-guard           | a cancelled queued workspace/destination write never changes bytes           | not executed (tests run at merge) |
| cancel-drain           | capacity and cancel reply wait for started writes; no late acknowledgement   | not executed (tests run at merge) |
| resolved-temp-privacy  | symlink aliases cannot read private upload bytes                             | not executed (tests run at merge) |
| cleanup-debt           | outside or unknown temps remain charged against quota                        | not executed (tests run at merge) |
| cleanup-identity       | cleanup preserves a replacement inode                                        | not executed (tests run at merge) |
| cleanup-relocation     | a moved original temp is removed before quota is refunded                    | not executed (tests run at merge) |
| trash-discovery        | lost delete replies remain recoverable after reconnect/restart               | not executed (tests run at merge) |
| trash-page             | pagination returns every live entry exactly once and omits expired entries   | not executed (tests run at merge) |
| daemon-file-event      | affected workspace threads receive canonical durable file changes            | not executed (tests run at merge) |
| daemon-producers       | startup support, output ranges and full raw blobs are downloadable           | not executed (tests run at merge) |
| read-artifact-scope    | paired read-only tokens export both output and raw artifacts                 | not executed (tests run at merge) |
| production-relay       | normal daemon startup hosts scoped files; admin tokens and revocation reject | not executed (tests run at merge) |
| injected-spawner       | injected real process and worker results control workspace search            | not executed (tests run at merge) |
| blob-identity          | changed raw blob bytes fail SHA validation                                   | not executed (tests run at merge) |
| pax-large-size         | real tar consumes a complete archive with a 9 GiB declared file              | not executed (tests run at merge) |

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

## Review regression evidence

All review items have corresponding code changes and authored public behavior assertions. The point-by-point map is in [REVIEW-FIXES.md](./REVIEW-FIXES.md). This is static evidence, not an observed failing/passing run or a confirmed mutation kill. No test, mutation, benchmark, flakiness run, probe or GitHub CI was executed for these fixes. New `bench:artifacts` and daemon `bench:files` report throughput/ops and peak RSS when executed at merge. Their numbers, native interoperability and current-head memory bounds need run at merge.

The final main merge retains the workspace owner's descriptor-based reads, streaming search and runtime injection. Its native descriptor bridge is built by the normal install lifecycle at merge. Installation here used `--ignore-scripts`; native build and interoperability need run at merge. The daemon now reuses diagnostics `writeSupportBundle` for `artifact.support`, with redaction, no thread transcripts/provider probes, bounded input/staging, and reserved export space. The support-bundle socket/redaction regression is not executed (tests run at merge).
