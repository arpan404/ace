# 0206. The saved-history reader moves to Rust

Status: accepted, 2026-11-20

## Context

`packages/history-import` reads the providers' stored history: it walks Claude Code project
folders and Codex rollouts, opens Codex and OpenCode SQLite stores through private snapshots,
keeps a catalog of every session in an ace-owned SQLite index, and imports one session into ace
events. It runs as a Bun child process (`reader-process.ts` forks `worker.ts`). Most of what it
does is fight the garbage collector: a 512 MB RSS watchdog, forced full collections between
batches (`reader-memory.ts`), a decode byte budget, a crash ledger and poison-file preloads in
the tests. On a multi-gigabyte home the first scan is slow and the reader's resident memory
follows the heap, not the work.

Measured on Bun 1.4 (M-series Mac, 40,000 Claude records, 44 MB): reading and `JSON.parse`
took 59 ms, mapping the records into ace items with their `Item.parse` and `JSON.stringify`
took 157 ms. Mapping is about three quarters of an import's CPU and most of its garbage.

## Decision

1. A Rust process, `ace-history` (`native/history`), owns the heavy work: inventory walks,
   fingerprints, bounded streaming reads of JSONL and SQLite, the catalog, the archive of
   imported threads, provider-database snapshots, the crash ledger and read backoff, and the
   provider readers. It is its own Cargo workspace with the checks and licence allowlist of
   `native/files`, run by `bun run check:history`.
2. **Rust owns the mapping of native records into ace items.** The mapper is history-only: live
   sessions reach ace through the adapters and never call `map-history.ts`. Moving only the
   reads would leave three quarters of the CPU, and the garbage, in TypeScript, and would make
   the daemon parse every record again. Two pieces of the mapping are shared with live code, and
   for those the TypeScript stays the source of truth: `sanitizeUserText` (`@ace/native-session`,
   used by `ui-core`) and `summarizeOutput` (`@ace/projection`). They are ported to Rust and
   pinned by vectors generated from the TypeScript (`native/history/vectors/`); a TypeScript test
   fails when the vectors are stale and a Rust test fails when the port disagrees.
3. The daemon-facing API of `@ace/history-import` does not change: `openHistory`,
   `HistoryService`, `Options`, `Packet` and the archive contracts stay as they are. The reader
   is spoken to over stdio with the files-wire framing (a `u32` length, kind 1 JSON or kind 2
   `u64` id and bytes). Messages are the `Envelope`, `Reply`, progress and refusal shapes the
   worker already sends; a `Uint8Array` travels as a body frame referenced from its JSON. The
   wire crate is `history-wire`; its vectors are shared by both sides.
4. Rust reads the same index file and the same catalog schema (format 5). An existing index is
   used as it is: no rescan, no migration, no open-time work (ADR 0170). Cleanup of rows for
   unregistered homes keeps running in bounded pages inside a scan, as today.
5. Memory is bounded by construction: a record over 1 MiB is never decoded (it streams as an
   opaque blob), samples are two 64 KiB windows, reads are in 64 KiB buffers, and a batch reads
   at most eight files at a time. The watchdog stays, with a lower limit measured on the scale
   fixture.
6. Supervision is the existing one: `RecoveringWorker` restarts the reader with backoff, its
   process group is owned through `process-owner`, and the reader exits when stdin closes or the
   daemon's pid is gone. A transcript that is being read when the reader dies is marked in the
   crash ledger first, so after the third such crash it is reported unsupported, as today.
7. Every provider is read by `ace-history`: Claude Code, Codex, Cursor (reported unsupported),
   OpenCode (legacy storage files, SQLite schema v1 and v2) and Pi. The TypeScript reader, its
   per-provider router and its test preloads are deleted. `@ace/history-import` keeps the
   daemon-facing API and the thin supervisor (`RecoveringWorker`, `ReaderProcess`). An install
   without the binary cannot read saved history and says so; development trees build it
   (`scripts/history-binary-setup.ts` does for the process tests, and fails the run if it cannot).
8. Its process tests drive the real binary through a `test-hooks` Cargo feature, never in a
   release: crashes at named points, pauses, delays, read and snapshot logs, a counted startup
   crash, a memory poison, an append race and a clock shift (`hooks.rs`). Parity with the
   TypeScript reader is pinned by the observation it made of generated homes for every provider,
   kept as `parity-expected.json.gz` when it was removed.
9. Both native processes share one TypeScript frame codec, `@ace/files-native/frames`; files-wire
   and history-wire define only their messages on top of it.
10. Where JavaScript and Rust read provider JSON differently, the reader chooses:
    - nesting past serde_json's 128 levels is read like JavaScript reads it, up to 512 levels for
      a provider record and 640 for messages and stored rows; deeper records stay raw;
    - a lone UTF-16 surrogate escape reads as U+FFFD (a Rust string cannot hold one) instead of
      failing its record;
    - integers past 2^53 keep the digits the provider wrote; the daemon parses them to the same
      double the TypeScript reader made, and timestamps still require a safe integer;
    - only the ISO date-time format is a date. `Date.parse` accepts more, differently per engine
      (Bun and Node disagree), and providers write ISO.
    Each choice is pinned by a test in `json.rs`.

## Consequences

- Measured on generated homes (`bench/scan.ts`, BENCHMARKS.md, release build, Bun 1.4, shared
  M-series Mac), TypeScript reader before it was removed against ace-history:

  | Benchmark | TypeScript | ace-history |
  | --- | ---: | ---: |
  | 5,000 small transcripts, cold scan | 1,407 ms, 121 MiB | 1,277 ms, 16 MiB |
  | 5,000 small transcripts, warm scan | 161 ms, 123 MiB | 158 ms, 16 MiB |
  | Scale home (Claude, Codex, 6,000 OpenCode legacy sessions, an 802-session v2 database), cold | 28.5 s, 196 MiB | 32.6 s, 24 MiB |
  | Scale home, warm | 815 ms, 192 MiB | 823 ms, 24 MiB |
  | 2,000 Pi sessions, cold | 824 ms, 127 MiB | 764 ms, 12 MiB |
  | 2,000 Pi sessions, warm | 108 ms, 128 MiB | 62 ms, 12 MiB |
  | 300 MB, 200,000-record Claude import | 13.1 s, 292 MiB | 9.8 s, 33 MiB |
  | 20,000-message OpenCode database import | 868 ms, 257 MiB | 1,173 ms, 31 MiB |

  Memory falls by an order of magnitude everywhere. The scale home's cold scan and the OpenCode
  database import are slower in Rust: the first is dominated by sampling 710 MB of sparse
  rollouts and by OpenCode's legacy storage, read one message file at a time; the second reads
  every row through one bounded channel. Both are follow-ups, not regressions in what a person
  waits on (warm scans, lists and Claude imports are as fast or faster). The reader's watchdog
  limit is 128 MiB.
- Lists and reads are answered on their own thread, so a list sent while a scan is stuck is
  answered rather than failing with the scan's memory error.
- Session files are opened through `files-safe` (native/files): every component is looked up from
  the folder handle above it with no link followed. In-place SQLite reads open the checked
  descriptor through `/dev/fd`; copy-on-write snapshots clone the checked descriptor
  (`fclonefileat`, `FICLONE`), never a path.
- Scratch directories hold an owner lock the operating system releases when their process exits,
  so a dead reader's snapshot is swept whatever its pid now names; directories without one fall
  back to a pid check, which on Windows is `OpenProcess` and `GetExitCodeProcess`.
- An import marks its tree's root in the crash ledger before reading it, outside any archive
  transaction, and clears the mark when it ends; a transcript that kills the reader three times
  while imported is refused, as one that kills a scan is.
- The index's freshness check, schema and format marker are one transaction, so a crash between
  them leaves a fresh file.
- On Windows, std has no stable file index, so fingerprints carry no device or inode there and
  an index the TypeScript reader wrote is read once more after the move. The Windows paths (file
  identity, liveness, scratch sweeping, the pinned in-place open) compile and pass clippy for
  `x86_64-pc-windows-msvc` but have not run on Windows yet.
- Releases build and sign one more native binary per platform, staged in `history/` beside
  `media/` and `files/`.
