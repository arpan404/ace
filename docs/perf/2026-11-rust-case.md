# Where the daemon's time and memory go (the Rust case)

Measured 2026-11-01 on the owner's M-series Mac (16 cores), against the release bundle of
v0.0.15 (no daemon, protocol or projection change between v0.0.15 and the main commit
measured) and the release Node runtime (v26.12.1). No provider CLI ran and no quota was spent:
turns came from the fake `claude` CLI replaying recorded fixtures, and reads ran against an
APFS clone of the owner's real data under a throwaway HOME with an empty PATH. The live daemon
was never touched.

## The short answer

- **The daemon is mostly waiting on SQLite's file I/O and doing session setup, not computing in
  JavaScript.** On the streaming path, JavaScript itself (our code, Zod, JSON) is about a third
  of the main thread's busy time. SQLite syscalls (checkpoint `fsync`, temp-file churn, WAL
  writes) are a quarter to two thirds, depending on the workload and disk contention. Kernel
  time alone is 30% of the daemon's CPU.
- **Reads on real data are bound by SQLite page reads (`pread`), then `JSON.parse`.** Opening a
  9,600-item thread costs about 115 ms of daemon CPU; half of the main thread's time in it is
  `pread`. Zod is 3–22% depending on the read.
- **A Rust rewrite would run the same SQLite, the same `fsync` and the same `pread`.** It would
  not touch the biggest costs. The biggest wins are configuration and design changes that stay
  in TypeScript.
- **Where Rust would clearly win is idle memory and startup.** The idle daemon is 193 MB
  physical footprint with a 68 MB heap, of which about 13 MB is compiled code and about 15 MB
  is Zod schema objects. Of the 0.44 s of main-thread startup work, 59% is loading JavaScript
  (including building schemas). A full port removes those; nothing short of a full port does.
- **The front end is its own cost.** With no daemon behind it, the production web app needs
  about 0.8 s to draw its sidebar and 60 ms to open a small thread; long transcripts scroll at
  60 fps. A faster daemon changes none of that.

## Method

| What                    | How                                                                                                                                                                                                                  | Samples                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Busy load (new threads) | 4 lanes × 6 new threads each, rotating subagent / MCP-call / 300-delta long answer / tool-read fixtures; 3 observer clients watch every running thread and hold the sidebar; one pages and searches a 30-turn thread | 3 V8, 3 native, 5 plain runs  |
| Busy load (same thread) | Same, but each lane keeps one thread and sends 8 turns into it                                                                                                                                                       | 2 V8, 1 native, 4 plain       |
| JavaScript attribution  | Inspector `Profiler` over exactly the busy window, 500 µs sampling, mapped to source through source maps of the same bundle                                                                                          | per V8 run                    |
| Native attribution      | macOS `sample` (1 ms) in 10 s chunks; SQLite / JSON / GC / syscalls split from native stacks                                                                                                                         | per native run                |
| Headline CPU            | `process.cpuUsage()` (and `threadCpuUsage()` for the main thread) with no profiler attached                                                                                                                          | plain runs                    |
| Memory                  | 40-minute soak, samples every 30 s, forced GC every 5 min; heap snapshots of the test daemon at start and end                                                                                                        | 1 run                         |
| Startup                 | Spawn → endpoint file, and spawn → first sidebar served to a fresh client                                                                                                                                            | 5 reps × 2 rounds × 2 bundles |
| Real-data reads         | Clone of `~/.ace/events.sqlite` (17 GB, 908 threads, 287k items, 5.1M events)                                                                                                                                        | 3–30 reps per read            |
| UI                      | Headless Chrome for Testing 1243 via playwright-core 1.64.1; production `vite build` of `--mode fake` / `--mode perf`, and the dev servers for comparison                                                            | 5 reps (prod), 3 (dev)        |

Load average is reported beside every number. The machine was shared with other agents: load
ranged from 7 to 400 during the day. Busy-path CPU per event moved by 50% with load (1.55 ms
at load 9, 3.0 ms at load 350) while the work done (events, transactions) stayed identical,
because threads land on efficiency cores and contend for caches. Treat absolute CPU numbers as
ranges, and the percentage splits (stable across runs) as the main result.

The scripts are in `tools/daemon-bench/src/profile/` (daemon) and
`tools/web-perf/src/rust-case-ui.ts` (UI); each file's header says how to run it.

## 1. Daemon CPU on the streaming path

### Headline

| Workload                     | Load                      | CPU per stored event | CPU per turn | Events per turn | SQLite commits per event |
| ---------------------------- | ------------------------- | -------------------- | ------------ | --------------- | ------------------------ |
| New thread per turn (plain)  | 31                        | 1.83 ms              | 272 ms       | 149             | 0.87                     |
| New thread per turn (plain)  | 62–125 (median of 5 runs) | 2.32 ms              | 345 ms       | 149             | 0.88                     |
| New thread per turn (plain)  | 116–145                   | 2.77 ms              | 411 ms       | 148             | 0.90                     |
| Same thread, 8 turns (plain) | 9–13 (3 runs)             | 1.55–1.93 ms         | 210–262 ms   | 136             | 0.73                     |

A turn here is a full replayed Claude turn: about 140 stored events, with tool calls,
subagent transcripts or a 300-delta answer, delivered to four clients. Starting a new thread
adds roughly 20% (about 90 ms) of per-session setup on top of the turn itself.

Where the CPU runs (same-thread run, load 9, 4,357 events, 6.74 s of CPU):

| Thread                                                  | CPU    | Share |
| ------------------------------------------------------- | ------ | ----- |
| Main thread, user                                       | 3.56 s | 53%   |
| Main thread, kernel                                     | 1.63 s | 24%   |
| Other threads (libuv pool, GC/compile helpers, workers) | 1.55 s | 23%   |

The new-thread workload at load 8 (3,582 events, 6.81 s, 1.90 ms per event) splits the same
way: 30% kernel time, main thread 74%, other threads 26%. Kernel time is mostly the SQLite and
filesystem syscalls below; it is CPU, not just waiting.

### What the main thread is doing (native stacks)

Share of the main thread's sampled busy time. Busy includes being blocked in a syscall.

| Cause                                            | New thread per turn (3 runs, load 100–220) | Same thread (load 11) |
| ------------------------------------------------ | ------------------------------------------ | --------------------- |
| JavaScript (our code, Zod, libraries)  | 24–29%                                     | 14%                   |
| V8 runtime (property lookups, allocation)        | 7–8%                                       | 4%                    |
| Error objects (stack capture)                    | 1–2%                                       | 0.6%                  |
| JSON parse/stringify                             | 3%                                         | 2%                    |
| structuredClone / worker messages                | 3%                                         | 2%                    |
| SQLite engine (query execution)                  | 10–11%                                     | 8%                    |
| **SQLite file I/O (fsync, pwrite, open, pread)** | **17–34%**                                 | **61%**               |
| Filesystem calls (sync fs on the main thread)    | 10–11%                                     | 2%                    |
| Process spawn                                    | 3–10%                                      | 2%                    |
| GC on the main thread                            | 1–2%                                       | 1%                    |
| Sockets, other native                            | 3–5%                                       | 2%                    |

Across the whole process, the main thread is 75–83% of busy samples, the libuv pool 8–18%
(async fs), V8's GC and compile helpers 6–10%, and worker isolates 3–4%.

### What the JavaScript is doing (V8 profiles)

Inclusive share of main-thread profile time (a frame anywhere on the stack), mean of runs:

| Subsystem                                                       | New thread | Same thread |
| --------------------------------------------------------------- | ---------- | ----------- |
| Store layer (`apps/daemon/src/*store*`), incl. its SQLite calls | 42%        | 74%         |
| Engine (`apps/daemon/src/engine/`), incl. what it calls         | 35%        | 59%         |
| Provider adapters (spawn, line reading, translation)            | 10%        | 7%          |
| Zod, from any caller                                            | 8%         | 8%          |
| Server and delivery (`server`, `subscription`, `wire-encoder`)  | 5%         | 3%          |
| `ws` library                                                    | 1.7%       | 0.7%        |
| `packages/core` + `packages/projection` (pure reducers)         | 3%         | 3–4%        |
| Sidebar                                                         | 0.8%       | 1.2%        |

The single biggest frame is `exec` called from `Store.transaction`: BEGIN IMMEDIATE / COMMIT.
It is 11% of the new-thread profile and 40% of the same-thread profile. Each provider frame is
applied in its own `store.atomic` transaction (`engine/actor.ts`), so there are 0.73–0.9
commits per stored event.

Mapping to the causes the owner asked about (new-thread load, approximate share of daemon busy
time and ms per event at the median 2.3 ms):

| Cause                                                           | Share  | ≈ ms per event |
| --------------------------------------------------------------- | ------ | -------------- |
| SQLite: engine + file I/O + commits                             | 30–45% | 0.7–1.0        |
| Session setup: spawn, git, plugin lock, lease files, MCP config | 15–20% | 0.35–0.45      |
| Our JavaScript in engine/store/projection                       | 15–20% | 0.35–0.45      |
| Provider stream decoding                                        | ~10%   | 0.2            |
| Zod validation                                                  | ~8%    | 0.2            |
| WebSocket fan-out, wire encoding, worker messages               | 6–8%   | 0.15           |
| JSON parse/stringify                                            | ~3%    | 0.07           |
| GC (main + helper threads)                                      | 3–5%   | 0.1            |
| Pure projection and status computation                          | ~3%    | 0.07           |

### The SQLite costs, named

From native stacks of the same-thread run (main thread, 28 s window):

| Stack                                                                                                                       | Samples (ms) |
| --------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `fsync` ← `sqlite3WalCheckpoint` ← `sqlite3WalDefaultHook` (auto-checkpoint inside a COMMIT)                                | 2,418        |
| `open` + `pwrite` ← `sqlite3BtreeInsert`/`Delete` (statement journals and temp tables spilling to files: `temp_store=FILE`) | ~2,100       |
| `pwrite` + `fsync` ← `pagerWalFrames` (WAL frames at commit)                                                                | ~690         |
| `pwrite` ← WAL checkpoint                                                                                                   | 448          |

`events.sqlite` runs with `wal_autocheckpoint=256` (a checkpoint every 1 MB of WAL), and that
checkpoint, with its `fsync`, runs synchronously on the main thread inside whichever COMMIT
crosses the threshold. `WalMaintenance` also runs its TRUNCATE checkpoint on the main thread
after 5 s of quiet. `temp_store=FILE` makes SQLite create and delete real temp files for
statement journals during ordinary inserts.

### Session setup, named

Per new thread, on the main thread: `posix_spawn` of the provider CLI, git subprocesses and
`lease-journal` directory scans (`readdir`, `lstat`, `realpath`), the plugin materialization
lock (`withDirectoryLock` opens a fresh SQLite database in rollback-journal mode after four
symlink checks, so it creates, writes and unlinks a journal), the built-in skill process lease
(`writeFileSync` + `fsyncSync` + `renameSync`), a temp MCP config (`mkdtempSync`), and settings
file-watch checks. Together about 15–20% of a new-thread turn.

## 2. Memory

### Idle

| State                               | Footprint  | RSS     | Heap used      | Heap after GC |
| ----------------------------------- | ---------- | ------- | -------------- | ------------- |
| Bare `node`                         | 11 MB      |         |                |               |
| Fresh daemon, empty home (packaged) | 193 MB     | 302 MB  | 77 MB          | 60 MB         |
| Fresh daemon, real 17 GB data       | 243 MB     | 290 MB  | 76 MB          |               |
| After 24 busy turns                 | 376–424 MB | 600+ MB | 88 MB after GC |               |

The idle heap snapshot (68 MB of live objects) splits as:

| Kind                                                                                       | Size                 |
| ------------------------------------------------------------------------------------------ | -------------------- |
| Compiled code (bytecode, metadata, feedback)                                               | 13 MB                |
| Zod schema graph (30,269 schema instances, their internals and ~100k of the 168k closures) | ≈15 MB (upper bound) |
| Strings                                                                                    | 12 MB                |
| Other objects, arrays, contexts, shapes                                                    | ≈28 MB               |

V8 also reports 7.4 MB of script source and 4.1 MB of bytecode outside those object counts. So
roughly 40% of the idle heap is code and schemas, which only a non-JavaScript daemon removes.
The other ~120 MB of idle footprint is V8's reserved heap and code space, worker isolates, the
Node binary's private pages, ICU and SQLite caches.

### Over a 40-minute session

40 minutes, 4 lanes each starting a new thread every ~5 s (4 s of think time), 3 observers,
one pager: 1,694 turns, 2,948 paging rounds, load 4–18. Samples every 30 s; the "after GC"
column forces two full collections.

| Minute | Heap after GC | Heap total | Footprint after GC | RSS after GC | Code space |
| ------ | ------------- | ---------- | ------------------ | ------------ | ---------- |
| 0      | 80 MB         | 84 MB      | 218 MB             | 266 MB       | 7.8 MB     |
| 5      | 103 MB        | 107 MB     | 232 MB             | 560 MB       | 11.1 MB    |
| 10     | 105 MB        | 110 MB     | 234 MB             | 562 MB       | 11.7 MB    |
| 20     | 109 MB        | 114 MB     | 240 MB             | 566 MB       | 12.4 MB    |
| 30     | 112 MB        | 117 MB     | 249 MB             | 575 MB       | 12.4 MB    |
| 40     | 115 MB        | 119 MB     | 234 MB             | 563 MB       | 12.4 MB    |

Between collections, heap used swings 103–143 MB and footprint 300–335 MB.

- **The first 5 minutes add 23 MB of retained heap**: lazily loaded chunks (their source
  strings alone are 7.6 MB), optimized code and filled caches. This is warm-up.
- **After that the retained heap grows linearly, about 0.35 MB a minute** (12 MB over 35
  minutes), roughly 7 KB per thread created. The snapshot diff (90 → 125 MB of live objects)
  is spread thin: +8 MB of strings (171k), +5 MB of plain objects, +10 MB of Set/Map tables
  and arrays, +7 MB of code. The one clearly per-thread retainer is the engine's `Records`
  (`apps/daemon/src/engine/records.ts`): about 1,100 more instances, each with its five
  bookkeeping collections, for the 1,694 threads created. Whether a cap is meant to bound
  them needs a look.
- **The live daemon's 80 → 267 MB heap growth did not reproduce in 40 minutes.** Heap used
  never passed 143 MB. At the soak's rate per thread created, the live daemon's growth would
  need thousands of threads; the live cause is more likely long-lived sessions with large
  transcripts or caches filling to their budgets, which this fake workload doesn't model. A
  heap snapshot of a test daemon replaying a day-long session is the next step.
- **RSS reaches the live daemon's 659 MB within two minutes of load** and then stays flat. RSS
  counts shared pages (the Node binary, mapped code) and freed-but-unreturned allocator pages;
  physical footprint (what Activity Monitor shows) is the better measure, and it settles near
  235–250 MB after a collection.

None of this memory is something a faster language fixes by speed. A Rust daemon would
remove the V8 baseline (code, heap reservation, schema graph), not these growth patterns.

## 3. Startup

| Measurement (empty home, load 7–8)         | Packaged bundle | Profiled bundle |
| ------------------------------------------ | --------------- | --------------- |
| Spawn → endpoint (median of 5, two rounds) | 431 ms, 430 ms  | 432 ms, 532 ms  |
| Spawn → first sidebar to a fresh client    | 493 ms, 508 ms  | 490 ms, 613 ms  |

On the real 17 GB clone (load 10): 0.79–0.84 s to the endpoint and 1.07–1.18 s to the first
sidebar. The very first start after cloning took 5.1 s and 7.8 s (cold page cache and one-time
catch-up).

Where the main thread's startup time goes (one profiled start at load 9; 439 ms of main-thread
work before the first sidebar, the rest is Node bootstrap and waiting):

| Part (inclusive, overlapping)                                      | Time   | Share |
| ------------------------------------------------------------------ | ------ | ----- |
| Module loading (compile + top-level evaluation)                    | 258 ms | 59%   |
| ↳ of which compiling source text                                   | 86 ms  | 20%   |
| Building and running Zod schemas (mostly inside module evaluation) | 101 ms | 23%   |
| GC                                                                 | 24 ms  | 6%    |
| Provider adapters, store, server, engine setup                     | ~55 ms | 12%   |

Startup is mostly loading JavaScript. The work the daemon does to open its store and serve the
sidebar is under 15% of it on an empty home; on real data the extra 0.35–0.6 s is store and
index work.

## 4. Read paths on real data

Clone of the owner's data: 17 GB, 908 threads, 287k items, 5.1M events. The longest thread
has 9,602 items. Plain runs at load 10–12; daemon CPU is measured inside the daemon.

| Read                                      | Wall (median) | Daemon CPU (median) |
| ----------------------------------------- | ------------- | ------------------- |
| Sidebar for a fresh client                | 112 ms        | 102 ms              |
| Open one of the 5 longest threads (first) | 180 ms        | 116 ms              |
| Open it again from a new client           | 299 ms\*      | 118 ms              |
| `loadOlder` 50 items                      | 25 ms         | 9 ms                |
| `turns.page` 100 turns                    | 34 ms         | 32 ms               |
| `items.window` 199 items, jumped          | 78 ms         | 50 ms               |
| Thread search (tree scope)                | 40 ms         | 16 ms               |
| Global search                             | 40 ms         | 26 ms               |

\*The second open is not cheaper for the daemon: no cache serves it. Its wall time varied
between 133 and 363 ms.

Where each read spends the daemon's main thread (native stacks, the read repeated for 10 s):

| Read          | SQLite file I/O (`pread`) | SQLite engine | JSON parse | JavaScript + V8 runtime | SQLite json_extract |
| ------------- | ------------------------- | ------------- | ---------- | ----------------------- | ------------------- |
| Sidebar       | 43%                       | 5%            | 22%        | 19%                     | 4%                  |
| Open thread   | 46–52%                    | 8%            | 19–22%     | 12–14%                  | 3–4%                |
| loadOlder     | 76%                       | 4%            | 5%         | 8%                      | 2%                  |
| turns.page    | 41%                       | 33%           | 9%         | 14%                     | 1%                  |
| items.window  | 56%                       | 7%            | 8%         | 24%                     | 1%                  |
| Thread search | 52%                       | 34%           | 3%         | 8%                      | 2%                  |
| Global search | 78%                       | 5%            | 3%         | 9%                      | 4%                  |

The V8 profiles agree: SQLite's native calls (`all`, `get`, `iterate`) are 42–89% of each
read, Zod 3–22% (highest for `items.window`), and `structuredCopy` of projection state 5–10%
for sidebar and open-thread.

This updates the 2026-10-19 finding that reads are bound by JSON and Zod. On today's 17 GB
database, with `mmap_size=0` and a 2 MB page cache per connection, the largest single cost is
copying SQLite pages through `pread` (rows average 3.8 KB, so many span overflow pages).
JSON.parse is second. Pragma tuning was tried before on the smaller database; it should be
re-measured on this one.

## 5. The UI, for contrast

Production builds served by `vite preview`, the fake daemon running in the page, load 11:

| Measurement                                       | Median (5 runs)       | Range        |
| ------------------------------------------------- | --------------------- | ------------ |
| First contentful paint                            | 32 ms                 | 16–48 ms     |
| App ready (sidebar rows drawn)                    | 784 ms                | 626–951 ms   |
| Long tasks during load                            | 4, 409 ms total       | 345–424 ms   |
| Main-thread script to ready                       | 239 ms                | 224–270 ms   |
| Open a small thread from the sidebar (8 threads)  | 61 ms                 | 56–78 ms     |
| Open the synthetic million-item thread            | 506 ms                | 484–626 ms   |
| Scroll it (60 wheel steps): frame p50 / p95 / p99 | 16.7 / 16.8 / 16.8 ms | max 33–50 ms |
| Frames over one vsync while scrolling             | 3–6%                  |              |

Dev servers (`dev:fake` and `--mode perf`, React development build, unbundled modules), 3 runs:
app ready 1.8 s, 1.1 s of long tasks, open thread 134 ms, long thread open 1.4 s, scroll p99
33–100 ms. The production numbers are the realistic ones.

So, for "open a long thread": the daemon spends ~115 ms of CPU (180 ms wall) reading and
encoding it; the page then spends 60–500 ms drawing it, depending on its size. Startup
perceived by a person is about 0.5 s of daemon start plus 0.8 s for the page. A Rust daemon
could shrink the first half of each pair, not the second.

## Would Rust help? Hotspot by hotspot

| Hotspot                                           | Rust helps?                                                                                                          | Non-Rust fix                                                                                                                                             | Who gets most of it              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| SQLite checkpoints on the main thread             | No: same SQLite, same `fsync`.                                                                                       | `wal_autocheckpoint=0` on the main connection; checkpoint from a worker connection on a timer or WAL size.                                               | Non-Rust, all of it              |
| Temp-file churn (`temp_store=FILE`)               | No.                                                                                                                  | `temp_store=MEMORY` (statement journals are small), or find the statements that need sub-journals.                                                       | Non-Rust, all of it              |
| One commit per provider frame                     | No: commit cost is SQLite's.                                                                                         | Group frames that arrive in the same tick (or a 5–20 ms window) into one transaction, as the live write buffer already does for deltas.                  | Non-Rust                         |
| Session setup (spawn, git, locks, leases)         | No: syscalls and process creation cost the same.                                                                     | Cache per workspace; skip the plugin lock and materialization when nothing changed; drop `fsync` on lease files; move git lease scans off the turn path. | Non-Rust                         |
| Read-path `pread`                                 | No.                                                                                                                  | Re-measure `mmap_size` and a larger cache on the 17 GB database; cache the decoded tail of recently opened threads.                                      | Non-Rust                         |
| JSON.parse + Zod on reads (25–40% of a read's JS) | Partly: a Rust core could parse faster, but every object handed to JavaScript still has to be built in V8.           | Pass stored JSON through to the wire without parsing and re-validating it (validate once at write time; it is our own data).                             | Non-Rust, most of it             |
| Zod on the write path (8%)                        | Partly, only if validation moves with the code that uses the data.                                                   | Validate external input once at the provider boundary; skip re-validation of internal facts and stored rows.                                             | Non-Rust, most of it             |
| Provider stream decoding (10%)                    | A little: faster line splitting and JSON, but the engine needs JS objects.                                           | None needed beyond the Zod item above.                                                                                                                   | Neither matters much             |
| Fan-out and encoding (6–8%)                       | A little.                                                                                                            | Encode each event once and share the bytes across subscribers; transfer buffers to workers instead of structuredClone.                                   | Non-Rust                         |
| Idle memory (193 MB footprint, 68 MB heap)        | **Yes**: no V8 heap, no code objects, no schema graph. A Rust daemon of this scope would plausibly idle at 30–60 MB. | Lazy schemas and lazy modules trim 10–25 MB; the V8 baseline stays.                                                                                      | **Rust**                         |
| Startup (0.43 s empty, 0.8 s real data)           | **Yes**, for the ~60% that is module loading and schema building.                                                    | Node's compile cache or a startup snapshot could cut module loading by a few hundred ms.                                                                 | Both; Rust only with a full port |
| UI                                                | No.                                                                                                                  | Front-end work (the 0.8 s to sidebar, long-task budget).                                                                                                 | Not a daemon issue               |

## The best opportunities, ranked

| #   | Change                                                                                         | Effort | Expected gain                                                                                                                              | Rust? |
| --- | ---------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1   | Move WAL checkpoints off the main thread (`wal_autocheckpoint=0` + worker or timer checkpoint) | S      | Removes the largest main-thread stall on the write path: ~2.4 s per 28 s of busy streaming in the same-thread run; fewer event-loop stalls | No    |
| 2   | `temp_store=MEMORY` for `events.sqlite` (or remove the sub-journal cause)                      | S      | ~1.6–2 s of open/write/unlink per 28 s; a large share of the 30% kernel CPU                                                                | No    |
| 3   | Group-commit provider frames (one transaction per tick or short window)                        | M      | Commits per event 0.75–0.9 → well under 0.2; BEGIN/COMMIT is 11–40% of the JS profile                                                      | No    |
| 4   | Pass stored JSON through to clients on reads (no parse → validate → stringify round trip)      | M      | 20–30% of read CPU (JSON.parse 8–22% + Zod 3–22% + encoding); helps sidebar, open thread, paging                                           | No    |
| 5   | Trim per-session setup (plugin lock, skill lease fsync, git lease scans, MCP config)           | M      | ~15–20% of a new-thread turn (~60–90 ms of CPU each)                                                                                       | No    |
| 6   | Re-measure `mmap_size` / read cache on the 17 GB database; cache decoded thread tails          | S–M    | `pread` is 40–78% of read time; a hit would cut open-thread cost substantially                                                             | No    |
| 7   | Validate once at the boundary; stop re-validating internal data with Zod                       | M      | ~5–8% of streaming CPU, plus a share of the 15% of startup and ~15 MB of heap if schemas become lazy                                       | No    |
| 8   | Node compile cache or startup snapshot                                                         | S      | A share of the 59% of startup spent loading modules                                                                                        | No    |
| 9   | Full Rust daemon                                                                               | XL     | Idle memory 193 MB → plausibly 30–60 MB; startup ≈ halved; streaming CPU ±10% once 1–5 are done                                            | Yes   |

## The phased Rust plan

**Phase 1 (Rust helpers).** Not worth it for the daemon's hot path. The measured costs are
SQLite I/O, session setup and JavaScript glue, and none is an isolated CPU-bound function a
helper could take over. Keep Rust helpers for what they already do well (screen helper,
markit) and for any future CPU-bound task (for example, indexing very large files).

**Phase 2 (Rust storage and projection core via napi-rs).** Only worth considering as a
"bytes-out" core that owns storage, projection and wire encoding and hands finished frames to
the socket. A core that returns JavaScript objects across napi keeps the cost of building
those objects and adds boundary crossings; it would likely be slower per call than today. Even
the bytes-out version mostly wins what opportunities 1–4 win in TypeScript, at far higher
cost. Do 1–6 first and re-profile; if the daemon is then still CPU-bound, revisit.

**Phases 3–4 (full port).** The only phase whose main benefit can't be had another way: idle
memory and startup. If those matter (the daemon is always running, alongside Electron), a full
port is the way to get them, and the measurements here say the port need not fear SQLite
performance (it stays the same) or need to beat V8 on throughput. Treat it as a memory and
startup project, not a speed project.

**Recommendation:** do opportunities 1–3 now (small, measurable, all main-thread stalls), then
4–7. Skip phase 1. Defer phase 2 indefinitely unless a re-profile after those fixes shows the
daemon CPU-bound in JavaScript. Decide phases 3–4 on memory and startup goals alone.

## Caveats

- **Load.** Other agents kept load between 7 and 400. Busy-path CPU per event moved 1.55–3.0 ms
  with load; percentage splits stayed within a few points between runs, except SQLite file I/O
  (17–34% on new-thread runs), which tracks disk contention.
- **Sample sizes.** Busy CPU: 5 plain new-thread runs and 4 plain same-thread runs; profiles 3
  V8 + 3 native (new thread) and 2 V8 + 1 native (same thread). Startup: 5 reps × 2 rounds per
  bundle. Reads: 3–30 repetitions each. UI: 5 production runs, 3 dev runs. One soak.
- **Sampled time is not CPU time.** Profilers sample wall time while a thread is busy, including
  time blocked in syscalls or preempted. CPU per event comes from `process.cpuUsage()` with no
  profiler attached.
- **Fake provider.** The fake CLI is a small Node process per session; real CLIs are heavier,
  but their memory and CPU are outside the daemon and were not counted.
- **The disk was 98% full** and shared; `fsync` and `pread` latencies on a quieter disk will be
  lower.
- **The UI fake daemon runs in the page**, so "app ready" includes seeding the fake world on the
  page's main thread. It is an upper bound for the page's own work.
- **The Cursor SDK in the bundle attempted model discovery** in the fake HOME and stopped at
  "account folder unavailable"; no provider was contacted.
- One 7.7 s event-loop stall (331 ms of CPU, so I/O wait) was logged in
  `storage/transcript.ts` during the sampled search loop on real data; `sample` itself may have
  lengthened it.
