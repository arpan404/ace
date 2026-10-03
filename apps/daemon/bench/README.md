# Daemon measurements

These scripts start the real daemon with a temporary `ACE_HOME`, an in-process scripted provider, real SQLite and a real WebSocket. They never send provider prompts. The synthetic provider deliberately has no native process, so active-session RSS excludes provider CLI memory. The harness adds a second engine sharing the daemon's Store to feed scripted frames through the normal persistence and delivery paths.

```sh
# Source baseline: installed Node, development TypeScript entries.
node apps/daemon/bench/measure.ts --output=baseline.json

# Production bundling, including every independently bundled worker/helper entry.
node apps/daemon/bench/compile.ts --output=.ace-dev/perf-current
node apps/daemon/bench/measure.ts --entry=.ace-dev/perf-current/ace.mjs --output=after.json.gz

# Optionally stage the release's pinned Node runtime as well.
node apps/daemon/bench/compile.ts --output=.ace-dev/perf-release --runtime
node apps/daemon/bench/measure.ts --entry=.ace-dev/perf-release/ace.mjs --node=.ace-dev/perf-release/bin/node --output=node24.json

# Fresh thread identities exercise cache eviction and lifecycle ownership.
node apps/daemon/bench/measure.ts --entry=.ace-dev/perf-current/ace.mjs --warmup-cycles=16 --fresh-cycles --collect --soak-ms=180000 --output=soak.json.gz

# Synthetic history and EXPLAIN QUERY PLAN for indexed reconciliation.
node apps/daemon/bench/inventory.ts --files=5000 --output=history.json

# Only the daemon budget measurement, without the repository test suites.
node apps/daemon/bench/check.ts
# Optional five-minute budget soak.
node apps/daemon/bench/check.ts --long
```

Defaults sample idle memory 10 and 60 seconds after endpoint publication, then open 16 scripted sessions and ingest 1,000 timestamped deltas. Endpoint publication is the same startup boundary as the existing owner measurement; it is not completion of background indexing. Throughput includes provider frame translation, append, projection and receipt by the WebSocket subscriber. p99 uses synchronized epoch timestamps from processes on this machine. `--sessions=N`, `--events=N`, `--idle-ms=N` and `--soak-ms=N` change the workload. Short runs record their actual idle sampling interval and leave `idle60` null; their idle CPU is not meaningful.

The measurement preload samples each JavaScript isolate every 500 ms and atomically publishes a small JSON file. RSS and CPU are process-wide; worker heaps are per-isolate and must not be added to RSS. OS threads also include libuv, V8 and filesystem-watcher threads. Worker telemetry remains visible for up to 1.5 seconds after retirement; a recent telemetry file does not prove a worker is still alive. CPU numbers include this observer's overhead. The scripts currently measure Darwin/Linux thread counts.

`--collect` enables GC only in the measurement process. It measures retained main-isolate heap and process RSS before and after the soak, after warm-up. Main-isolate GC is followed by event-loop turns so weak native wrappers can finalize. With `--collect-workers`, the measurement preload also collects live worker heaps through an acknowledged file marker. Production never enables this marker. Without that flag, worker heaps are sampled without forced GC. Production does not expose or force GC. Without `--fresh-cycles`, the soak reopens the same 16 threads; with it, each cycle creates 16 new durable threads, finishes their turns and closes their sessions. The database deliberately retains the historical rows. The fixed-size engine caches must not retain every closed session. Soak samples also record each worker heap and identity. Compare RSS as well as heap: allocator/native growth can be invisible to `heapUsed`.

The gate builds a fresh bundle and runs a seven-second idle sample, eight warm-up cycles and a five-second fresh-thread soak. Budgets have headroom over measurements on this Mac; CI hardware calibration still needs execution at merge. The fast run includes all-isolate GC at its two retention boundaries. `--progress` writes phase labels to stderr for deadline diagnosis. The full repository `check:perf` retains its existing web performance gate after this daemon gate. The owner prohibited running repository tests and the web benchmarks during this task.

`inventory.ts --full-scans` selects authoritative full scans and can also run against main before the incremental API exists. Copy `inventory.ts` and `output.ts` into that worktree's bench directory to keep workspace package imports attached to the baseline. `inventory.ts` uses a real provider-home directory containing synthetic Claude JSONL files. It records up to eight delayed startup invalidation batches separately, then waits for an observed native change before measuring incremental reconciliation. An unsupported watcher can still leave the unchanged sample as a full scan; the raw file-visit counts show that fallback. Explicit refreshes and restarts always verify the inventory; directory mtimes cannot prove that transcript files were not edited in place while ace was stopped. Live watch batches are capped at 4,096 paths across all instances. Missing, failed or uncertain watchers fall back to a full scan. This preserves correctness but leaves O(change) restart scanning unresolved.

Raw measurements are checked in beside this file. Single-run startup, throughput and p99 values are sensitive to machine load and cold filesystem caches; intermediate runs are diagnostic observations, not statistical speedup claims. `baseline.json` is the source checkout before these changes; `compiled.json` isolates minified bundling, and `lazy.json` adds the worker/SDK lifecycle changes. `sqlite.json`, `soak.json.gz` and `after.json.gz` record later stages. `fresh-after.json.gz` caught RSS growth after merging #82; `final.json.gz` records the subsequent hot-path fixes. `native.json.gz` and `policy.json.gz` isolate the native growth that survives a flat main heap; `watch-pool-after.json.gz` measures shared settings watches after merging #83. `deck-main-baseline.json.gz` records the matching current-main baseline. `merge-fixes-after.json.gz`, `gate-merge-fixes.json` and `history-merge-fixes.json` repeat the measurements after the #86 merge failure repairs. The supported release-runtime sample is recorded separately to avoid comparing different Node versions as an implementation improvement.

`--regions` records macOS vmmap or Linux smaps summaries before and after the soak. On macOS, `--malloc-stacks=PATH` enables allocation stack logging and saves the first 64 KiB of allocations sorted by count. That diagnostic mode adds overhead and must not be used for headline latency or RSS comparisons. Stack collection is bounded to 30 seconds. The measured malloc totals distinguish native allocation growth from V8 heap or resident-page retention.

Long raw series are stored losslessly as `.json.gz`. Any measurement accepts `--output=FILE.json.gz`; stdout remains JSON. Read a checked-in series with `python3 -c 'import gzip,json; print(json.load(gzip.open("apps/daemon/bench/long-after.json.gz"))["retainedEnd"])'`. Small summaries remain plain JSON.
