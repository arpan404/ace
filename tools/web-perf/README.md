# Web performance gates

`bun run --filter @ace/web-perf check` runs the bundle budgets, accelerated client soak,
browser interactions, retained-memory streaming and the million-item long-thread journey.
The limits live in `src/budgets.ts` and ADR 0056.

The long-thread journey keeps all six rounds, 2,000 indexed turns, 48 subagent threads and
20 live items per second. A run that exceeds only readiness, interaction or long-task timing
budgets gets one complete repeat in a fresh browser. Both samples are printed. A second
timing failure fails the gate. DOM or heap violations, selector failures, exceptions and
mixed resource/timing failures fail immediately. There is no best-of-many loop or averaging.
Every accepted run must meet the unchanged 200 ms longest-task, 100 ms interaction-p95,
10% long-task-share, 1,500-node and 4 MB retained-growth limits.

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

Review verification is static only by owner instruction. The new real-browser tests cover queued pre-reset task and event records, a post-reset blocker, delayed Home/End commits and transcript movement. They are written but **not executed (tests run at merge)**; updated performance numbers and preview overlap verification **need run at merge**. No product UI files were edited.
