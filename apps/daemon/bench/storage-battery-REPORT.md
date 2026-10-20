# Storage and browser-capture benchmark

Before: `main 5f70a1d6b`. After: `ace/sqlite-store-optimization 7638a7408` (the same base plus the six commits listed below). Measured 2026-10-19.

## Summary

- **Unwatched browser page:** Chrome used 27% of one core before and 6% after (-78%), and encoded 13 frames per second before and none after. Right after the page opened, which includes Chrome's start-up work, it was 54% → 30%.
- **Watched browser page:** unchanged. Both encode 23 frames per second; Chrome CPU ranged 104–139% before and 98–127% after.
- **Global search:** 3 of 5 queries failed before (threads stopped at a usage limit broke the result schema); 0 after.
- **Stored copies:** each tool call was also stored in full as its page preview and as engine metadata. On this database those copies take 224 MB for 23,861 tool calls (about 9.6 KB each); new tool calls no longer write them. The store benchmark's synthetic tool calls are tiny, so its bytes-per-item figure below cannot show this.
- **Reads** (sidebar, opening threads, scrolling, search): unchanged within noise. They are bound by decoding stored JSON in JavaScript, not by SQLite.
- **Writes:** item commits 2.8 → 3.1 ms at the median and 10.1 → 9.7 ms at p95; write-phase CPU +8%. Within the noise of this machine.

## Setup

- MacBook Pro (Mac16,5), Apple M4 Max, 16 cores, 128 GB, macOS 26.2, Node 26.8.1, SQLite 3.53.4, Google Chrome 155.0.8059.85.
- Dataset: a copy of a real ace database, 2.7 GB, 136 threads, 45,378 items, 504,588 events. Every run used a fresh copy-on-write clone, pre-read into the OS cache.
- 4 store runs and 3 browser runs per side, alternating before and after. Each run waited for the 1-minute load average to fall below 20; other work on the machine continued, so changes within ±10% are noise.
- Store: `node apps/daemon/bench/sqlite-store.ts --db=<clone>` (times the daemon's own `Store` calls; medians across runs of each run's p50 and p95).
- Browser: `node packages/browser/bench/unwatched-capture.ts` (ace's headless Chrome showing a page with a CSS spinner; CPU of every Chrome process for its profile and of the daemon process, 20 s per phase).

## Browser page cost

| Phase                 | Chrome CPU (% of a core) before → after | Daemon CPU before → after | Frames/s before → after |
| --------------------- | --------------------------------------- | ------------------------- | ----------------------- |
| nobody watching       | 54% → 30%                               | 1.6% → 0.0%               | 13.2 → 0.0              |
| one viewer watching   | 125% → 99%                              | 2.0% → 1.7%               | 23.1 → 23.1             |
| after the viewer left | 27% → 6%                                | 1.3% → 0.0%               | 13.2 → 0.0              |

## Reads (ms)

| Operation                      | p50 before → after | change | p95 before → after | change |
| ------------------------------ | ------------------ | ------ | ------------------ | ------ |
| Sidebar, first page            | 18.8 → 17.9        | ≈ same | —                  | —      |
| List all threads               | 13.8 → 13.1        | ≈ same | 23.1 → 21.6        | ≈ same |
| Open a thread, first time      | 9.0 → 7.6          | -15%   | 23.9 → 22.9        | ≈ same |
| Open a thread again            | 7.0 → 6.4          | ≈ same | 9.9 → 10.3         | ≈ same |
| Scroll back, per 50 items      | 2.3 → 2.2          | ≈ same | 3.5 → 3.3          | ≈ same |
| Turn navigation page           | 5.1 → 5.0          | ≈ same | 16.7 → 16.9        | ≈ same |
| Jump to the middle of a thread | 9.5 → 9.3          | ≈ same | 12.6 → 11.9        | ≈ same |
| Catch-up digest                | 0.4 → 0.3          | ≈ same | 0.9 → 1.3          | +47%   |
| Search in a thread             | 4.3 → 4.2          | ≈ same | 8.3 → 7.8          | ≈ same |
| Global search                  | 2.9 → 2.4          | -19%   | 4.1 → 4.2          | ≈ same |
| Global search failures (of 5)  | 3 → 0              |        |                    |        |

## Writes

| Measure                             | before → after | change | p95 before → after | change |
| ----------------------------------- | -------------- | ------ | ------------------ | ------ |
| Item commit (ms)                    | 2.8 → 3.1      | +11%   | 10.1 → 9.7         | ≈ same |
| Write phase, CPU (ms)               | 2,092 → 2,260  | ≈ same | —                  | —      |
| Write phase, wall (ms)              | 3,494 → 3,649  | ≈ same | —                  | —      |
| Disk written per streamed item (KB) | 76.1 → 76.0    | ≈ same | —                  | —      |

The store benchmark writes through `Store.appendEvents`, not the engine, so it does not include the engine-side saving: a tool-call update no longer writes a second full copy as engine metadata.

## Changes measured

- 8006fd0bb Keep global search working for threads stopped at a usage limit
- 02f7c024c Store each non-text item body once
- ef39a4621 Key stored records with time-ordered UUIDv7 ids
- b1687a774 Add a store benchmark that runs on a copy of a real database
- 84754f136 Refresh the search entry of a streaming item every 2 s, not every 100 ms
- 7638a7408 Screencast a browser page only while someone watches it or an agent drives it

## Not included

- The duplicate copies already in an existing database stay: removing 303 MB of them left free pages scattered through the file and made later writes about 30% slower.
- SQLite cache, mmap and checkpoint settings, `PRAGMA optimize` and an FTS merge were measured and gave no gain or made reads slower.

Machine load (1-minute average) at each run: store before 1 17, store after 1 19, store before 2 17, store after 2 16, store before 3 15, store after 3 13, store before 4 12, store after 4 13, battery before 1 14, battery after 1 19, battery before 2 10, battery after 2 12, battery before 3 8, battery after 3 11.

Raw results: `storage-battery-results.json`.
