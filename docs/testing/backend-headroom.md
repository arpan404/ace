# Backend headroom measurements

2026-10-06, macOS arm64, Node 26.8.1, Bun 1.4.0. Budgets are unchanged.

## Worker bundles

`node tools/web-perf/src/bundle.ts --analyze` builds into a temporary directory
and weighs each worker's complete static and lazy import closure with gzip level 9.
The before build includes `thread.move`, so the comparison isolates the budget work.

| Bundle                                | Before, KiB | After, KiB | Budget, KiB | After headroom, KiB |
| ------------------------------------- | ----------: | ---------: | ----------: | ------------------: |
| client-worker, including lazy chunks  |        68.8 |      67.99 |          73 |                5.01 |
| machine-worker, including lazy chunks |        69.9 |      67.83 |          73 |                5.17 |

Both entries use the same core/services chunk policy and startup guard. Pure schema
initializers let unused worker envelope constructors disappear; shared target shapes
avoid constructing intermediary schemas. Unused Zod methods and introspection
getters keep explicit failures through a shared diagnostic factory. The actual
protocol, worker and page schemas are compared with the unoptimized schemas on
recorded fake-daemon traffic, valid inputs and malformed variants.

The initial page is 253.11 KiB, CSS 20.78 KiB, and the largest route is below its
138 KiB budget. Analyzer files are distinct for each worker; neither report can
silently overwrite the other.

## Daemon startup and RSS

The source startup trace exposed eager `@opencode/client`, `tar`, `tar-stream` and
both installed versions of `yauzl`. The idle import guard now rejects those libraries
and the Claude, Pi, Cursor and OpenCode session modules, in the main isolate and
startup workers. It passes after these changes. Archive extraction and support export
load their libraries on use. OpenCode's client loads on server readiness; adapter
metadata and input normalization use narrow public exports, while session modules
load when their provider is selected or opened.

After the merge gate, Pi registration was restored to its synchronous contract:
the narrow `@ace/adapter-pi/adapter` export registers metadata immediately and
imports session and fork I/O on first use. The daemon process regression file
opens all eight provider paths against fake CLI/SDK processes. CommonJS archive
libraries must be accessed through the default export of their lazy imports;
named exports that work in Node source runs can disappear in the esbuild ESM
artifact. Standalone release tests cover support export with thread history and
approved TAR/ZIP installation without a checkout. These fixes retain laziness.

The target remains at least 20 MiB below the 256 MiB idle RSS budget. This target
has **not been verified** here. Before/after CLI bundles were prepared in `/tmp`,
using the release bundler. Host load repeatedly exceeded 15, including 38.73 and
59.06 immediately before paired sampling, so the RSS harness deferred both samples.
An earlier source-only measurement was stopped after noticing load 26.40; it is
not evidence for a before value. Browser timing and the combined performance gate
were also deferred. Run both samples under load below 15 with isolated homes and
an empty executable path; `apps/daemon/bench/measure.ts` supplies that isolation:

```sh
node apps/daemon/bench/compile.ts --cli --output=/tmp/ace-headroom-before
# Build the after revision into another temporary directory.
node apps/daemon/bench/measure.ts --idle-only --entry=/tmp/ace-headroom-before/ace.mjs --idle-ms=7000 --output=/tmp/ace-headroom-before.json
node apps/daemon/bench/measure.ts --idle-only --entry=/tmp/ace-headroom-after/ace.mjs --idle-ms=7000 --output=/tmp/ace-headroom-after.json
```

## Streamed rate

The synthetic source accrues fractional events from elapsed monotonic time, then
pumps whole events on an 8 ms timer. The old measurement divided the latest decoded
batch counter by a page-clock interval whose endpoints could fall between batches.
At 5,000 events/s, one 40-event batch shifts a 12-second report by about 3.3 events/s.
That explains the few-event rate variation without demonstrating lost throughput.

Counters now carry their worker delivery timestamps. The rate pairs counter and
timestamp differences between completed batches. It still counts decoded transcript
events once, excluding sidebar duplicates; it does not count generated events.
Main-thread latency and long-task measurements keep their page-clock interval.
A deterministic browser test injects offset page and batch clocks and confirms the
captured rate remains 5,050 events/s; a window with no new deliveries reports zero.
The existing source workload and 5,000 events/s budget are unchanged. A live rate
comparison awaits the low-load browser benchmark.
