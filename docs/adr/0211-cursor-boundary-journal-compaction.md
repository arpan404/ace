# 0211: Cursor's boundary journal is trimmed once ace has stored it

Status: accepted. Date: 2026-11-21.

Amends [ADR 0043](0043-cursor-sdk-local-runtime.md): the SDK host's boundary journal
(`ace-boundary.ndjson` in the thread's checkpoint folder) no longer only grows.

## Context

The Cursor SDK host writes every redacted SDK callback to `ace-boundary.ndjson` before it sends
the frame to ace. When a host reopens, it replays the frames after ace's stored cursor
(`engine_provider_cursors.offset`, passed as `afterFrameOffset`). Nothing was ever removed: on the
owner's machine one long thread had a 4.5 MB journal in a 33.5 MB checkpoint folder, and the
folder's checkpoint budget fenced the thread for good. A frame ace has stored is never replayed
again, so keeping it buys nothing.

## Decision

### 1. When frames are dropped

The host tracks the highest offset ace has acknowledged storing: a frame request resolves only
after the daemon's batch transaction committed its offset, and on open the stored cursor counts as
acknowledged. At each settled turn (the run's `result` frame stored) the host trims every frame up
to the offset that was acknowledged at the _previous_ settled turn, or at open. The one turn of lag
keeps a frame ace stored moments ago until ace has stored a turn more after it. Frames ace has not
acknowledged are never dropped.

The rewrite costs the bytes kept, so it happens only when the dropped prefix is at least as large
as what stays. Every byte is copied a bounded number of times, and a long thread's journal stays
proportional to its last few turns.

### 2. Format

A trimmed journal starts with one or more header lines, then frames as before:

```json
{ "aceJournal": 2, "baseOffset": 120, "observe": [["run-id", "sdk-observe-offset"]] }
```

`baseOffset` is the last dropped offset; the next frame is `baseOffset + 1`, so offsets stay
global and match ace's cursor. `observe` holds each run's SDK observe offset that the dropped
frames had set, which is the only state recovery rebuilds from old frames. It spans several header
lines when it does not fit in one frame's byte budget; all of them carry the same `baseOffset`.

Recovery still rejects gaps, unordered offsets and a torn tail. It also rejects a cursor below
`baseOffset`: ace would be missing frames the journal no longer has. A journal without a header
(the old format) recovers as before, with a base of 0.

### 3. Crash safety

The new journal is written to `ace-boundary.ndjson.compact` from a snapshot of the old one, off
the write path and yielding between lines. Then, under the journal's write gate, the frames
appended since the snapshot are copied byte for byte, the temp file is fsynced and renamed over
the journal, and the directory is fsynced. A crash leaves either the old journal or the new one.
Recovery deletes a leftover temp file without reading it.

A failure before the rename leaves the old journal in use and the turn unaffected. A failure after
it fences this host's journal; the new journal is on disk and the next open recovers it.

### 4. Checkpoint budget

The swap runs inside the thread's checkpoint quota, which re-reads the journal's size afterwards,
so the ledger shrinks with the file. The folder scan skips a file removed between its listing and
its stat, as the temp file is.

## Consequences

- A long Cursor thread's checkpoint folder no longer grows with its journal. The SDK's own files
  (`runs.ndjson`, `store.db` and the rest) are not touched here.
- An ace build older than this one refuses a trimmed journal (it does not know the header). That
  fences the thread until ace is updated; no data is lost.
- The daemon's SQLite uses `synchronous=NORMAL`, so a power loss can roll back its last commits.
  If it rolls back past a journal's `baseOffset`, recovery refuses (section 2) and the thread needs
  context handoff. Because of the one-turn lag in section 1, the rollback would have to undo a whole
  earlier turn first.
- While a rewrite runs, the temp file sits beside the journal and the folder scan counts both.
  Near the budget that can refuse a send that would otherwise fit.
- A single very long turn still grows the journal until it settles.
