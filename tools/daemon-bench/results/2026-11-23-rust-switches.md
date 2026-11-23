# Daemon benchmark: Rust switches off vs on (2026-11-23)

Measured with `tools/daemon-bench` on the merged tree (`1a6f094f82`, branch
`ace/bench-daemon-rust-switches-off-vs-on`): 400 seeded threads, standard workload, daemon on
Bun 1.4.4, fake `claude` CLI replaying recordings (no provider quota). Three OFF and three ON
runs, alternating, one bench at a time.

- **OFF**: no `ACE_*` switches.
- **ON**: the four switches `ACE_STORE=native`, `ACE_STORE_READS=long`,
  `ACE_TRANSLATORS=codex,claude,cursor,opencode,pi,acp` and `ACE_GIT=refs`, with the three
  addon paths naming `native/daemon/target/release/libace_daemon_node.dylib` (built with
  `cargo build --release --locked -p ace-daemon-node`, rustup 1.95.0, `CARGO_BUILD_JOBS=4`).

## Bench change

`daemonEnv` built an environment from nothing, so no switch could reach the daemon. It now
forwards seven names from the caller's environment — the four switches above and the three
addon paths — and nothing else (`tools/daemon-bench/src/daemon.ts`). The rest of the
environment stays clean.

## Is ON really native?

- `ps eww` of every ON daemon shows all four switches and the three addon paths in its own
  environment; every OFF daemon shows none of them.
- `lsof` of every ON daemon maps `native/daemon/target/release/libace_daemon_node.dylib`
  (27–28 of 28 samples per run); every OFF daemon maps it in 0 of 27 samples.
- Probe: `ACE_STORE_READS=long` without `ACE_STORE` makes the daemon refuse to start
  (`ACE_STORE_READS needs ACE_STORE=native`), so the pass-through reaches the daemon.
- The store, translator and git addons never fall back: with a switch on and the addon
  missing, the load throws (`native-sqlite.ts`, `adapter-claude/native-translator.ts`,
  `git/native-common.ts`). A run that completes turns used the native path.
- Not directly confirmed: `ACE_GIT=refs` selects per call and the per-op log
  (`ACE_GIT_OP_LOG`) is not forwarded. The git addon is proven loaded at startup (a
  `GitService` with any part on refuses to construct without it); per-call completion is not
  logged in this setup.

Startup is spawn-to-endpoint (`startDaemon`), measured as the median of three starts on the
run's kept root, immediately after that run. The bench records startup memory but not time.
`run.ts` does not report event throughput; `transactionsPerTurn` and each phase's `wallMs` are
what it reports.

## Medians (n=3 each)

| metric                         | OFF     | ON      | change |
| ------------------------------ | ------- | ------- | ------ |
| idle cpuPercent (% of a core)  | 0.89    | 0.96    | +7.3%  |
| idle heapUsed                  | 46.1 M  | 44.9 M  | −2.7%  |
| idle RSS                       | 210.3 M | 227.4 M | +8.1%  |
| idle footprint                 | 209.6 M | 227.4 M | +8.5%  |
| startup (ms)                   | 476.3   | 474.6   | −0.3%  |
| newThreads cpuMsPerTurn        | 160.5   | 176.0   | +9.6%  |
| sameThread cpuMsPerTurn        | 103.8   | 124.5   | +19.9% |
| longText cpuMsPerTurn          | 1033.0  | 1267.0  | +22.6% |
| newThreads cpuPerTurn          | 6.59    | 6.96    | +5.5%  |
| sameThread cpuPerTurn          | 4.37    | 4.77    | +9.1%  |
| longText cpuPerTurn            | 42.96   | 48.50   | +12.9% |
| newThreads transactionsPerTurn | 118.00  | 118.00  | 0.0%   |
| sameThread transactionsPerTurn | 81.05   | 81.03   | −0.0%  |
| longText transactionsPerTurn   | 313.00  | 325.67  | +4.0%  |

Run-to-run spread (min–max):

| metric                  | OFF           | ON            |
| ----------------------- | ------------- | ------------- |
| idle cpuPercent         | 0.85–0.93     | 0.92–0.96     |
| idle heapUsed           | 46.0–46.2 M   | 44.8–45.0 M   |
| idle RSS                | 194.0–214.3 M | 225.1–227.6 M |
| startup ms              | 474–482       | 471–593       |
| newThreads cpuMsPerTurn | 160.4–165.3   | 166.7–188.1   |
| sameThread cpuMsPerTurn | 101.0–110.5   | 114.0–130.9   |
| longText cpuMsPerTurn   | 1021.3–1151.2 | 1074.9–1290.6 |
| longText transactions   | 271.7–315.0   | 274.7–326.0   |

## Adjacent pairs (normalized CPU per turn, load average 1-min at start → end)

| pair | OFF load     | ON load     | newThreads        | sameThread         | longText           |
| ---- | ------------ | ----------- | ----------------- | ------------------ | ------------------ |
| 1    | 23.5 → 22.1  | 22.1 → 34.1 | 6.56 → 6.74 +2.8% | 4.38 → 4.77 +8.7%  | 45.7 → 48.5 +6.2%  |
| 2    | 33.1 → 32.2  | 32.2 → 22.4 | 6.75 → 7.35 +9.0% | 4.37 → 5.12 +17.1% | 43.0 → 50.4 +17.4% |
| 3    | 111.8 → 40.2 | 40.2 → 31.2 | 6.59 → 6.96 +5.5% | 4.15 → 4.76 +14.6% | 42.4 → 44.9 +5.7%  |

All nine pair comparisons are slower with the switches on, so the direction does not depend on
load order. Pair 3 ran in a noisier window and its OFF half started at a much higher load than
its ON half; it is the least comparable pair, and it still favours OFF.

## Per run

| run   | idle cpu% | idle heap | idle RSS | startup ms (3 starts) | calibrationMs |
| ----- | --------- | --------- | -------- | --------------------- | ------------- |
| off-1 | 0.85      | 46.1 M    | 194.0 M  | 525, 467, 474         | 25.2          |
| on-1  | 0.92      | 44.8 M    | 227.4 M  | 593, 532, 629         | 26.1          |
| off-2 | 0.93      | 46.0 M    | 210.3 M  | 470, 492, 476         | 23.8          |
| on-2  | 0.96      | 45.0 M    | 225.1 M  | 471, 530, 468         | 25.6          |
| off-3 | 0.89      | 46.2 M    | 214.3 M  | 482, 483, 448         | 24.3          |
| on-3  | 0.96      | 44.9 M    | 227.6 M  | 438, 475, 488         | 24.0          |

Phase wall time (turn latency, mostly fake-CLI pacing):

| run   | newThreads | sameThread | longText |
| ----- | ---------- | ---------- | -------- |
| off-1 | 11.2 s     | 20.4 s     | 34.8 s   |
| on-1  | 12.1 s     | 22.9 s     | 35.4 s   |
| off-2 | 11.8 s     | 19.2 s     | 34.8 s   |
| on-2  | 12.0 s     | 21.7 s     | 35.0 s   |
| off-3 | 11.2 s     | 19.1 s     | 37.4 s   |
| on-3  | 11.0 s     | 19.4 s     | 37.3 s   |

Heap after two forced GCs at the end of each phase was 91.0–95.3 M OFF and 86.9–90.9 M ON.

## What the numbers say, and what they do not

- Same-thread and long-text CPU per turn are consistently higher with the switches on
  (+9–20% and +6–17% per pair). Those gaps are larger than the run-to-run spread.
- New-thread CPU (+5.5% on medians) is the size of the pair-to-pair variation; the direction
  is consistent but the size is not settled.
- Idle CPU (+7%) is not separable from noise: the OFF range (0.85–0.93) overlaps the ON range
  (0.92–0.96).
- Idle heap is 2.7% lower with the switches on, and RSS/footprint 8% higher; both separate
  cleanly. Startup is unchanged; on-1's three starts (532–629 ms) are an outlier against
  438–530 ms everywhere else.
- Write transactions are identical for new and same-thread turns. Long-text turns commit about
  4% more with the switches on; off-3's 271.7 is a low outlier (OFF otherwise 313–315), which
  the load during that run plausibly caused through delta-flush batching.
- The ON runs' calibration came out 5% slower (24.0–26.1 ms vs 23.8–25.2 ms), so the raw
  `cpuMsPerTurn` columns are biased slightly against ON; the normalized columns are the
  comparison to trust.

## Discarded

Two attempts at the third pair (15:27 and 15:29) were dropped: ace restarted mid-run and the
1-minute load average reached 216–445 (builds and an iOS simulator workload), and one
orphaned run was still going. The final pair 3 ran 16:07–16:12 with no other bench present
(`benchRuns=1` in every sample) after a 46-minute wait for a window.
