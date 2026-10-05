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

The measurement preload samples each JavaScript isolate every 500 ms and atomically publishes a small JSON file. RSS and CPU are process-wide; worker heaps are per-isolate and must not be added to RSS. OS threads also include libuv, V8 and filesystem-watcher threads. The preload subscribes to Node’s `worker_threads` diagnostic channel. Creation first publishes a pending identity; the worker acknowledges initialization through a measurement-only BroadcastChannel after atomically writing its first file. Only then does its parent publish it as live. Samples read the root and its acknowledged descendants directly, then reread their lifecycle generations to verify a coherent tree. Initialization and retirement transitions may resample for at most four seconds inside the unchanged outer deadline. A stable missing live file, malformed file, duplicate identity or cyclic ownership is fatal. On exit, the parent publishes its new generation before pruning the retired subtree’s files. Work and disk usage therefore follow live isolates rather than historical churn; churn latency still needs measurement at merge. See the [Node channel documentation](https://nodejs.org/api/diagnostics_channel.html#event-worker_threads). CPU numbers include this observer's overhead. The scripts currently measure Darwin/Linux thread counts.

`--collect` enables GC only in the measurement process. It measures retained main-isolate heap and process RSS before and after the soak, after warm-up. Main-isolate GC is followed by event-loop turns so weak native wrappers can finalize. With `--collect-workers`, the measurement preload also collects live worker heaps through an acknowledged file marker. Production never enables this marker. Without that flag, worker heaps are sampled without forced GC. Production does not expose or force GC. Without `--fresh-cycles`, the soak reopens the same 16 threads; with it, each cycle creates 16 new durable threads, finishes their turns and closes their sessions. The database deliberately retains the historical rows. The fixed-size engine caches must not retain every closed session. Soak samples also record each worker heap and identity. Compare RSS as well as heap: allocator/native growth can be invisible to `heapUsed`.

The gate builds a fresh bundle and runs a seven-second idle sample, eight warm-up cycles and a five-second fresh-thread soak. Budgets have headroom over measurements on this Mac; CI hardware calibration still needs execution at merge. The fast run includes all-isolate GC at its two retention boundaries. `--progress` writes phase labels to stderr for deadline diagnosis. The full repository `check:perf` retains its existing web performance gate after this daemon gate.

### Timing under background load

The gate repeats a phase once when its first sample fails only timing checks. Compilation, long-thread acceptance and the short measurement keep their per-attempt deadlines of 20, 180 and 35 seconds. A repeat uses the complete original workload, including the idle interval, warm-up, fresh-thread soak and GC boundaries. The long measurement keeps its 360-second deadline. No floor, ceiling, workload or timeout changes between attempts.

Only a subprocess killed by its deadline or a measured startup, throughput, delivery-latency or shutdown violation qualifies. The first rejected timing sample remains in the output. An assertion, malformed result, resource violation or ordinary subprocess failure fails immediately. If timing and resources both fail, resources take precedence and there is no repeat. A completed result is still checked for resource violations if cleanup later hits the deadline; an older attempt’s result is removed before the next attempt. The second failure always fails the gate. Compilation attempts use separate output directories. Acceptance and measurement synchronously publish failure markers before awaited cleanup. The subprocess boundary recognizes both markers, so a later cleanup deadline cannot turn a correctness failure into a timing repeat. Output overflow remains fatal even when it kills the process with SIGTERM. Its fixture uses the same `ws` client as the throughput harness; this avoids the native client socket that lingered for roughly 60 seconds after completed baseline and main runs in this investigation.

This rule tolerates one transient load spike without averaging away a repeatable slowdown. Sustained host saturation still fails; a passing repeat must independently meet every original budget. The short measurement counts receipt of all 1,000 deltas through the real socket, rather than extrapolating from a smaller sample. See [the main/#94 comparison](perf-regression-report.md) for the measurements behind this rule.

`inventory.ts --full-scans` selects authoritative full scans and can also run against main before the incremental API exists. Copy `inventory.ts` and `output.ts` into that worktree's bench directory to keep workspace package imports attached to the baseline. `inventory.ts` uses a real provider-home directory containing synthetic Claude JSONL files. It records up to eight delayed startup invalidation batches separately, then waits for an observed native change before measuring incremental reconciliation. An unsupported watcher can still leave the unchanged sample as a full scan; the raw file-visit counts show that fallback. Explicit refreshes and restarts always verify the inventory; directory mtimes cannot prove that transcript files were not edited in place while ace was stopped. Live watch batches are capped at 4,096 paths across all instances. Missing, failed or uncertain watchers fall back to a full scan. This preserves correctness but leaves O(change) restart scanning unresolved.

Raw measurements are checked in beside this file. Single-run startup, throughput and p99 values are sensitive to machine load and cold filesystem caches; intermediate runs are diagnostic observations, not statistical speedup claims. `baseline.json` is the source checkout before these changes; `compiled.json` isolates minified bundling, and `lazy.json` adds the worker/SDK lifecycle changes. `sqlite.json`, `soak.json.gz` and `after.json.gz` record later stages. `fresh-after.json.gz` caught RSS growth after merging #82; `final.json.gz` records the subsequent hot-path fixes. `native.json.gz` and `policy.json.gz` isolate the native growth that survives a flat main heap; `watch-pool-after.json.gz` measures shared settings watches after merging #83. `deck-main-baseline.json.gz` records the matching current-main baseline. `merge-fixes-after.json.gz`, `gate-merge-fixes.json` and `history-merge-fixes.json` repeat the measurements after the #86 merge failure repairs. The supported release-runtime sample is recorded separately to avoid comparing different Node versions as an implementation improvement.

`--regions` records macOS vmmap or Linux smaps summaries before and after the soak. On macOS, `--malloc-stacks=PATH` enables allocation stack logging and saves the first 64 KiB of allocations sorted by count. That diagnostic mode adds overhead and must not be used for headline latency or RSS comparisons. Stack collection is bounded to 30 seconds. The measured malloc totals distinguish native allocation growth from V8 heap or resident-page retention.

Long raw series are stored losslessly as `.json.gz`. Any measurement accepts `--output=FILE.json.gz`; stdout remains JSON. Read a checked-in series with `python3 -c 'import gzip,json; print(json.load(gzip.open("apps/daemon/bench/long-after.json.gz"))["retainedEnd"])'`. Small summaries remain plain JSON.

## Long-thread acceptance

`node --expose-gc apps/daemon/bench/long-thread-reliability.ts` runs the fast acceptance workload: 10,000 initial items, 5,000 answered approvals followed by 5,000 pending approvals, 48 provider subagents, four large-gap reconnects, 64 KiB stdout bursts and a concurrent worker history publication. Pending approvals remain open through reconnects. It verifies item counts, exact committed text length, snapshot and frame budgets, retained memory and writes per delta, including a separate pending-approval write sample. Both write samples budget below 2,048 WAL bytes and one changed row per delta. `check:perf` includes this workload in the daemon gate.

`node --expose-gc apps/daemon/bench/long-thread-reliability.ts --long` seeds one million items and runs for two days. `--items=N`, `--cycles=N` and `--duration-ms=N` allow shorter investigations. The synthetic provider is a local Node fixture; it never invokes a provider CLI. Memory telemetry retains at most 128 samples, and SQLite checkpointing resumes after the isolated write-volume sample.

`long-thread-writes.ts` compares 1,000 one-character tokens, each preceded by a transport signal, on a WAL truncated immediately before measurement. `long-thread-snapshot.ts` compares the same 10,000-item, 5,000-approval, 48-subagent fixture on both branches. Run each copied script from its own worktree so workspace dependencies resolve to that checkout.

For packaged-desktop idle diagnosis, `compile.ts --cli --runtime` builds the actual
release CLI entry. `measure.ts --idle-only --entry=… --node=…` samples it for one
minute and quits with SIGTERM, without sending scripted IPC or provider prompts.
See [desktop smoke measurements](desktop-smoke-REPORT.md) for the measured source,
bundle, worker and SQLite differences.

## Review revision: static verification only

The owner prohibits executing tests, benchmarks, probes, mutation runs and CI during review. Historical numbers in [the investigation](perf-regression-report.md) describe the pre-review implementation; they do not validate this revision. Both blocker reproductions are written as public-API behaviour tests with real subprocesses or workers, but their failing and passing runs **need run at merge**. [Review coverage and mutation cases](review-coverage.md) records each designed assertion as **not executed (tests run at merge)**. No budget, workload or per-attempt timeout changes were made.

## Idle import guard

`check.ts` also runs `node apps/daemon/bench/idle-imports.ts`. The guard starts the
source benchmark daemon in a temporary home with provider discovery disabled,
observes actual module loads in the main isolate and startup workers, and includes
background initialization before shutdown. It reports each forbidden dependency
by name, including sharp, Cursor/Claude/OpenCode SDKs, browser/CDP clients, the ACP
SDK and MCP SDKs. Source execution preserves names that a production bundle would
otherwise hide. The separate bundled measurement still enforces the unchanged RSS,
startup, thread, latency, throughput and shutdown limits.

All scripted measurements isolate `HOME`, `USERPROFILE` and `ACE_HOME`, clear the
executable search path and disable the Cursor SDK status probe. They never invoke
installed provider CLIs, including version and authentication status probes.

The release main entry uses ESM code splitting so a lazy import also avoids parsing
SDK code at idle. Chunks sit beside `ace.mjs`; worker/helper entries remain independent
bundles, and the release checksum/archive inventory includes every generated file.
