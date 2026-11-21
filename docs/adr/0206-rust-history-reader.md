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
7. Until every provider is ported, readers are routed per provider. Claude Code, Codex and Cursor
   (which is only reported unsupported) go to `ace-history`; OpenCode and Pi stay on the
   TypeScript reader over the same index. Both get every registered home, so trust filters and
   cleanup agree, and each scans and imports only its own providers; the Rust reader serves
   lists, reads and the archive. A release without the binary, or a development tree without a
   Cargo build, uses the TypeScript reader for everything. When the remaining providers are
   ported, the TypeScript reader is deleted.

## Consequences

- Releases build and sign one more native binary per platform, staged in `history/` beside
  `media/` and `files/`.
- Where the TypeScript and Rust ports could disagree (JavaScript `Date.parse` of non-ISO
  strings, numbers beyond 2^53, a cut through a UTF-16 surrogate pair) the Rust reader follows
  the ISO and Unicode reading; parity tests cover the fixtures, not those edges.
- The frame codec is now written twice in TypeScript (files-native and history-import); a shared
  codec in `provider-kit` is a follow-up.
