# 0225: The phone keeps every thread it read: a device cache, a hot archive, a view range

Date: 2026-11-24. Status: accepted. Decided by: the owner. Amends
[ADR 0062](0062-long-thread-data-apis.md) (phone client), [ADR 0105](0105-phone-chat-cache.md)
(retention) and [ADR 0128](0128-resume-kept-threads.md) ("unchanged: ADR 0105's retention").

## Context

Owner report, 2026-11-24, after #2774 made the phone's window "unbounded": scrolling far up a long
thread and back down still showed a black screen, and a thread read earlier was read from the
machine again. "The chats should be in cache. Loaded messages are still going black."

What the phone kept of a thread it had read:

- **While reading.** One history window beside the live tail, at most 2,000 items or 8 MiB of text
  (`windowBounds`). Tool output reaches 8 MiB quickly, so reading older trimmed the newer end, and
  coming back down showed the empty space the trimmed rows left while they were read again from
  the machine, over the relay on a phone.
- **After leaving the thread.** The window was discarded. Reopening read the history again.
- **After the app closed.** The disk kept the live tail (200 items) and the history pages it had
  fetched, each page as its own record, for seven days, twenty settled threads and 64 MiB. A saved
  page was reused only while the thread had not changed since, and older pages only offline.

The owner set the rules on 2026-11-24:

- A device cache holds the threads the phone has read, even while the app is closed. It goes when
  the app is removed or the person clears it, not by age or count.
- In memory, the thread data loaded so far is held hot under a limit large enough for whole
  threads, and only what the screen needs is shown and laid out.

## Decision

Three layers, each owning one thing:

| Layer        | Where                                    | Holds                                     | Bound                          |
| ------------ | ---------------------------------------- | ----------------------------------------- | ------------------------------ |
| Device cache | the machine's snapshot SQLite (ADR 0105) | every finished item of every thread read  | 1 GiB, least recently used     |
| Hot archive  | `ClientCore` memory (`ThreadArchives`)   | every item of each recent thread, in runs | 96 MiB of item JSON, by thread |
| View range   | the history window and Swift's lazy feed | the part of the thread around the reader  | `windowBounds`, refilled local |

### The archive (`packages/client/src/thread-archive.ts`)

A thread's archive is a set of disjoint runs. A run holds every item whose creation sequence lies in
`[from, through]` (`from` null: since the thread's start), in sequence order. It is fed by:

- every `items.window` reply (its range is `[itemsBefore, itemsAfter ?? seq]`),
- the live store at each read-snapshot checkpoint (at most once a second, never on the delta
  path), only once the store is confirmed (`[itemsBefore, seq]`),
- the device cache, once per thread per launch.

A run is authoritative for its range: an item the archive held there that the run lacks was
deleted. Runs that meet or overlap are merged into one. A finished item never changes (ADR 0105),
so a finished item already held is kept as is; a copy the live store clipped
(`limits.text`) never replaces an unclipped one. Pure, no I/O.

### Reads

`ClientCore.itemsWindow` answers from the archive when a run holds the target and at least one item
on each side the read asks for, or reaches the thread's start. A partial answer is allowed; its
cursor then sits at the run's edge, and the next read past it goes to the machine, whose reply
joins the run. Turn jumps (`turnOrdinal`) and targets outside every run go to the machine.

An answer made only of items confirmed on this connection (read from the machine or the live
store since the last welcome) is used as is; each new connection unconfirms everything held, since
what changed while the phone was away is unknown. One with items read from disk is shown at once and checked against the machine in the
background when connected; if the check changes anything in the range the reader holds, the
reading view's window is revised in place (`JumpController.revise`), with no scroll jump. Offline,
answers from the archive show as cached history, read-only, as before.

Since paging older and newer is now local for everything already read, the view range (the
history window and Swift's `LazyVStack`) keeps its bounds: rows it trims come back from memory
within a frame instead of a network round trip, and Swift lays out only the rows on screen.

### Memory

`ThreadArchives` holds threads in least-recently-used order. Past 96 MiB of item JSON it lets go
of whole threads that are fully written to disk, never the one used last. A thread let go is read
back from the device cache on its next use.

### Device cache

Each thread's archive is one `archive:<threadId>` record under the daemon's verified identity, in
the same tables as the live record: a head (runs, sequences, clipped ids, the database it was read
under) and one row per finished item, written once (`RowSnapshots`). Unfinished items are not
written; the live record holds them. A write is split so no one native write exceeds 4 MiB; a head
naming items not yet written reads back as shorter runs. Writes are paced at most once every two
seconds per thread and on close.

Retention on the phone (`deviceRetention`): no age limit, no settled-thread count, a 1 GiB safety
net past which the least recently used go, settled threads first. Settings → Cached chats counts
and clears archives with the rest; Reload from machine drops the thread's archive too.

### Correctness

- Agent state is never read from the archive: status, runs, agents, interactions and tasks still
  come only from the live store, and a cached thread still reads Syncing until its machine answers.
- An archive is kept under the daemon database it was read from (`welcome.databaseId`, ADR 0128).
  A different database drops every archive of that machine, in memory and on disk, since its
  sequences say nothing about the new one.

## Consequences

- Scrolling back over anything already read is local: no black space while a page is fetched.
- A thread read once opens and scrolls from the phone with the app relaunched, offline included.
- The phone may keep up to 1 GiB of chats until the person clears them or removes the app.
- Web and desktop are unchanged: `archive` is a `ClientCore` option only the iOS bridge sets.
  Android reuses it as is.

## Tests

- `packages/client/src/thread-archive.test.ts`: runs merge and stay authoritative; deletions are
  inferred only inside a run; windows are served with correct cursors, partially at a run's edge,
  in whole turns, and never stall.
- `packages/client/src/thread-archives.test.ts`: archives persist through a restart, survive
  partial writes, are dropped for another database, are checked again after a reconnect, and
  memory lets go of written threads only.
- `packages/client/src/row-snapshots.test.ts`, `snapshot-retention.test.ts`: writes larger than
  one native write are split; Settings counts a chat once; the device cache keeps every thread
  until its byte cap.
- `packages/ui-core/src/jump-controller.test.ts`: a corrected window keeps its range and the
  reader's place.
- `apps/ios/bridge/native-transcript.test.ts`, over the real SDK, the fake daemon and the native
  store's contract: scrolling back down after reading past the window refills without asking the
  machine; history read before the app closed is answered offline after it reopens, marked
  cached.
