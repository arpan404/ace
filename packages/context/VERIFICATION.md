# Context verification

The repo owner's latest instruction supersedes earlier test and gate requirements. This final revision receives static checks only. Behavior tests, mutations, benchmarks and probes are **not executed (tests run at merge)** for the final revision. Runtime correctness and performance claims need run at merge. No CI, provider prompts or recorder sessions are requested or run.

`bun run fmt`, `bun run lint`, `bun run check:size` and `bun run typecheck` pass. The size check covers 378 source files, all below 1,500 lines.

Main at `19a7e14` was merged without rebasing in `1430295`. Conflict resolution preserves context, model-catalog and orchestration requests, both daemon-owned service lifetimes, and provider-kit's raw-stream extension with main's output limit. All work stays in the context worktree. The temporary baseline archive was removed.

## Review changes and behavior coverage

- A transient `.gitignore` update failure recovers without another filesystem event. Real Git supplies the index, the test closes the failed notification source, and an injected scheduler advances one retry before public completion excludes `secret.txt`.
- Watcher errors schedule one timer with increasing delays. New notifications preserve backoff, published completion stays usable, and close cancels the timer. Recovery replaces the index and watcher; eviction and close prevent an in-flight rebuild from re-arming a disposed entry.
- Invalid `AB==` and `AAB=` projection bytes fail for Claude and ACP, while canonical counterparts preserve bytes.
- Reserved VP8L version bits reject upload retention, while a valid lossless frame commits.
- An accepted `thread.send` preserves prompt, delivery mode and native context through an owned Node CLI sink. GC retains a local image while consumption waits and collects it after acknowledgement.
- A denied command never reaches the consumer. Consumer cancellation releases its lease before later collection.
- Cancelling an incomplete NUL-delimited Git frame reports cancellation and reaps the process instead of reporting malformed output.

Every runtime result above **needs run at merge**. Tests use public package APIs, real repositories/files/SQLite/processes and injected scheduling or event barriers. No synchronization sleeps or wall-clock performance budgets were added.

## Mutation cases

Each row is **not executed (tests run at merge)** for the final revision. `bench/verify-mutations.ts` records these 19 cases and requires assertion failures, not type errors or timeouts.

| Mutation                                    | Behavior guard                                  |
| ------------------------------------------- | ----------------------------------------------- |
| Accept noncanonical projection padding bits | Invalid-padding projection rejection            |
| Accept VP8L version bits                    | Lossless WebP upload rejection                  |
| Remove autonomous cache retry               | Ignore update recovers without another event    |
| Ignore watcher errors                       | Watcher error recovery and timer cleanup        |
| Bypass backoff during churn                 | New notifications preserve one retry timer      |
| Leak timer after close                      | Cache close cancels scheduled recovery          |
| Mask cancelled partial Git frames           | Cancellation diagnostic and process reaping     |
| Make warm hits await watcher drain          | Published completion during unfinished update   |
| Omit delivered message context              | Native context reaches owned CLI                |
| Release before consumption                  | Image survives concurrent release and GC        |
| Omit consumer failure release               | Cancelled consumer permits collection           |
| GC ignores leases                           | Delayed consumer's image stays retained         |
| Suppress lease release                      | Explicit consumption release permits collection |
| Remove lease admission cap                  | Bounded admission and reuse after release       |
| Omit preparation failure cleanup            | Failed preparation releases acquired leases     |
| Release caller-mutated hashes               | Descriptor edits cannot redirect release        |
| Accept mismatching WebP frames              | Frame dimensions agree with validated canvas    |
| Omit subtree ignore filtering               | Ignored descendants leave completion            |
| Omit subtree deletion filtering             | Deleted descendants leave completion            |

The existing 28-case review inventory also remains, including the original surviving chunk-fsync, premature-PNG-inflation and omitted-WebP-validation cases and socket-overlap rejection. Its guards cover durable acknowledged offsets, dimension-error precedence, conflicting/missing frames and a pong ordering barrier. All existing inventories need run at merge on the final revision.

## Performance design and measurements

Warm completion never awaits update or retry work. Each LRU entry owns at most one retry timer and 4096 pending paths. Recovery delays start at 100 ms and cap at 5 s. Churn does not bypass backoff. Filename validation reuses one immutable schema. Subtree updates visit descendants; a failure rebuild is proportional to the capped index rather than notification history.

Uploads stream bounded chunks and hashes. Native delivery does work proportional to its message context, pins at most 64 references in one batch, and releases after consumption. Existing admission caps active leases at 128. Projection remains pure; the delivery function is an I/O shell around preparation and an injected consumer. No provider-specific document/resource content is flattened into canonical ContentPart.

Historical measurements below came from the first review-fix round before the owner changed execution policy. They are not measurements of this final revision.

| Operation                                                  | Earlier measured value |
| ---------------------------------------------------------- | ---------------------: |
| Real repository size                                       |           50,000 files |
| Cold index                                                 |               807.2 ms |
| Completion median / p95                                    |     3571.5 / 9724.1 us |
| Cached completion during held watcher update, median / p95 |    3432.9 / 26546.0 us |
| Durable direct upload                                      |             7.35 MiB/s |
| Loopback WebSocket upload                                  |             5.27 MiB/s |
| Projection, 64 parts                                       |               28.99 us |
| Projection, 4 MiB document                                 |             10595.2 us |
| Acquire/release one lease                                  |               31.87 us |
| Peak RSS, index / daemon upload                            |    292.11 / 198.13 MiB |

The final 50,000-file benchmark adds recovery-rebuild cost. `bench/delivery.ts` adds 64-reference native delivery latency, throughput and peak RSS. Both **need run at merge**. No completed measurements are claimed for these additions. Before the policy change, an attempted recovery benchmark failed with `Incomplete Git listing`; the shell now preserves interruption diagnostics for partial frames. Whether load or interruption caused that attempt needs run at merge.

## Earlier load diagnostics

Before the owner prohibited execution, isolated `origin/main` with its own dependencies reproduced the same core delta, daemon restart/crash, pairing-budget, remote CLI startup, Tailscale status/guidance, notification-spool and MCP shutdown timeouts seen on the PR. Machine load averages exceeded 300. No upstream assertion or deadline was changed.

The attempted full PR gate failed with timeout-only assertions outside context and a terminated Git worker. The baseline full gate also failed and had terminated workers; neither is a successful gate. A targeted baseline checkpoint restore passed, so it does not prove the full Git checkpoint/nested failures are load-only. Those cases and the final full suite **need run at merge**. The final revision has no claim of an unmodified `bun run check` pass, and no execution follows the owner's new rule.

## Integration rehearsal I7

`deliverContext(service, command, capabilities, consume)` is the context-owned intent-worker interface. It validates the command, resolves thread-owned references, supplies original input/delivery plus native projection, returns typed diagnostics and releases in `finally`. The consumer promise settles after bytes are consumed or consumption has stopped on cancellation/failure. Initial thread creation can use `compose` after engine-assigned thread creation with the same lifetime contract.

PR #15 is still open and the engine/adapters are absent from main at `19a7e14`. Its session-launcher must call this interface around native provider submission and call `releaseThread` on durable thread deletion. Accounts, MCP leases, plugins, model resolution and default adapter registration belong to their respective owners. Full I7 end-to-end session launch remains pending that integration and **needs run at merge**. Core state precedence is unchanged.
