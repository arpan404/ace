# Main versus #94: performance investigation, 2026-10-04

The reproduced failures are load-sensitive; these measurements do not establish a product regression since #94. Main was faster in every completed paired throughput measurement. The web outlier spent almost all its reported duration off CPU. No culprit merge was identified, so bisection against unstable wall-clock failures would give misleading results.

The compared revisions were `6dbcc268f4217441ccff5c5b72ac1f8c62a6b8d0` (main, #111) and `062a804f49181ef1e220381612500b3feb88cf5b` (#94). First-parent history places #97 and #98 before #94. Both checkouts used the same installed Node v26.8.1, Bun 1.4.0, dependencies and 16-core Darwin host. Runs were serial and alternated main, #94, three times. Host load averages ranged from roughly 100 to 900 during the investigation. These are observations on a shared machine, not controlled speedup estimates.

## Daemon before

First, the original gates were repeated back to back. Five valid attempts failed on both revisions: four exceeded the unchanged 20-second compilation deadline, and one #94 run got through compilation but exceeded the 180-second acceptance deadline. One additional #94 attempt was excluded because its newly installed native workspace addon had not yet been built; the addon was built before subsequent comparisons.

Bundles were then built separately to distinguish compilation scheduling from the daemon workload. The exact original throughput workload was run in each checkout: 16 sessions, 1,000 timestamped deltas, seven-second idle interval, eight fresh-thread warm-ups, five-second soak and both all-isolate GC boundaries. Acceptance also retained all 10,000 items, 5,000 answered plus 5,000 pending approvals, 48 subagents, four reconnects, stdout bursts and concurrent history publication.

The diagnostic acceptance invocations were allowed to finish outside the gate; their durations below do **not** mean the original 180-second gate passed. The throughput diagnostic harness had its own 67-second outer bound, separate from the unchanged 35-second gate.

| Round | Main events/s |            #94 events/s | Main delivery p99 ms | #94 delivery p99 ms | Main acceptance s | #94 acceptance s |
| ----- | ------------: | ----------------------: | -------------------: | ------------------: | ----------------: | ---------------: |
| 1     |         61.96 |                   37.48 |               229.77 |              288.12 |            474.42 |           415.28 |
| 2     |        174.50 |                  102.29 |                38.57 |              112.99 |            117.64 |           175.76 |
| 3     |        210.55 | deadline during warm-up |                25.71 |                   — |            243.72 |           185.23 |

Acceptance duration is its internal total through cleanup. Every completed acceptance reported zero errors and met its count, committed-text, snapshot, write-volume and retained-memory assertions. Changed rows per delta were 0.175–0.181 and WAL bytes per delta 828–873. The main and baseline processes also lingered roughly 60 seconds after the completed report; diagnostic handle inspection found a remaining native WebSocket client socket. The acceptance fixture now uses the same `ws` client as the throughput fixture.

| Round | Main acceptance process CPU s | #94 process CPU s | Main retired instructions, billions | #94 retired instructions, billions |
| ----- | ----------------------------: | ----------------: | ----------------------------------: | ---------------------------------: |
| 1     |                        107.90 |             75.08 |                              781.27 |                             788.75 |
| 2     |                         66.65 |             80.31 |                              766.00 |                             778.65 |
| 3     |                         85.39 |             75.78 |                              780.83 |                             784.75 |

Work retired is within about 3% across all six runs while wall time varies by multiples. CPU time is also sensitive to scheduling/cache contention here, so it was retained as diagnostic evidence rather than substituted for the actual socket-delivery floor.

Separate `node --cpu-prof` runs of the full short source workload on both checkouts found the same dominant work: SQLite transactions, the retained-heap observer's `queryObjects`, idle time and GC. Main's profile had 14,369 samples (4,165 idle, 1,242 `queryObjects`, 263 GC); #94 had 16,660 (7,332 idle, 1,951 `queryObjects`, 383 GC). Profiling runs themselves varied from 44.17 to 344.30 events/s and are excluded from headline comparisons. There was no newly introduced dominant JavaScript stack to repair.

## Web before

The original million-item long-thread journey was run three times per checkout, serially alternating revisions, with all six rounds and the same 2,000 turns, 48 subagents and 20 live items/s. Round 1 on each checkout additionally captured Chromium tracing; rounds 2 and 3 were uninstrumented.

| Round | Main longest task ms | #94 longest task ms | Main interaction p95 ms | #94 interaction p95 ms | Main peak DOM nodes | #94 peak DOM nodes |
| ----- | -------------------: | ------------------: | ----------------------: | ---------------------: | ------------------: | -----------------: |
| 1     |                  313 |                   0 |                      88 |                     64 |               1,078 |              1,063 |
| 2     |                   51 |                   0 |                      80 |                     64 |               1,071 |              1,063 |
| 3     |                    0 |                   0 |                      64 |                     64 |               1,078 |              1,063 |

The single failing task's trace reports `ThreadControllerImpl::RunTask` at 313.37 ms wall duration and 5.49 ms thread duration. Its animation-frame callback took 309.37 ms wall and 3.03 ms thread time. This is evidence of a scheduling interruption, not 313 ms of renderer computation. Main retained growth was 1.56–2.13 MB; #94 was 1.96–2.09 MB, all below the unchanged 4 MB limit.

## Measurement changes and after

Only timing failures get one complete repeat. Every accepted attempt must independently pass all original budgets; no averaging, workload reduction, timeout increase or budget change is involved. Persistent timing failures still fail. Resource, correctness, schema and ordinary subprocess failures never repeat. Assertion failures are reported before acceptance cleanup so a later timeout cannot conceal them.

The observer now filters asynchronously delivered browser records by their entry start time after reset. The existing deliberate 120 ms detector checks that a real post-reset blocker still registers. Worker telemetry uses creation/exit events and the observed worker tree instead of a 1.5-second file-age heuristic: terminated workers remain excluded even if their final files are recent. Missing telemetry for an observed live worker fails.

The raw paired measurements are in [perf-regression-measurements.json.gz](perf-regression-measurements.json.gz). The after table below records real validation results, including failures under continued host saturation; a retry does not make an overloaded host pass by definition.

| After run         | Result                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon 1          | Both acceptance attempts exceeded 180 s; gate failed.                                                                                                                                                                                                                 |
| Daemon 2          | Acceptance completed in 175.25 s with zero errors. First throughput sample: 233.26 events/s, p99 21.18 ms, shutdown 8,730 ms. Repeat: 211.24 events/s, p99 26.63 ms; resource check rejected three recent worker files. This prompted the lifecycle-count correction. |
| Daemon 3          | Both acceptance attempts exceeded 180 s; gate failed.                                                                                                                                                                                                                 |
| Complete web gate | Passed bundle, accelerated soak, browser interactions, two-minute memory soak and million-item journey. Long-thread: longest task 0 ms, p95 72 ms, peak DOM 1,078, retained growth 1.73 MB. Memory soak: page +1.0 MB, worker +0.9 MB.                                |

Main subsequently merged #113 and #116 during the investigation. The final branch was rebased onto `8dd7f00aa8d60b5e3b3c36116bf756014253ca6f`; the paired before measurements above retain their original revision identities.

| Final validation on rebased main       | Result                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full gate                              | Both acceptance attempts exceeded 180 s under sustained load.                                                                                                                                                                                                                                                                |
| Short workload with original outer cap | Compilation completed in 8.06 s; the short workload reached its 35 s deadline during warm-up.                                                                                                                                                                                                                                |
| Web before selection acknowledgment    | One ordinary run and one trace run failed waiting for checkpoint 64; neither was automatically repeated. Reading the selected turn before Enter made both diagnostic journeys reach all six targets. The benchmark now asserts that visible selection before Enter, keeping all original text/render assertions and budgets. |
| Instrumented web timing repeat         | First sample: p95 120 ms / longest 439 ms. Repeat: p95 112 ms / longest 53 ms. The gate rejected the persistent p95 violation.                                                                                                                                                                                               |
| Final ordinary web long-thread gate    | Passed: p95 64 ms, longest 0 ms, peak DOM 1,064, retained growth 1.77 MB.                                                                                                                                                                                                                                                    |

The additional rebased-head trace found a largest renderer task of 278.46 ms wall / 3.97 ms thread CPU. None of the eight largest renderer tasks used more than 42.44 ms thread CPU. This supports scheduling contention rather than a new expensive renderer stack. The selector failure was a separate benchmark synchronization issue: key dispatch was assumed to mean the selection had committed. Waiting for the displayed selection adds an assertion; it does not repeat selector failures or omit any journey step.

A completed daemon diagnostic confirmed one live idle worker, 14 OS threads, idle RSS 227.61 MiB, p99 18.78 ms, startup 4,372 ms, shutdown 167 ms, retained heap -0.91 MiB and RSS +3.30 MiB. Its throughput was 256.59 events/s, below the 300 floor. That diagnostic overlapped the instrumented web journey and used the standalone harness’s existing inner deadline; it is excluded from paired performance comparisons and does not claim a passing 35 s gate.

A final complete gate was started after host load dropped. Its daemon stage passed without a repeat: **398.25 events/s** (32.7% above the unchanged 300 floor), p99 **6.43 ms**, startup **882 ms**, shutdown **287 ms**, one idle worker and idle RSS **226.87 MiB**. Retained heap fell 2.62 MiB and RSS grew 1.56 MiB. Acceptance completed in **73.94 s**, with zero errors and all count, write-volume, snapshot and retention assertions passing.

The **complete `bun run check:perf` passed with exit code 0**, including all web gates. Its final long-thread journey reported **0 ms longest task**, **88 ms p95**, **1,064 DOM nodes** and **1.93 MB retained growth**. No stage needed a retry in this passing run. All original budgets, per-attempt deadlines and workloads remain unchanged.

Formatting, lint, typecheck, file size, dependency boundaries and seven targeted tests passed. The tests cover one timing outlier, a persistent slowdown, correctness/resource fail-fast, nested worker liveness, missing telemetry and retirement of a real worker.

## Reproduction

Use separate installed checkouts and build the workspace native addon before comparing. Run each revision serially, alternating order, rather than concurrently adding benchmark load:

```sh
bun run check:perf
node apps/daemon/bench/compile.ts --output=/tmp/ace-perf-bundle
node apps/daemon/bench/measure.ts --entry=/tmp/ace-perf-bundle/ace.mjs --idle-ms=7000 --soak-ms=5000 --warmup-cycles=8 --collect --collect-workers --fresh-cycles --output=/tmp/ace-perf-sample.json
node --expose-gc apps/daemon/bench/long-thread-reliability.ts
bun run --filter @ace/web-perf long-thread
```

For CPU profiles, pass a Node wrapper through `measure.ts --node=PATH` that invokes `node --cpu-prof --cpu-prof-dir=OUTPUT "$@"`; the flags then also reach the daemon and worker isolates. Profiling overhead makes those runs diagnostic. Chromium's `Tracing.start` with `toplevel,devtools.timeline,v8` records wall and thread durations for comparison. Keep uninstrumented repeats beside the traced observations.
