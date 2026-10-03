# Daemon performance and memory

Measured on this Mac, Darwin arm64, with real daemon services, real SQLite and WebSocket delivery. Providers are in-process scripts and receive no native CLI prompts. The empty home excludes real provider history and process RSS. These are individual observations on a shared machine, with observer overhead. They are not statistical latency guarantees.

The matched comparison is source `origin/main` at `c270841c`, including #82 and #83, against the production bundle at `93823697`. Both use Node 26.8.1, 60 seconds idle, 16 active scripted sessions, 1,000 deltas and a three-minute soak with fresh thread identities. Raw data is in [deck-main-baseline.json.gz](deck-main-baseline.json.gz) and [watch-pool-after.json.gz](watch-pool-after.json.gz). Benchmark-only changes after that build improve collection, labels, deadlines and gate reporting.

| Metric                                    |                                   Main before | Compiled daemon after |
| ----------------------------------------- | --------------------------------------------: | --------------------: |
| Endpoint publication                      |                                    1146.83 ms |             927.83 ms |
| Idle at 10 s RSS                          |                                    524.36 MiB |            218.64 MiB |
| Idle at 10 s main heap                    |                                    108.71 MiB |             44.67 MiB |
| Idle at 10 s main external                |                                     15.91 MiB |              7.57 MiB |
| Idle at 10 s OS threads                   |                                         20.00 |                 14.00 |
| Idle at 10 s recent worker telemetry      |                                          6.00 |                  1.00 |
| Idle at 10 s worker heaps, MiB            | 14.50 / 22.43 / 32.46 / 24.26 / 23.09 / 23.42 |                  8.70 |
| Idle at 60 s RSS                          |                                    526.31 MiB |            197.31 MiB |
| Idle at 60 s main heap                    |                                    110.51 MiB |             46.10 MiB |
| Idle at 60 s main external                |                                     15.91 MiB |              7.57 MiB |
| Idle at 60 s OS threads                   |                                         20.00 |                 15.00 |
| Idle at 60 s recent worker telemetry      |                                          6.00 |                  2.00 |
| Idle at 60 s worker heaps, MiB            | 13.99 / 22.85 / 32.88 / 24.68 / 23.61 / 24.56 |           9.83 / 6.37 |
| RSS with 16 active scripted sessions      |                                    542.45 MiB |            252.34 MiB |
| Active OS threads                         |                                         21.00 |                 15.00 |
| WebSocket ingest                          |                               932.76 events/s |      1019.20 events/s |
| WebSocket p99                             |                                       3.47 ms |               2.61 ms |
| Observed idle CPU                         |                             0.83% of one core |     0.43% of one core |
| Shutdown                                  |                                     202.68 ms |             156.63 ms |
| Three-minute retained main heap change    |                                     -1.29 MiB |             -1.57 MiB |
| Three-minute retained RSS change, main GC |                                    181.73 MiB |             59.36 MiB |
| Three-minute peak RSS                     |                                    804.50 MiB |            370.17 MiB |

Main GC collects only the main isolate in the matched comparison. Worker GC and allocator pages still affect RSS. A recent telemetry file can remain visible for 1.5 seconds after retirement, so the worker rows count recently observed isolates. OS thread counts are independent. Idle CPU includes the half-second telemetry writer.

The before soak closed 5,840 fresh sessions and the after soak closed 6,112. Main heaps were already bounded before these changes; RSS exposed the native growth. Before, malloc allocated bytes grew from 52.9 to 238.5 MiB. After, they grew from 20.0 to 45.5 MiB, with allocation counts 41,047 to 53,121 rather than 85,753 to 1,548,291. The histories remain on disk throughout both runs.

The longer [long-after.json.gz](long-after.json.gz) run warms 1,024 fresh threads and then closes another 6,848 in five minutes. It collects every live isolate at both boundaries. Retained RSS changes from 246.23 to 238.84 MiB and main heap from 40.72 to 41.57 MiB. The mean RSS in the final quarter is 16.34 MiB below the preceding quarter. Worker heaps return to about 9 MiB each near the end. This supports bounded memory for this scripted workload, including fresh cache identities; it does not measure native provider processes.

The pinned release runtime, Node 24.13.0, is measured separately in [release-node24.json.gz](release-node24.json.gz). It records startup 1,091.12 ms; idle 10/60 s RSS 224.56/196.63 MiB, main heap 53.50/55.30 MiB and external 3.76/3.76 MiB; OS threads 14/15; recent worker heaps 8.52 and 9.93/5.74 MiB; 16-session RSS 259.91 MiB; 442.10 events/s with p99 23.82 ms; idle CPU 0.62%; shutdown 213.07 ms. Its one-minute fresh-thread soak changes collected RSS by +24.39 MiB and main heap by -1.01 MiB. This run was slower under shared-host load. It provides the lower observed throughput used for the 300 events/s gate, rather than mixing runtime changes into the headline improvement.

## What changed

| Change                                                                                                | Observed benefit or ownership reason                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minify the existing release bundler; include history publication and Claude fork helpers              | The bundle-only stage reduces idle RSS from about 522 to 354 MiB on the original baseline. Release and Electron packaging already use this bundler. All helper URLs now resolve to separately bundled `.mjs` entries. Development retains `.ts`.                                                                                                                                                     |
| Fold logging into its existing asynchronous file sink; import the Claude SDK and Playwright when used | Removes an idle log isolate and avoids loading optional SDKs at daemon startup. Redaction, serialized batches and rotation remain owned by the logger.                                                                                                                                                                                                                                               |
| Shared lazy worker lifecycle with five-second idle retirement                                         | The next measured stage reduces idle RSS to about 215 MiB and startup to 632 ms. Review and model persistence start on first use; history and usage retire after startup work. New work waits for confirmed retirement before reopening. In-memory SQLite owners remain alive.                                                                                                                       |
| Event-triggered usage replay                                                                          | Removes the healthy one-second cursor poll that kept waking a retired usage worker. The retry timer only runs replay after failure.                                                                                                                                                                                                                                                                  |
| SQLite budgets and prepared statements                                                                | Smaller page caches and disabled mmap bound per-connection cache allocation. Store statements have a 256-entry LRU; engine snapshot records have 128-entry and 1 MiB limits. Touched transaction values remain outside eviction until commit. Reuse validators instead of compiling a decoder for every record/frame. Intermediate throughput is too noisy to assign a speedup to this change alone. |
| Shared event encoding and socket byte admission                                                       | Immutable delivery events serialize once per server event object. Subscriber IDs and cursors remain distinct. Every control frame reserves transport bytes before sending, including a peer that sends requests while refusing to read. The existing 64 KiB transfer buffers and Node/ws buffer allocation remain in use.                                                                            |
| Native history change batches                                                                         | With 5,000 synthetic transcripts, an unchanged live scan visits zero files and one append visits one file. Indexed reconciliation affects the changed paths and ancestors. Watch queues cap at 4,096 paths across accounts; uncertain events and rename parents retain authoritative verification.                                                                                                   |
| Shared settings directory watches                                                                     | The long soak isolated the remaining native growth to watch registration churn as thread settings moved through their LRU. Directory watches now share by path and inode/device, cap parents/subscribers, retain peer ownership and replace failed sources. A malloc stack profile attributed the dominant retained allocations to libuv's FSEvents path rebuilding.                                 |
| Provider process release                                                                              | An OpenCode server closes when its last session releases it; a new session waits for confirmed shutdown. Existing Cursor host slots and engine idle/session admission remain the process budget owners.                                                                                                                                                                                              |

Stage measurements live in `baseline.json`, `compiled.json`, `lazy.json`, `sqlite.json`, `soak.json.gz`, `after.json.gz`, `fresh-after.json.gz`, `final.json.gz`, `policy.json.gz` and `native.json.gz`. They preserve cold-start outliers, a slow run under host CPU contention and the fresh-thread RSS growth that the early reused-thread soak missed. Node versions and main revisions changed between stages, so only the matched table above is the headline comparison.

The allocation stack observation matches the watched-path allocation in [libuv's macOS FSEvents implementation](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/fsevents.c). The shared pool is written from ace's watch ownership requirements. The [Node worker documentation](https://nodejs.org/api/worker_threads.html) explains per-isolate heaps and process-wide RSS, and [SQLite's PRAGMA reference](https://sqlite.org/pragma.html) documents cache, mmap, temp-store and checkpoint settings.

## Worker and helper inventory

| Entry / work                                                                         | Lifetime and admission                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnostics-log-worker`                                                             | Default path uses the main-thread async sink; explicitly injected worker transport remains supported. Logger admission is bounded.                                                                                |
| `model-storage-worker`                                                               | First write starts it; retires after five seconds idle. 128 requests, 8 MiB total and 4 MiB/request; one reserved close control.                                                                                  |
| `review-worker`                                                                      | First operation starts it. Live executions, pending RPCs and executor acknowledgements prevent retirement. Existing execution admission stays bounded.                                                            |
| `history-import-worker`                                                              | Startup inventory initializes it, then retires when settled. One write and eight overlapping reads; imports, generators and archive transactions pin it. Native watchers live in the main process.                |
| `usage-worker`                                                                       | Startup recovery or requests start it. 16 requests and 4 MiB queued bytes; retire after replies. Healthy appends wake replay immediately.                                                                         |
| `notification-worker`                                                                | Remains resident to own presence, aggregation, delivery acknowledgements and timers. Its protocol has bounded RPC bytes, execution concurrency and durable job retention.                                         |
| Two `search-query-worker` lanes                                                      | Both lazy and idle-retired. Each admits 16 requests; independent title/transcript lanes preserve responsiveness during ranking.                                                                                   |
| `files-blob-worker`, `files-rename-worker`                                           | Existing lazy workers, one in-flight operation per owner, closed with their owning file service. Blob export uses one 64 KiB read buffer. Separate native jobs preserve no-overwrite and errno ownership.         |
| `workspace-search-worker`                                                            | Existing fallback regex isolation, owned only during a search, terminated on completion/cancellation/deadline.                                                                                                    |
| `history-publish-worker`                                                             | One publication owns it, closes in finally after notification or cancellation.                                                                                                                                    |
| `diagnostics-thread-worker`, `diagnostics-sqlite-process`                            | Existing one-shot diagnostic work; bounded query/output and deadline ownership.                                                                                                                                   |
| `claude-fork-worker`, `cursor-sdk-host`, `acp-mcp-bridge`, `browser-encoder-process` | Separate process helpers, all bundled. Cursor host admission defaults to eight slots and a 256 MiB heap per owned SDK host with shutdown deadlines; other helpers follow their existing operation/session owners. |
| libuv, V8 and FSEvents threads                                                       | Runtime and filesystem threads appear in OS counts without being JavaScript workers. Baseline idle OS threads are 20, after 14 at 10 seconds.                                                                     |

The six baseline JavaScript heaps at 10 seconds are 14.50, 22.43, 32.46, 24.26, 23.09 and 23.42 MiB. At 60 seconds they are 13.99, 22.85, 32.88, 24.68, 23.61 and 24.56 MiB. The after run observes one 8.70 MiB worker at 10 seconds and recent 9.83/6.37 MiB heaps at 60 seconds. Raw telemetry preserves identities. New runs include entry labels.

Review, usage and import workers retain distinct database/protocol owners. The two search lanes retain separate admission. Their shared retirement owner replaces duplicate lifetime code; combining them into one queue would change fairness and auxiliary execution semantics. Similar settings-watch workloads now share one bounded native resource pool.

## SQLite and history

| Owner                     | Cache / mapping / temp / checkpoint                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Event Store               | 2 MiB cache, mmap disabled, FILE temp, WAL checkpoint at 256 pages; existing NORMAL sync |
| Usage                     | 1 MiB, mmap disabled, FILE temp, WAL checkpoint 256; existing NORMAL sync                |
| Notifications and reviews | 512 KiB each, mmap disabled, FILE temp, WAL checkpoint 256; existing sync mode retained  |
| History writer and reader | 1 MiB each, mmap disabled, FILE temp; WAL writer checkpoint 256                          |
| Search readers            | 2 MiB each, reduced from 8 MiB; mmap disabled and FILE temp                              |
| Model persistence         | 512 KiB, mmap disabled, FILE temp; existing DELETE journal startup behavior              |

Model startup reads close their connection. Review/model workers open their databases on demand. Retiring history, usage and search workers release their connections. Events, accounts, file catalogs, plugin registries, context metadata, optional automation/conductor stores and the daemon lock keep their established owners. The independent daemon-lock connection must hold its OS lock for the daemon lifetime. These changes avoid schema migrations and preserve restart/durability ownership.

Measured query plans use the event sequence primary key, `events_thread_seq`, the composite engine-state record key, `source_path`, `source_parent` and the covering `source_workspace` index. No full event-history scan is introduced in append or delivery.

The synthetic history comparison uses 5,000 transcripts and Node 26.8.1. Main's public `scan()` always verifies inventory; the new live `scanChanges()` consumes native change batches. [history-main-baseline.json](history-main-baseline.json) and [history-settled.json](history-settled.json) preserve the comparison.

| History operation                | Main before |     After | Files visited before / after | Transcript reads before / after |
| -------------------------------- | ----------: | --------: | ---------------------------: | ------------------------------: |
| Cold inventory                   | 1,015.80 ms | 874.80 ms |                5,000 / 5,000 |                   5,000 / 5,000 |
| Unchanged settled live inventory |   398.15 ms |   0.29 ms |                    5,000 / 0 |                           0 / 0 |
| One append                       |   309.70 ms |   5.28 ms |                    5,000 / 1 |                           1 / 1 |
| Restart inventory                |   628.21 ms | 222.91 ms |                5,000 / 5,000 |                           0 / 0 |

The after run separately records one late macOS startup notification batch: 203.53 ms, 5,000 metadata visits and zero reads. The synthetic creation burst can arrive after the first scan, so the harness now records up to eight startup invalidation scans before the settled sample. [history-repeat.json](history-repeat.json) preserves the preceding repeat with the startup batch included in its unchanged sample: 163.10 ms and 5,000 visits. [history.json](history.json) and [history-final.json](history-final.json) preserve earlier repeats, including a 5,330.64 ms cold outlier. Timing variation is retained rather than attributed to further implementation changes.

Restart cost remains O(files). Directory mtimes cannot prove that existing transcript contents were not edited while ace was stopped. Startup and explicit refresh therefore verify inventory; missing/unsupported/uncertain native watches fall back to full verification. Rename notifications may verify a parent subtree. The complexity improvement applies to settled live scans with healthy native watching.

## Budgets and verification

`check:perf` now runs the daemon budget measurement before the existing web performance gate. `bun run check` already includes `check:perf`. The daemon gate builds a fresh bundle, samples seven seconds idle, ingests 1,000 deltas, warms 128 fresh threads, and runs a five-second fresh-thread soak with all-isolate collection. The long soak is opt-in with `node apps/daemon/bench/check.ts --long`.

| Budget                                         |                             Limit |
| ---------------------------------------------- | --------------------------------: |
| Idle RSS                                       |                           256 MiB |
| Endpoint publication                           |                          5,000 ms |
| Idle OS threads / recent JS workers            |                            18 / 1 |
| Active OS threads                              |                                20 |
| Ingest                                         |             at least 300 events/s |
| WebSocket p99                                  |                             50 ms |
| Retained main heap growth                      |                             8 MiB |
| Retained process RSS growth                    |                            64 MiB |
| Shutdown                                       |                          1,500 ms |
| Opt-in long soak final-quarter RSS mean growth | 16 MiB over the preceding quarter |

The 150 MiB idle aim remains unmet. The Node 26 gate passes with 994.25 events/s, p99 2.42 ms, startup 812.65 ms, idle RSS 218.72 MiB and retained RSS growth 4.19 MiB. Its observed throughput also exceeds the earlier stricter 500 events/s limit. The pinned Node 24 gate passes with 1,161.66 events/s, p99 2.33 ms, startup 805.79 ms, idle RSS 223.33 MiB and retained RSS change -5.91 MiB. Raw short-gate data is in [gate-node26.json](gate-node26.json) and [gate-node24.json](gate-node24.json). Gate headroom comes from the measured release and local runtimes, and needs CI calibration at merge. Startup/filesystem and throughput measurements depend on host load. The first short gate with 16 warm-up cycles hit its 35-second measurement timeout; the gate now uses eight cycles and reports phases. Signal cleanup also handles child termination without waiting for an already emitted exit.

No tests, repository `check`, web benchmarks, Docker harnesses, mutation runs or provider prompts were executed. Behaviour tests are written and statically reviewed. [Merge verification and mutation cases](../../../docs/testing/daemon-performance.md) marks every test case as not executed, tests run at merge. Permitted static checks are recorded in the PR. Packaged helper execution, cross-platform watch overflow/error recovery and CI budget calibration need run at merge.

## UI follow-up for the Claude web agent

None. This change uses the existing backend/protocol/client delivery and history APIs and requires no UI work.
