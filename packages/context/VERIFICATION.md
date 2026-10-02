# Context verification

The repo owner's general rule reserves tests for merge. The review revision received static checks only; its behavior tests, mutations, benchmarks and probes were **not executed (tests run at merge)**. A later, file-specific exception authorized the watcher follow-up below. Other runtime correctness and performance claims still need run at merge. No CI, provider prompts or recorder sessions are requested or run.

`bun run fmt`, `bun run lint`, `bun run check:size` and `bun run typecheck` pass. After the latest main merge, the size check covers 594 source files, all below 1,500 lines.

Main at `19a7e14` was merged without rebasing in `1430295`; the branch then merged `5494e21`, including automations and process-test reliability. Conflict resolution preserves context, model-catalog and orchestration requests, both daemon-owned service lifetimes, and main's canonical `spawnRawSupervised` owner with its output limit. Context reuses that owner rather than retaining a duplicate raw-stream implementation. Its four real-process package suites and two socket suites join main's process-test manifest, without changing assertions or per-test deadlines. All work stays in the context worktree. The temporary baseline archive was removed.

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

The attempted full PR gate failed with timeout-only assertions outside context and a terminated Git worker. The baseline full gate also failed and had terminated workers; neither is a successful gate. A targeted baseline checkpoint restore passed, so it does not prove the full Git checkpoint/nested failures are load-only. Those cases and the final full suite **need run at merge**. The final revision has no claim of an unmodified `bun run check` pass, and execution under the owner's new rule is limited to the explicit exceptions recorded below.

## Integration rehearsal I7

`deliverContext(service, command, capabilities, consume)` is the context-owned intent-worker interface. It validates the command, resolves thread-owned references, supplies original input/delivery plus native projection, returns typed diagnostics and releases in `finally`. The consumer promise settles after bytes are consumed or consumption has stopped on cancellation/failure. Initial thread creation can use `compose` after engine-assigned thread creation with the same lifetime contract.

PR #15 is still open and its engine launcher is absent from main at `4701bfa`. Claude adapter PR #18 has landed, but `SessionContext` still has no native context submission hook. Its session-launcher must call this interface around native provider submission and call `releaseThread` on durable thread deletion. Accounts, MCP leases, plugins, model resolution and default adapter registration belong to their respective owners. Full I7 end-to-end session launch remains pending that integration and **needs run at merge**. Core state precedence is unchanged.

## Merge-time watcher follow-up

The orchestrator reported an empty retry queue where the watcher-error test expected its first 100 ms timer. The unchanged `workspace-review.test.ts` reproduced that assertion failure under the owner's file-specific exception. The drain could inspect an empty queue, then receive an event before its promise chain cleared `running`. That event remained pending without a new drain.

Empty drains now return immediately. The settling drain hands pending work to a new drain while preserving backoff, and a fired retry waits for the previous drain to settle. Retry tests wait for the injected scheduler to register work rather than using `setImmediate`. A new public behavior test queues a notification as the replacement watcher starts and waits for the real Git update to publish before asserting completion.

`bunx vitest run packages/context/src/workspace-review.test.ts` passes all **8 tests**. No other test file, full suite, mutation run, benchmark or probe was executed for this follow-up. The new guard is designed to reject omission of the final drain handoff; that mutation is **not executed (tests run at merge)**. The existing retry mutation target follows the updated callback, without executing its runner.

## Main merge validation

Merged `origin/main` at `fe670b0`. The two conflicts are resolved by union: NOTICE keeps image-size and node-api-headers, and each socket keeps `contextBusy`, `hasPresence` and `cleaned`. Comparing server.ts against main leaves only the additive context option, imports, busy flag and request handler. All main services and delivery lifecycle behavior remain. Dependencies were installed with `bun install --ignore-scripts`.

Workspace PR #26 is now merged. The narrow `WorkspaceFiles` implementation remains for this merge: context requires raw bounded byte prefixes for binary/UTF-8 diagnostics and an incrementally published fuzzy index, while `@ace/workspace.read` returns decoded text or a binary flag and its watcher owns an asynchronous disposal contract. Adapting those contracts safely needs a separate migration rather than a merge-resolution change. Git and canonical roots remain required; every symlink is refused. Remote authorization already uses the merged daemon device scopes via `allows`.

Under the owner's merge-conflict exception, the following files passed: daemon `server.test.ts`, `context.server.test.ts`, `context.remote.test.ts`, `models.server.test.ts`, `remote.server.test.ts`, `delivery-runtime.test.ts`, `notification-shutdown.test.ts`, `presence-pressure.test.ts`, and context `workspace-review.test.ts`. Total: **9 files, 55 tests**. These cover local/remote context access, model requests, server commands/subscriptions, injected identities/time, admission during pending presence removal, shutdown acknowledgement and watcher recovery.

Formatting, lint, typecheck and size checks pass. No full suite, CI, benchmark, mutation runner, provider prompt or recorder was run. Full integration and final performance measurements still **need run at merge**.

Payload audit PR #54 landed during delivery. Main at `4701bfa` was merged without conflicts, preserving its payload/window fixes and context store option. Static checks were repeated; no additional tests were run for this conflict-free follow-up. The focused results above are from the `fe670b0` merge.
