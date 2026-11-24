# Per-switch runs (2026-11-23)

Same tree, workload and machine as `2026-11-23-rust-switches.md`, run one switch at a time:
two adjacent OFF/ON pairs per variant, in the order (a) claude translator, (d) git refs,
(b) store, (c) store + long reads. Every run is a full standard run on its own throwaway home.

Gating: each run waits for the 1-minute load under 30 (`sysctl -n vm.loadavg`, checked every
30 s), relaxing to under 45 rather than skipping the run; a run whose 5 s samples pass 60 is
discarded and redone. Loads below are 1-min at run start → the highest 5 s sample during that
run.

## Confirmation, per run

`lsof` maps `libace_daemon_node.dylib` in every ON run and in none of the OFF runs (max
`addonMaps` 1 vs 0 on all 16 runs). The daemon's `ps eww` environment carries exactly the
variant's switches. OFF halves pass no switch at all.

## (a) `ACE_TRANSLATORS=claude`

Loads: OFF 45→43, 27→25; ON 21→54, 16→22.

| metric (median of 2)     | OFF                 | ON                  | change              |
| ------------------------ | ------------------- | ------------------- | ------------------- |
| idle cpu%                | 0.90                | 0.89                | −0.8%               |
| idle heap                | 46.18               | 46.29               | +0.2%               |
| idle RSS / footprint     | 218.66              | 219.06              | +0.2%               |
| startup ms               | 482                 | 492                 | +2.0%               |
| newThreads cpuMs         | 154.6               | 158.7               | +2.6%               |
| sameThread cpuMs         | 111.5               | 113.9               | +2.2%               |
| longText cpuMs           | 1117                | 1102                | −1.3%               |
| new / same / long cpuPer | 6.10 / 4.39 / 43.91 | 6.16 / 4.42 / 42.65 | +0.9 / +0.7 / −2.9% |
| longText tx              | 286.0               | 290.2               | +1.5%               |

Raw runs: heap 46.19/46.18 vs 46.36/46.23; longText cpuMs 1215/1019 vs 1120/1085; long tx
285.7/286.3 vs 277.7/302.7. Nothing here separates the two sides: pair 1 moved CPU down (−8%)
and pair 2 up (+5–12%), and the memory columns are flat. **No measurable effect.**

## (d) `ACE_GIT=refs`

Loads: OFF 20→24, 17→21; ON 14→21, 12→33.

| metric (median of 2)     | OFF                 | ON                  | change               |
| ------------------------ | ------------------- | ------------------- | -------------------- |
| idle cpu%                | 0.91                | 0.93                | +1.8%                |
| idle heap                | 46.16               | 46.27               | +0.2%                |
| idle RSS / footprint     | 218.80              | 219.63              | +0.4%                |
| startup ms               | 503                 | 618                 | +22.9%               |
| newThreads cpuMs         | 146.6               | 164.1               | +11.9%               |
| sameThread cpuMs         | 102.0               | 117.3               | +14.9%               |
| longText cpuMs           | 1086                | 1255                | +15.6%               |
| new / same / long cpuPer | 6.18 / 4.30 / 45.76 | 5.56 / 3.93 / 42.18 | −10.0 / −8.6 / −7.8% |
| longText tx              | 313.0               | 294.8               | −5.8%                |

Raw runs: heap 46.16/46.15 vs 46.37/46.17; long tx 305/321 vs 276/313. **Unresolved**: raw
CPU rises 12–16% while the normalized figure _falls_ 8–10%, because the ON runs' calibration
was 25.8% slower (23.4/24.1 ms vs 25.5/34.2 ms). Heap, RSS and new/same-thread transactions do
not move at all, which is what this switch should look like: it never touches the store.

## (b) `ACE_STORE=native`

Loads: OFF 27→27, 44→45; ON 18→34, 23→30.

| metric (median of 2)     | OFF                 | ON                  | change               |
| ------------------------ | ------------------- | ------------------- | -------------------- |
| idle cpu%                | 0.92                | 0.95                | +3.8%                |
| idle heap                | 45.70               | 44.59               | −2.4%                |
| idle RSS / footprint     | 211.11              | 227.07              | +7.6%                |
| startup ms               | 497                 | 766                 | +54.2%               |
| newThreads cpuMs         | 194.7               | 177.3               | −8.9%                |
| sameThread cpuMs         | 127.2               | 126.5               | −0.6%                |
| longText cpuMs           | 1103                | 1254                | +13.7%               |
| new / same / long cpuPer | 7.09 / 4.63 / 40.26 | 5.91 / 4.22 / 41.80 | −16.5 / −9.0 / +3.8% |
| longText tx              | 311.3               | 324.8               | +4.3%                |

Raw runs: heap 46.10/45.30 vs 44.58/44.59 (separated); RSS 208.9/213.3 vs 226.1/228.1
(separated); long tx 312.7/310.0 vs 325.3/324.3 (separated); long cpuMs 1123/1083 vs
1277/1231 (separated). **The store is the switch with a real effect**: 1.1 MiB less JS heap,
16 MiB more RSS, and ~14% more long-text CPU with ~4% more transactions. New-thread CPU is
unresolved: pair 2's OFF run (load 44→45) measured 229/142 ms against 160/112 ms in pair 1, so
its OFF median is inflated. Startup +54% rests on both ON runs (653/880 ms) but does not
reproduce in (c) below, so treat it as unresolved.

## (c) `ACE_STORE=native ACE_STORE_READS=long`

Loads: OFF 38→37, 31→46; ON 27→30, 33→34.

| metric (median of 2)     | OFF                 | ON                  | change                |
| ------------------------ | ------------------- | ------------------- | --------------------- |
| idle cpu%                | 0.94                | 0.96                | +2.3%                 |
| idle heap                | 46.26               | 44.68               | −3.4%                 |
| idle RSS / footprint     | 199.59              | 217.34              | +8.9%                 |
| startup ms               | 555                 | 535                 | −3.6%                 |
| newThreads cpuMs         | 169.2               | 184.7               | +9.1%                 |
| sameThread cpuMs         | 125.2               | 121.9               | −2.7%                 |
| longText cpuMs           | 1229                | 1266                | +3.0%                 |
| new / same / long cpuPer | 5.83 / 4.31 / 41.93 | 7.15 / 4.70 / 48.64 | +22.8 / +8.9 / +16.0% |
| longText tx              | 314.8               | 328.5               | +4.3%                 |

Raw runs: heap 46.33/46.19 vs 44.68/44.69 (separated); long tx 306.0/323.7 vs 331.7/325.3.
`ACE_STORE_READS=long` adds nothing visible on top of the store: heap and long-text
transactions land where (b) landed, and the CPU columns swing with load (OFF 1091/1367,
ON 1182/1349) and calibration (24.3/35.1 vs 24.1/28.0). RSS is 187.4 in one OFF run, which
makes +8.9% overlap.

## What this says about the all-on result

The extra cost measured with all four switches on is the **store**: it alone gives −2.4% idle
JS heap, +7.6% RSS and +4.3% long-text transactions, and +13.7% long-text CPU in a clean pair.
The claude translator is neutral, and git refs changes no memory or transaction count; its CPU
question cannot be settled on this machine. `ACE_STORE_READS=long` is too small to separate
from the store at this sample size.

## CPU profile of an all-on run

One standard run with the four switches on and one with none, `sample` on the daemon for 25 s
during the same-thread phase (loads 56→68 for the pair, so the numbers below are for shape, not
size). The ON run's profile lists 556,147 thread samples, 94,926 of them (17.1%) with
`libace_daemon_node` on the stack; the OFF run lists 490,942 with none.

That 17% is not CPU. Almost all of it is a pool of `ace-git-0…N` threads that exist only with
the switches on, whose whole stack is inside the dylib and which sit on
`__psynch_mutexwait`/`_dispatch_semaphore_wait_slow`. On the main thread, where the daemon's
work happens, 1,167 of 11,697 samples (10.0%) are inside the addon. Real work leaves under the
addon add up to little: `pwrite` 230, `fsync` 59, `fcntl` 43, `pread` 17.

The Bun binary in this build has no symbols, and its JavaScriptCore is linked into it, so
`sample` cannot split JS from the runtime either way. The profile shows where the native side
sits (parked worker threads, a tenth of the main thread) but not the JS half; the CPU-per-turn
numbers above remain the measurement.

## Noise, and three discarded passes

- Calibration across these 16 runs ranged 23.4–35.1 ms (50%), which moves the normalized CPU
  columns by up to 20% in the opposite direction from the raw ones. The raw `cpuMs` columns and
  the memory/transaction columns are the ones to read here.
- The same-store startup difference is +54% in (b) and −3.6% in (c); the startup probe is three
  restarts of a just-finished root, so it is the noisiest number in the set.
- Variant (c) needed three passes: the first ran during a build storm (forced at load 319, 282, 239) and was discarded; the second passed the ON environment to its OFF halves, which made
  both sides native (idle heap 44.7 on both) and was discarded; the third is above.
- (c) pair 2's ON ran about five minutes after its OFF half (31→46 vs 33→34).

Raw measurements and the discarded passes are under
`.ace-dev/daemon-bench/rust-switches/per-switch/` (`discarded/forced`, `discarded/redo`,
`discarded/mixed-env`).
