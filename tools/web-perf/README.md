# Web performance gates

`bun run --filter @ace/web-perf check` runs the bundle budgets, accelerated client soak,
browser interactions, retained-memory streaming and the million-item long-thread journey.
The limits live in `src/budgets.ts` and ADR 0056.

`node tools/web-perf/src/bundle.ts --analyze` also prints the client worker's eager and lazy
chunk sizes, package totals and largest retained modules from Rolldown. Module lengths are
before minification; gzip sizes count each emitted chunk once, as the budgets do. The report
asset is emitted only for analysis builds. Every production build checks the worker's static
imports against `forbiddenEagerWorkerModules` in `apps/web/worker-bundle.ts`, reporting the
module name if a cold service, page implementation or duplicate mini schema runtime returns
to the startup path. See [the bundle diet measurements](client-worker-diet.md).

The long-thread journey keeps all six rounds, 2,000 indexed turns, 48 subagent threads and
20 live items per second. A run that exceeds only readiness, interaction or long-task timing
budgets gets one complete repeat in a fresh browser. Both samples are printed. A second
timing failure fails the gate. DOM or heap violations, selector failures, exceptions and
mixed resource/timing failures fail immediately. There is no best-of-many loop or averaging.
Every accepted run must meet the unchanged 200 ms longest-task, 100 ms interaction-p95,
10% long-task-share, 1,500-node and 4 MB retained-growth limits.

The streaming browser journey also gets one complete repeat for a timing violation. Its
throughput floor is 5,000 events/s, including a small shortfall such as 4,997.42. The old
comparison accepted 90% while printing a 5,000 budget. The fixture now supplies 5,050 events/s
to give its timer batches and the page's sampling boundaries margin above the unchanged floor.
This increases the workload; it does not lower the acceptance threshold. Detector and other
correctness failures remain fatal. `browser-budgets.test.ts` verifies that a small shortfall
retries, a repeated shortfall fails, and the exact 5,000 boundary passes.

The perf worker counts decoded transcript event deliveries, excluding snapshots and duplicate
sidebar deliveries, and publishes the count after the client has processed each frame.
`acePerf.events` is this delivered count, rather than the soak daemon's generated sequence.
Reset captures the count and `performance.now()` together in one page task; reading captures
both endpoints together again. The rate uses that count delta and the same `seconds` as the
interaction report. Queued deliveries after the read belong to the next window. A stale start
from before another reset is rejected. The measurement behaviour test injects a clock and
counters to verify that pre-window and post-window deliveries cannot enter the rate.

The literal 4,997.42 also appears in expected-failure budget tests. Those tests previously
printed rejected samples while asserting that the gate rejects them. They now silence their
sample reports so expected rejections cannot look like real browser benchmark failures.

PerformanceObserver delivery is asynchronous. Resetting a measurement clears its values and
sets its start timestamp; entries delivered afterward are filtered by `entry.startTime`.
This keeps queued observations from before the interaction window out of its maximum and
percentiles. The browser gate verifies a deliberate 120 ms task through `readRecord` after
reset, then clears that probe before the actual workload. Natural GC and rendering tasks
within the window still count. Before pressing Enter in the timeline, the journey asserts
that Home/End has visibly committed before reading its starting ordinal, then acknowledges every movement key before advancing. End uses the displayed current turn count, including any new live turn. The requested turn must be visibly selected. Key dispatch alone can precede React’s committed
selection under load; all keyboard inputs, rendering assertions and six rounds still run.

The main/#94 comparison and trace evidence are in
[the investigation report](../../apps/daemon/bench/perf-regression-report.md).
The reproduced 313 ms animation-frame task used 5.49 ms of renderer thread time.
Later unchanged runs reported 51 ms and no long tasks. One repeat handles that isolated
scheduling interruption while leaving sustained slow work red.

The journey retains its reading pauses and all wheel/key/search inputs. It also asserts scroll or window movement, completion of turn steps, selected search-hit counters and transcript highlights, and completion of filtered search results (including valid empty results). Preview runs spawn Vite directly and await its exit before deleting served files or repeating the workload.

The browser process tests resolve the installed Chromium executable in global setup,
before the test runner redirects HOME and cache directories. Profiles and writable state
still use the isolated test home. The measurement test blocks a real click handler:
CDP `evaluate` work does not reliably generate Long Tasks entries. Native Long Tasks
and Event Timing observers acknowledge both the buffered pre-reset delivery and the new
interaction; animation frames or short polling deadlines are not delivery barriers.
Navigation fixtures commit through message channels rather than elapsed-time delays.

The search-hit assertion exposed a missed virtual scroll that the original journey's timed
pauses did not check. Estimated sizes could place a tool-output row outside the rendered range;
later size corrections then left it unmounted. The transcript now includes the focused row
alongside its visible range so the jump can measure it, retaining at most one extra row until
the next focus or return to live. `search-jump.process.test.ts` exercises the production browser
build from live and after historical navigation, asserting both visibility and viewport
intersection. It synchronizes on results and the actual hit, without a timing-only barrier.
Filtered searches can validly return no hits. Their empty listbox has zero height, so the
journey acknowledges its attachment and asserts the visible empty-result explanation.
