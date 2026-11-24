# The native connection's two measured costs: extra commits and extra RSS

Investigated 2026-11-23 on the tree of `ace/bench-rust-switches` (`0ca876af44`, whose results are
`tools/daemon-bench/results/2026-11-23-rust-switches-per-switch.md`). Both effects belong to
`ACE_STORE=native` alone (ADR 0222 phase 1a): with the switch off, the daemon runs node:sqlite
and loads no addon at all. The machine was shared and loaded (1-minute load 18 to 90 across the
runs below), and every measurement ran one at a time on its own throwaway root.

## 1. +4% SQLite write transactions per long-text turn

### What it is not

The native connection does not split, retry or double-commit anything. With a store driven
directly (no daemon, 1,000 deltas paced 10 ms apart, one turn) the transaction counter is
**149 off and 147 on**; the same holds over five turns. Every commit the store makes is one
`BEGIN IMMEDIATE`/`COMMIT` pair in `Store.transaction` (`store.ts:623`, `store.ts:636`), counted
once at `store.ts:638`, nested work running under savepoints. No path adds a pair of its own.

### What it is

The count changes because **a read that flushes the live buffer can commit, and every commit
wakes a read**. The chain, with a stack trace per commit as evidence:

1. `Store.readUsagePage` flushes buffered live writes before it reads (`store.ts:1212`–`1215`,
   `flushLiveWrites` at `store.ts:567`). So does `readSearchPage` (`store.ts:1207`).
2. `flushLiveWrites` → `StoreStream.flush` (`store-stream.ts:209`) → `attempt`
   (`store-stream.ts:238`) → `write` (`store-stream.ts:281`) → `transaction`
   (`store-stream.ts:291`), i.e. one commit per flush that found at least one delta.
3. Every commit wakes the usage replay: `store.subscribeUsage(schedule)` (`usage.ts:215`), and
   `schedule` (`usage.ts:160`) runs `catchUp` (`usage.ts:173`) on the next `setImmediate`, whose
   first act is another `readUsagePage` (`packages/usage/src/backfill.ts:16`).

So the replay's reads and the buffer's flushes feed each other. A replay lap that takes longer
than the 10 ms gap between deltas always finds buffered deltas and commits them, and that commit
starts the next lap. The native connection makes each statement cost more (measured in ADR 0222:
`run` +2.6 µs, `get` +0.5 µs, each row of `all` +0.3 µs), which is enough to push a lap across
that gap; the store then writes the same deltas in more, smaller transactions instead of one
75 ms flush (`live-write-buffer.ts:22`).

Evidence: one standard bench run per side (400 seeded threads, 60 s idle, 20 + 40 turns, then 3
long-text turns of 1,000 deltas at 10 ms), every commit in the run traced by stack:

| count over the whole run                              | off              | on        |
| ----------------------------------------------------- | ---------------- | --------- |
| long-text transactions per turn (the bench's number)  | 291.7            | 324.0     |
| commits from the 75 ms timer (`attempt <- scheduled`) | 427              | 389       |
| commits from `readUsagePage`'s flush                  | 65               | 214       |
| every other call path, per signature                  | identical counts | identical |

The replay-flush path accounts for all of the difference (+149) and the timer for the rest
(−38); 3.3× more replay laps found buffered output. Lighter runs (400 seeds but 5 s idle and one
turn each side) showed no difference at all (324.0 against 318.3), and the same-thread and
new-thread phases of the standard run matched to 0.1% (80.98 against 80.93) — the effect needs
both a delta stream and enough accumulated state for a lap to cross one delta interval, which is
why it appears every time in the bench's pairs and not in every lighter pair here.

### Smallest fix

Do not let the replay's own wake convert into a commit: coalesce `schedule` (`usage.ts:160`) to a
short timer (an unref'd 75 to 100 ms, the live buffer's own window) instead of `setImmediate`, so
one commit cannot produce another. `reach` (`usage.ts:197`) still wakes it for a reading client,
and `usageSettleMs` (250 ms) absorbs the delay. Test-first: a test that streams deltas with a
usage subscriber and asserts the store's transaction count stays at the timer's cadence would
guard it. This is not applied here: it trades analytics latency for write count, which is the
owner's call, not a mechanical fix.

A store-side alternative — have `readUsagePage` skip the flush when the buffered events cannot
change its page — needs the usage type filter inside the store and is not obviously right.

## 2. +16 MiB idle RSS with 1 MiB less JS heap

### Method

One standard bench run per side with `vmmap -summary` and `footprint -p` taken at each memory
sample (startup, idle, and after each phase), on throwaway roots. Six regions were compared;
`footprint`'s category table names the allocator that owns each page.

### Attribution (long-text sample, the pair where the effect appeared)

| category (footprint, dirty)   | off                             | on          | change             |
| ----------------------------- | ------------------------------- | ----------- | ------------------ |
| App-Specific Tag 1 (JSC heap) | 155 MB                          | 195 MB      | +40 MB             |
| Malloc Small                  | 19 MB                           | 21 MB       | +2 MB              |
| __DATA                        | 458 KB                          | 557 KB      | +0.1 MB            |
| Stack (82 regions)            | 1936 KB                         | 1936 KB     | 0                  |
| mapped file                   | 1664 KB                         | 1632 KB     | 0                  |
| SQLite Page Cache             | 48 KB dirty, 3.1 MB reclaimable | absent      | −3 MB              |
| __TEXT / __LINKEDIT (clean)   | 31 / 1.6 MB                     | 34 / 1.6 MB | +3 MB, file-backed |

The whole difference is **JavaScriptCore's heap region**, and it is committed pages, not live
data: the JS heap after a forced full collection is _lower_ on the native side (95.4 → 92.2 MB
in this pair, 1.5 to 3 MB lower in every pair). It is present from the first sample after open
(dirty 155 against 191 MB, before any benchmark phase) and stays flat through the run.

What that rules out, all measured, not reasoned:

- **No second SQLite page cache**: the `SQLite Page Cache` category disappears entirely with the
  addon (bundled SQLite allocates from the default malloc zone), and Malloc Small grows by 2 MB,
  not by the 2 MiB-per-connection a second cache would show. The store, checkpoint worker,
  search workers and history worker open the same connections with the same pragmas either way.
- **No WAL index or mapped database**: `mapped file` is unchanged (14 regions, 1.6 MB).
- **No tokio runtime or extra threads**: `Stack` is 82 regions and 1936 KB on both sides, so the
  addon's threads (if any were started for the store path) add no resident stack.
- **Not the addon's text**: `__TEXT`/`__LINKEDIT` are clean, file-backed, and are not counted in
  the physical footprint; the control runs (`ACE_TRANSLATORS`, `ACE_GIT`) map the same dylib and
  moved RSS by 0.2 to 0.4 MB.
- **Not allocator fragmentation in Rust**: `Malloc Small` accounts for 2 of the 40 MB.

The likely cause is how values cross: `NativeStatementSync` builds one JS array per call, one
null-prototype object per row and one JS string per text cell (`native-sqlite.ts:158` for
parameters, `native-sqlite.ts:193` `#rows`, batched at `native-sqlite.ts:232` and
`native-sqlite.ts:257`), where node:sqlite creates its rows inside JSC without that per-value
N-API marshalling. That raises JSC's allocation rate at an unchanged live set, and JSC keeps the
committed high-water mark after a full collection. A 200,000-row sweep of one process measured
no JSC growth either way, so this mechanism is consistent with the data but not proven by it;
what _is_ proven is that every other candidate is unchanged and the pages are JSC's.

The size is not stable: the bench's four runs separated at +16 MiB, one pair here separated at
+12.8 MiB at idle and +42 MiB at the end of the phases, and one lighter pair landed 22 MiB
_lower_ with the switch on. The sign and the region are consistent; the magnitude tracks GC
timing on a loaded machine.

### Smallest fix

None inside phase 1a: as long as every cell is materialised as its own JS value, the shape of the
cost is JSC's. The fix is the one ADR 0222 §5 already names — a native read returns one finished
JSON string (one allocation, parsed once), or the Rust transport of ADR 0226 hands the bytes to
the socket without building JS objects at all. Until then the honest statement in the ADR is:
phase 1a costs about 16 MiB of JS heap commitment and must not ship without 1b.

## Reproducing

```sh
# build the addon, then one standard run per side (scripts in .ace-dev are not committed)
bun tools/daemon-bench/src/run.ts --output=off.json
ACE_STORE=native ACE_STORE_ADDON=$PWD/native/daemon/target/release/libace_daemon_node.dylib \
  bun tools/daemon-bench/src/run.ts --output=on.json
```

Both effects are visible in `phases.longText` (`transactionsPerTurn`, `memory`) and in `idle`
(`memory`).
