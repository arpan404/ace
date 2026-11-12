# Daemon measurements

`idle-catalog.ts` reproduces idle command-discovery work with eight open workspace
catalogs, one prompt file each, 256 manual automations (approximately 128 KiB per
prompt), and a real local WebSocket. It sends no model requests. Ten seconds of
warmup precede a 60-second process CPU and event-loop measurement. Unlike
`idle-cpu.ts`, this workload holds workspace catalog subscriptions open.

```sh
task_home=$(mktemp -d /tmp/ace-idle-catalog.XXXXXX)
task_node=$(command -v node)
env -i HOME="$task_home" USERPROFILE="$task_home" \
  CODEX_HOME="$task_home/.codex" CLAUDE_CONFIG_DIR="$task_home/.claude" \
  XDG_CONFIG_HOME="$task_home/.config" XDG_DATA_HOME="$task_home/.local/share" \
  XDG_CACHE_HOME="$task_home/.cache" ACE_HOME="$task_home/daemon" \
  ACE_ACCOUNTS_DB="$task_home/accounts.sqlite" ACE_PORT=0 ACE_LISTEN=local \
  ACE_LOG_LEVEL=info ACE_MAINTENANCE=0 ACE_DEV=0 \
  ACE_HISTORY_INSTANCES='[]' ACE_MODEL_INSTANCES='[]' PATH='' \
  "$task_node" apps/daemon/bench/idle-catalog.ts
# Logs and data remain under $task_home for inspection; remove it afterward.
```

Set `IDLE_CONTEXTS`, `IDLE_AUTOMATIONS` or `IDLE_SECONDS` in that isolated environment
to vary the workload. Run the same script in each checkout so workspace imports
resolve to the implementation being measured. Use `sample PID 10 10 -file …` and
`ps -p PID -o pid,%cpu,time,etime` after the `measuring` record. V8 `--cpu-prof`
adds sampling-thread CPU, so collect it separately from headline CPU measurements.
The event-loop histogram measures only the window; the daemon's drift monitor
also includes startup. [Catalog idle measurements](idle-catalog-REPORT.md) record
the investigation and its host-load limits.

These scripts start the real daemon on Bun, its runtime (scripts/runtimes.ts finds it when they run on Node), with a temporary `ACE_HOME`, an in-process scripted provider, real SQLite and a real WebSocket. They never send provider prompts. The synthetic provider deliberately has no native process, so active-session RSS excludes provider CLI memory. The harness adds a second engine sharing the daemon's Store to feed scripted frames through the normal persistence and delivery paths.

```sh
# Source baseline: Bun, development TypeScript entries.
bun apps/daemon/bench/measure.ts --output=baseline.json

# Production bundling, including every independently bundled worker/helper entry.
bun apps/daemon/bench/compile.ts --output=.ace-dev/perf-current
bun apps/daemon/bench/measure.ts --entry=.ace-dev/perf-current/ace.mjs --output=after.json.gz

# Optionally stage the release's pinned runtime (Bun, shipped as bin/node) as well.
bun apps/daemon/bench/compile.ts --output=.ace-dev/perf-release --runtime
bun apps/daemon/bench/measure.ts --entry=.ace-dev/perf-release/ace.mjs --node=.ace-dev/perf-release/bin/node --output=release.json

# Fresh thread identities exercise cache eviction and lifecycle ownership.
bun apps/daemon/bench/measure.ts --entry=.ace-dev/perf-current/ace.mjs --warmup-cycles=16 --fresh-cycles --collect --soak-ms=180000 --output=soak.json.gz

# Only the daemon budget measurement, without the repository test suites.
bun apps/daemon/bench/check.ts
# Optional five-minute budget soak.
bun apps/daemon/bench/check.ts --long
```

The daemon gate also measures idle CPU on a persisted store with 16 completed fake-provider sessions and 16,000 historical deltas. It closes the seeding daemon and reopens that store, warms up for 10 seconds, then samples process-wide `process.cpuUsage()` around a full 60-second idle interval. This includes worker CPU, uses the child's actual monotonic elapsed time, and adds no telemetry interval to the daemon. Average CPU must remain below 2% of one core; the existing 256 MiB RSS budget still applies. Timing qualification uses the same host-load gate before and after measurement. Run `bun apps/daemon/bench/idle-cpu.ts` for a standalone source measurement, or pass a compiled bench entry as its first argument. The gate uses a freshly compiled entry.

Defaults sample idle memory 10 and 60 seconds after endpoint publication, then open 16 scripted sessions and ingest 1,000 timestamped deltas. Endpoint publication is the same startup boundary as the existing owner measurement; it is not completion of background indexing. Throughput includes provider frame translation, append, projection and receipt by the WebSocket subscriber. p99 uses synchronized epoch timestamps from processes on this machine. `--sessions=N`, `--events=N`, `--idle-ms=N` and `--soak-ms=N` change the workload. Short runs record their actual idle sampling interval and leave `idle60` null; their idle CPU is not meaningful.

The measurement preload samples each JavaScript isolate every 500 ms and atomically publishes a small JSON file. RSS and CPU are process-wide; worker heaps are per-isolate and must not be added to RSS. OS threads also include libuv, V8 and filesystem-watcher threads. The preload subscribes to Node’s `worker_threads` diagnostic channel. Creation first publishes a pending identity; the worker acknowledges initialization through a measurement-only BroadcastChannel after atomically writing its first file. Only then does its parent publish it as live. Samples read the root and its acknowledged descendants directly, then reread their lifecycle generations to verify a coherent tree. Initialization and retirement transitions may resample for at most four seconds inside the unchanged outer deadline. A stable missing live file, malformed file, duplicate identity or cyclic ownership is fatal. On exit, the parent publishes its new generation before pruning the retired subtree’s files. Work and disk usage therefore follow live isolates rather than historical churn; churn latency still needs measurement at merge. See the [Node channel documentation](https://nodejs.org/api/diagnostics_channel.html#event-worker_threads). CPU numbers include this observer's overhead. On Bun a preload doesn't reach workers and nothing announces them on that channel, so every worker ace runs starts through `startWorker` (`@ace/provider-kit/worker`): with `ACE_BENCH_WORKER_PRELOAD` set it gives the worker those preloads and announces it on the channel as Node does. The preload holds that channel for the process's life; Bun drops a channel nothing references, and later announcements would reach nobody.

Threads are counted by owner from their names (`threads.ts`: `sample` on macOS, `/proc` on Linux). Bun's runtime threads (its pool, GC helpers and collectors, JIT helpers, the allocator's scavenger) grow with the machine's cores, so they get only a loose ceiling of twice the cores plus 16, which a runaway pool reaches; each JS worker is one thread named `Worker`; the rest are the daemon's own. The gate (`budgets.ts`) fails when:

- the OS runs more workers than telemetry saw ("not measured", never a zero);
- more than one worker stays alive through the five-second startup idle floor (the stall watchdog stays);
- more than four workers run under the workload;
- once the workload's sessions end, a worker stays whose kind (its module's name, which `startWorker` reports) isn't on the gate's list, or two of one kind. An idle window grows when a worker is reused before `max(12 × base, 4 × current)` milliseconds after retirement, up to two minutes; long quiet resets it to the base five seconds. The list holds the watchdog, the notification worker the workload's first notification starts for good, and the usage and WAL-checkpoint workers, which the benchmark reuses periodically. The measurement waits up to 130 s for anything else to retire;
- the daemon's own threads pass 4 idle or 6 active (measured 2–3 and 3–4 on Bun 1.4.4), or Bun's runtime threads pass twice the cores plus 16.

The scripts measure Darwin/Linux threads only.

`--collect` enables GC only in the measurement process. It measures retained main-isolate heap and process RSS before and after the soak, after warm-up. Main-isolate GC is followed by event-loop turns so weak native wrappers can finalize. With `--collect-workers`, the measurement preload also collects live worker heaps through an acknowledged file marker. Production never enables this marker. Without that flag, worker heaps are sampled without forced GC. Production does not expose or force GC. Without `--fresh-cycles`, the soak reopens the same 16 threads; with it, each cycle creates 16 new durable threads, finishes their turns and closes their sessions. The database deliberately retains the historical rows. The fixed-size engine caches must not retain every closed session. Soak samples also record each worker heap and identity. Compare RSS as well as heap: allocator/native growth can be invisible to `heapUsed`.

The fresh-thread soak alone never reaches the daemon's read paths: the threads are made by a second engine, and nothing reads them. `--subscribe` adds a WebSocket client that keeps the thread list subscribed and opens each cycled thread once, then unsubscribes, as the desktop does. `--settle` makes that client settle each thread it opened, since the Inbox lists every unsettled thread in full and would otherwise grow with every cycle by design. `--reconnect` has it connect again every cycle, and `--cycle-events=N` streams N deltas into each cycled thread before its turn ends. `ACE_PERF_HEAP_SNAPSHOTS=<dir>` writes a V8-format main-isolate heap snapshot (Bun only) at each `--collect` boundary, so two points can be diffed by object type and retainer. [Heap growth measurements](heap-growth-REPORT.md) record what these showed.

The gate builds a fresh bundle and runs a seven-second idle sample, eight warm-up cycles and a five-second fresh-thread soak. Budgets have headroom over measurements on this Mac; CI hardware calibration still needs execution at merge. The fast run includes all-isolate GC at its two retention boundaries. `--progress` writes phase labels to stderr for deadline diagnosis. The full repository `check:perf` retains its existing web performance gate after this daemon gate.

### Timing under background load

The gate repeats a phase once when its first sample fails only timing checks. Compilation, long-thread acceptance and the short measurement keep their per-attempt deadlines of 20, 180 and 35 seconds. A repeat uses the complete original workload, including the idle interval, warm-up, fresh-thread soak and GC boundaries. The long measurement keeps its 360-second deadline. No floor, ceiling, workload or timeout changes between attempts.

Only a subprocess killed by its deadline or a measured startup, throughput, delivery-latency or shutdown violation qualifies. The first rejected timing sample remains in the output. An assertion, malformed result, resource violation or ordinary subprocess failure fails immediately. If timing and resources both fail, resources take precedence and there is no repeat. A completed result is still checked for resource violations if cleanup later hits the deadline; an older attempt’s result is removed before the next attempt. The second failure always fails the gate. Compilation attempts use separate output directories. Acceptance and measurement synchronously publish failure markers before awaited cleanup. The subprocess boundary recognizes both markers, so a later cleanup deadline cannot turn a correctness failure into a timing repeat. Output overflow remains fatal even when it kills the process with SIGTERM. Its fixture uses the same `ws` client as the throughput harness; this avoids the native client socket that lingered for roughly 60 seconds after completed baseline and main runs in this investigation.

This rule tolerates one transient load spike without averaging away a repeatable slowdown. Sustained host saturation still fails; a passing repeat must independently meet every original budget. The short measurement counts receipt of all 1,000 deltas through the real socket, rather than extrapolating from a smaller sample. See [the main/#94 comparison](perf-regression-report.md) for the measurements behind this rule.

The history inventory and idle-scan benches (`inventory.ts`, `history-idle.ts`) were removed in c30658b86: the daemon no longer scans provider history at startup or while idle, only when someone asks from Settings > Providers > Past sessions. `history.json`, `history-main-baseline.json`, `history-settled.json` and related files remain as historical records.

Raw measurements are checked in beside this file. Single-run startup, throughput and p99 values are sensitive to machine load and cold filesystem caches; intermediate runs are diagnostic observations, not statistical speedup claims. `baseline.json` is the source checkout before these changes; `compiled.json` isolates minified bundling, and `lazy.json` adds the worker/SDK lifecycle changes. `sqlite.json`, `soak.json.gz` and `after.json.gz` record later stages. `fresh-after.json.gz` caught RSS growth after merging #82; `final.json.gz` records the subsequent hot-path fixes. `native.json.gz` and `policy.json.gz` isolate the native growth that survives a flat main heap; `watch-pool-after.json.gz` measures shared settings watches after merging #83. `merge-fixes-after.json.gz`, `gate-merge-fixes.json` and `history-merge-fixes.json` repeat the measurements after the #86 merge failure repairs. The supported release-runtime sample is recorded separately to avoid comparing different Node versions as an implementation improvement.

`--regions` records macOS vmmap or Linux smaps summaries before and after the soak. On macOS, `--malloc-stacks=PATH` enables allocation stack logging and saves the first 64 KiB of allocations sorted by count. That diagnostic mode adds overhead and must not be used for headline latency or RSS comparisons. Stack collection is bounded to 30 seconds. The measured malloc totals distinguish native allocation growth from V8 heap or resident-page retention.

Long raw series are stored losslessly as `.json.gz`. Any measurement accepts `--output=FILE.json.gz`; stdout remains JSON. Read a checked-in series with `python3 -c 'import gzip,json; print(json.load(gzip.open("apps/daemon/bench/long-after.json.gz"))["retainedEnd"])'`. Small summaries remain plain JSON.

## Allocation per streamed event

`allocation-rate.ts` measures how much garbage the daemon makes per streamed delta: the bytes its
main isolate allocates and the process CPU it spends per 1,000 deltas, with `--subscribers`
WebSocket clients (default 1, `0` for none) subscribed to the streaming thread. It starts the bench
entry (or a bundle with `--entry`) with the scripted provider, streams one warm-up window and then
`--windows` windows (default 3) of `--events` deltas (default 5,000), each ending when every
subscriber has received every delta, and reports each window and the medians.

Allocation comes from JSC's own GC log (`BUN_JSC_logGC=1`, set for the child): every collection
logs `ca=`, the bytes allocated since the last one. The entry forces a full collection on both
sides of a window, so the window's collections plus the closing one's remainder are exactly its
allocation ([allocation-meter.ts](allocation-meter.ts)). `process.memoryUsage().heapUsed` is no
substitute on Bun: it misses most short-lived garbage (a 1.5 KB string made 20,000 times reads as
34 B each). Worker isolates are counted apart, as `workerAllocatedPer1000`. CPU is raw
`process.cpuUsage()` over the window, every thread included; `peakHeapUsed` is sampled every 10 ms.

`allocation-compare.ts` runs several bundles interleaved (A B A B …), so host load lands on each
alike, and prints the median of their per-run medians:

```sh
bun apps/daemon/bench/compile.ts --output=.ace-dev/alloc-before   # on the base commit
bun apps/daemon/bench/compile.ts --output=.ace-dev/alloc-after    # on the change
bun apps/daemon/bench/allocation-compare.ts --runs=3 --events=5000 \
  .ace-dev/alloc-before/ace.mjs .ace-dev/alloc-after/ace.mjs
```

`--cpu-prof=<dir>` on `allocation-rate.ts` writes the daemon's CPU profile. To see which code
allocates, V8's sampling heap profiler can keep collected objects
(`HeapProfiler.startSampling` with `includeObjectsCollectedByMajorGC` and `…MinorGC`); the source
daemon runs on Node for that. Its byte counts are V8's, so rank sources with it and measure on Bun.

## Long-thread acceptance

`bun --expose-gc apps/daemon/bench/long-thread-reliability.ts` runs the fast acceptance workload: 10,000 initial items, 5,000 answered approvals followed by 5,000 pending approvals, 48 provider subagents, four large-gap reconnects, 64 KiB stdout bursts and a concurrent worker history publication. Pending approvals remain open through reconnects. It verifies item counts, exact committed text length, snapshot and frame budgets, retained memory and writes per delta, including a separate pending-approval write sample. Both write samples budget below 2,048 WAL bytes and one changed row per delta. `check:perf` includes this workload in the daemon gate.

`bun --expose-gc apps/daemon/bench/long-thread-reliability.ts --long` seeds one million items and runs for two days. `--items=N`, `--cycles=N` and `--duration-ms=N` allow shorter investigations. The synthetic provider is a local Node fixture; it never invokes a provider CLI. Memory telemetry retains at most 128 samples, and SQLite checkpointing resumes after the isolated write-volume sample.

`long-thread-writes.ts` compares 1,000 one-character tokens, each preceded by a transport signal, on a WAL truncated immediately before measurement. `long-thread-snapshot.ts` compares the same 10,000-item, 5,000-approval, 48-subagent fixture on both branches. Run each copied script from its own worktree so workspace dependencies resolve to that checkout.

For packaged-desktop idle diagnosis, `compile.ts --cli --runtime` builds the actual
release CLI entry. `measure.ts --idle-only --entry=… --node=…` samples it for one
minute and quits with SIGTERM, without sending scripted IPC or provider prompts.
See [desktop smoke measurements](desktop-smoke-REPORT.md) for the measured source,
bundle, worker and SQLite differences.

## Review revision: static verification only

The owner prohibits executing tests, benchmarks, probes, mutation runs and CI during review. Historical numbers in [the investigation](perf-regression-report.md) describe the pre-review implementation; they do not validate this revision. Both blocker reproductions are written as public-API behaviour tests with real subprocesses or workers, but their failing and passing runs **need run at merge**. [Review coverage and mutation cases](review-coverage.md) records each designed assertion as **not executed (tests run at merge)**. No budget, workload or per-attempt timeout changes were made.

## Idle import guard

`check.ts` also runs `bun apps/daemon/bench/idle-imports.ts`. The guard starts the
source benchmark daemon on Bun in a temporary home with provider discovery disabled,
observes actual module loads in the main isolate and every worker ace starts, and
includes background initialization before shutdown. Bun has no load hooks like Node's
`registerHooks`, and its resolve hook never sees package imports, so a Bun preload
hooks the loads of exactly the forbidden files. Workers get it through
`ACE_BENCH_WORKER_PRELOAD`. Bun numbers workers from 1 across the process, so the hook
logs each worker the factory announces and each isolate it ran in, and at the guard's
close request the next worker id: every id below it must have been announced and must
have run the hook, or the guard fails as not measured. A lint rule keeps `Worker` from
being imported past the factory, and the CLI entry and the desktop drop the variable so
it never reaches a person's daemon. It reports each forbidden dependency
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
