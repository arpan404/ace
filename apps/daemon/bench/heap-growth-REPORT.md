# Daemon heap growth with use (2026-11-11)

The question: the live daemon's main JS heap was 80 MB fresh and 267 MB after 11 hours with four
sessions (measured 2026-10-24 on 0.0.10, on Node, before the Bun move and before the git config,
Zod and simulator-frame fixes). Does anything in the daemon retain memory per thread, per session,
per event or per connection without a bound?

## Method

`measure.ts` against a real daemon with the scripted provider: no provider CLI, no quota. Every run
uses `--idle-ms=3000 --fresh-cycles --collect --soak-ms=60000` and eight warm-up cycles, unless
stated. `--collect` forces GC before the two retention samples; `ACE_PERF_HEAP_SNAPSHOTS` writes a
heap snapshot at each one. The snapshots were diffed by object type, by property signature and by
retainer path. "Threads" counts the fresh threads made during the soak only (16 per cycle).

Source runs (`bun apps/daemon/bench/measure.ts …`, names kept for the diff):

| Workload (extra flags)                                    | Threads | Retained heap (MB) | Per thread |
| --------------------------------------------------------- | ------: | -----------------: | ---------: |
| Fresh threads, nobody reads them (none)                   |   1,840 |        65.8 → 65.4 |     −233 B |
| A client opens each thread, never settles (`--subscribe`) |   1,600 |        68.6 → 74.0 |    3,393 B |
| …and settles each (`--subscribe --settle`)                |   1,824 |        67.4 → 68.7 |      740 B |
| …with 200 deltas per thread (`--cycle-events=200`, 90 s)  |     288 |        66.8 → 67.3 |    1,573 B |
| …reconnecting every cycle (`--reconnect`)                 |   1,776 |        67.7 → 70.6 |    1,621 B |

Bundled runs (`bun apps/daemon/bench/compile.ts --output=.ace-dev/heap-bundle`, then the same
flags with `--entry=.ace-dev/heap-bundle/ace.mjs`, no snapshots):

| Workload                           | Threads | Retained heap (MB) | Retained RSS (MB) | Peak unforced heapUsed (MB) |
| ---------------------------------- | ------: | -----------------: | ----------------: | --------------------------: |
| Fresh threads only                 |   2,144 |        69.8 → 61.6 |         260 → 230 |                         275 |
| `--subscribe`                      |   1,888 |        71.9 → 71.5 |         269 → 264 |                         266 |
| `--subscribe --settle`             |   1,984 |        71.3 → 66.1 |         250 → 249 |                         282 |
| `--subscribe --settle --reconnect` |   1,696 |        71.4 → 67.3 |         262 → 246 |                         273 |

Retained heap does not grow in any bundled run. The bundled `--subscribe` run did not show the
source run's 3.4 KB per unsettled thread; it was not investigated further (one run each, and Bun's
collector scans the stack conservatively, so a few MB either way is within run-to-run noise).

**Unforced `heapUsed` is mostly garbage.** Between collections the bundled daemon's `heapUsed`
climbs from about 72 MB to 266–282 MB within a minute of this workload, then falls back below
90 MB when the collector runs. A heap figure read without forcing GC (the soak samples, an
inspector's "used" without a collection, `process.memoryUsage()` in a live daemon) is mostly garbage
not yet collected, not retention. The 267 MB live figure may be partly this; unverified, since that
reading was taken on Node and its GC state is unknown.

## What grows, and why it stays

- **Unsettled threads, by design.** A thread with no `settledAt` is live, and the thread-list window
  returns every live thread in full (`SidebarIndex.window` → `active`), so the Inbox subscription
  holds each one, plus its placed copy in `PlacedEntries`. That is the 3.4 KB per thread in the
  `--subscribe` run. A person who settles threads keeps it at their Inbox's size; the bench never
  settled anything until `--settle`.
- **The sidebar index, one record per thread that exists.** `SidebarLive.index` keeps each thread's
  facts and its place in two ordered trees (all projects, and its project), so a window update costs
  the changed rows, not a scan. Per settled thread the snapshot diff shows one facts object (112 B),
  two tree nodes (48 B each) and its strings, about 400 B of data. It is sized by the threads in the
  database, not by uptime, and a deleted thread leaves it. The rest of the 740 B is JIT code
  (`FunctionCodeBlock` grew 0.7–2.2 MB within each soak and is not per thread).
- **Deltas retain nothing per event.** 57,600 deltas added 0.45 MB, the same as 288 threads' index
  records.
- **Reconnects retain nothing per connection.** 111 reconnects: the growth over the settled run is
  `FunctionCodeBlock` (+2.2 MB), and the data delta is the same index records (`server.ts` removes a
  closed socket from `receivers`).
- **Bounded caches fill to their bounds:** the thread cache (256 entries / 16 MiB of column bytes),
  the read cache (512 / 8 MiB), sidebar pages (16 / 4 MiB), statement caches, the engine record
  cache. List entries went from 292 to 547 objects in the settled run as the thread cache filled to 256.
- **Thread titles** keep every id they tried to title (`ThreadTitles.attempted`), a few dozen bytes
  per thread. Forgetting one would let it be titled again through the utility model, so it is not
  evicted.

Nothing was bounded or changed in the daemon: no unbounded per-thread, per-event or per-connection
retention showed up on these paths, and the two that grow (the Inbox and the sidebar index) are
correct as they are.

## Not covered

The 267 MB live heap remains unexplained by these workloads. They don't exercise real adapters
(their translators and workers), long threads with large tool output, the browser and simulator
paths, forge, search over a large history, or the 9.3 GB events database that live run had. The
earlier figure was taken on Node before #1417 (the git config facts cache alone held up to about
57 MB), #1641 (per-call Zod parsers) and the Bun move. A fresh measurement of a long-running daemon
on current main is the next step; it needs the owner's agreement, since a heap snapshot pauses the
daemon.
