# 0125: Validate at trust boundaries, not on every read

Status: accepted. Date: 2026-11-11. Decided by: the owner ("let's not validate on every stage").
Amends the AGENTS.md rule "Explicit types at boundaries"; ADR 0003 (Zod 4) stands.

## Context

The daemon parsed data with a Zod schema at every stage, including data it wrote itself. Reading
one stored event ran `JSON.parse`, a lenient `tagged.parse`, a linear scan of the event variants,
`EventPayload.parse` (an item event parsed its `Item` twice), then `Event.parse` over the result,
and `JSON.stringify` to measure the page budget. Zod 4's parse also builds a fresh copy of every
object, which feeds the garbage collector. Earlier profiles had Zod at about a quarter of the
main thread's busy time and reads bound by JSON parsing and validation rather than SQLite.

Measured with `apps/daemon/bench/stored-reads.ts` on a copy of the owner's 26 GB store, the
20,000 newest events: 5.2 µs of CPU per row validated, 0.7 µs read as stored (7.6× less), and no
row changed by decoding. Across the whole history 2 of 20,000 sampled older rows did change (an
`interaction.opened` and an `item.updated` from older layouts), so old rows can't simply be
trusted.

## Decision

1. **Validate where data enters ace.** Provider CLI output, socket messages from clients and
   paired devices, files and databases other programs write, environment variables, MCP calls
   and HTTP responses are parsed with a schema before use, as before.
2. **Don't validate again what ace itself produced.** Values this process built with the right
   TypeScript type, messages between ace's own threads, and rows this build wrote are used as
   they are.
3. **Stored rows are trusted by the build that wrote them.** `stored-shape.ts` fingerprints the
   event schema together with the migration version. When the fingerprint differs from the one
   recorded in `stored_event_shape`, the first sequence this build will write is recorded with
   it. Events and items from that sequence on are read as stored; older rows are decoded and
   validated as before. Going back to an older build and forward again records a new start, so
   rows written in between are decoded too. The table is created at open, so it needs no
   migration step and so no pre-upgrade backup.
4. **Writes still validate, and canonicalise cheaply where the schema allows.** The writer
   (`event-writer.ts`, `store-stream.ts`) makes every event canonical with `canonicalEvent`
   (`canonical-event.ts`) before storing it. Its output equals `Event.parse`'s: the same values,
   defaults, key order and stored JSON, and a rejection wherever `Event.parse` rejects. For a
   payload variant that is a plain object with a literal discriminator and only flat fields
   (strings, numbers, booleans, literals and enums, optional or nullable, with only length,
   integer and range checks; `item.delta` is the hot one), it runs those checks and rebuilds the
   event in schema order itself, from plans read off the schema once. Each check matches Zod's
   meaning: lengths count code points, enums accept Zod's resolved values. Anything else has no
   plan: a nested object, a default, a transform or pipe, a refinement, a schema that is itself a
   check (`z.int()`, a string format), a non-literal discriminator, an envelope of another shape.
   Building the plans never throws for a shape they don't know; a variant that changes loses its
   plan by itself. Unplanned variants, every input a plan rejects, and every input that isn't
   plain data (a proxy, a getter, an inherited field, which the plan detects without running
   them) go to `Event.parse`. `canonical-event.test.ts` runs both on every planned variant,
   mutated field by field, and on the payloads of the recorded provider sessions;
   `canonical-event-schemas.test.ts` does the same on synthetic schemas for each of those
   shapes. Both assert identical output, and a rejection exactly where Zod rejects.
5. **Thread rows are trusted per row, by revision.** A threads row is rewritten in place a few
   columns at a time and has no sequence, so `thread-row-trust.ts` keeps a side table of
   stamps: the row revision at which this build confirmed the whole row reads the same as
   stored as validated, field order included. Every write to a threads or thread_cold row
   takes a new, never reused revision, so a stamp names exactly the content confirmed. The
   writer moves a row's stamp to the revision it writes when the row was confirmed and the
   parts it wrote read the same as stored; rows changed any other way (direct SQL, another
   build) are confirmed again at a later open, at most 256 per open, most recently updated
   first. The stamps belong to a shape that fingerprints the thread schemas, the migration
   version and the decoders' code; a different shape drops them all. The tables are created at
   open, with no migration step.
6. **Older rows regain trust in an idle pass.** A shape change used to leave every older row
   on the validating path for good, and the protocol changes on most releases, so on the
   owner's store 97.9% of events (below seq 9,273,457 of 9,470,234) paid Zod on every read.
   `stored-trust-pass.ts` walks history down from the trusted boundary, one batch per idle
   tick (every 200 ms). A tick does nothing while a thread is working or waiting on its own
   work, a transaction is open, history is being published, maintenance holds writes, live
   output is buffered, or any event was written since the previous tick.

   - **What a batch checks** (`stored-trust-batch.ts`). Up to 512 events below the
     boundary. For each event's sequence, every row a read trusts by that sequence, enumerated
     by the sequence itself and never by what the event names: the event, the item created at
     it and its text preview, every history revision at it and every streamed text chunk at it,
     whichever item they belong to. Each row is read both validated and as stored, and the
     sequence becomes trusted only when every row gives the same value, field order and byte
     size both ways. Revisions and chunks are found through indexes on their sequence
     (`history_item_revisions_seq`, `item_text_chunks_seq`), created at open with
     `IF NOT EXISTS` like this table's other indexes. The first open after the upgrade builds
     them once, measured at 389 ms for 2 million revision rows, with no migration step or
     version bump. Each adds one index entry per revision or chunk written.
     `stored-trust-coverage.test.ts` plants a row of each kind that the event at its sequence
     doesn't name, and is where a new trusted read adds its kind.
   - **What a batch costs.** Every body's size is read from SQLite's record header
     (`octet_length`, which loads no content) before the body is loaded. Every load is charged
     to a 1 MiB budget, so a batch loads at most 1 MiB of stored JSON.
   - **What stays validated.** A sequence goes into `stored_event_rejected` when any of its
     rows differs, fails validation or isn't valid JSON. It is also rejected unchecked when
     its rows together exceed the budget, and when an item, revision or chunk is written at
     it whose event is gone. Every row at a rejected sequence keeps the
     lenient validating decode exactly as before: a rejected item also puts the event at the
     same sequence back on the validating path. The pass stops extending trust after 100,000
     rejections, which are held in memory.
   - **Progress.** Widening trust never changes what a read returns, so progress is held in
     memory and saved (`stored_event_confirmed` and the rejections) every 32 batches and at
     close. A crash repeats at most 32 batches.
   - **Writes that change no thread read.** The pass writes only through
     `stored-trust-writes.ts`: named operations (save progress and rejections, stamp thread
     rows) whose SQL is fixed in `stored-shape.ts` and `thread-row-trust.ts` and touches only
     the trust tables. Each commits outside the store's transaction hooks, so it wakes no
     listener or WAL maintenance, and the thread read cache carries its entries over it
     unless another connection committed meanwhile. No API hands a caller a connection under
     that carry-over: a new trust write is a new named operation there.
   - **Whose record it is.** The trusted boundary and the record belong to one build and one
     write generation.
     - The build key is the release version (`ACE_VERSION`) hashed with a build id: a
       digest the release bundle step writes as `build-id` beside `ace.mjs`
       (`tools/release/src/build-id.ts`). It covers every daemon file: the entry, its
       chunks, every separately bundled helper (the fixed-name `*-worker.mjs`,
       `*-process.mjs`, `*-host.mjs`), runtime packages, and native and wasm assets.
     - Any change to the shipped code changes the key. That includes a protocol transform,
       refinement or decoder, which the shape can't see, and a local rebuild of the same
       version with different files. A rebuild of identical files keeps the key.
     - When the shape or the key differs from what is recorded, trust starts above the head
       even though the shape is unchanged, and the idle pass re-confirms older rows, newest
       first. So after every update, history reads are validated (the speed before this
       decision) until the pass has re-confirmed them, most recent rows first.
     - A daemon run from source, or a release without a readable build id, has no key and
       records a new start at every open, keeping nothing.
     - The history publication worker reads the same `build-id` beside its own file. It
       refuses to publish when its key differs from the daemon's (the release on disk
       changed under a running daemon). It opens trust read-only: it never writes the
       record or a start, and runs no pass. The
       generation is a counter that SQLite triggers bump on every write to `stored_event_shape`,
       by any build, including builds from before the pass. So a build that recorded its start
       in between, even one that later records this shape again, invalidates the record. Every
       batch checks the generation before it reads, and a save succeeds only while the record
       still matches. On a mismatch the running daemon drops all stored-row trust until it
       opens again. Once the pass finishes, nothing watches the generation. This is safe only
       because one daemon owns a data directory (`acquireLock`), so another build writing
       while this one runs is unsupported.
   - **At open.** The start, the reset and the rejections change in one savepoint, so an
     interrupted open leaves the previous state whole. Trust is decided after the open-time
     passes that rewrite stored rows.
   - **Raw rewrites.** Any code that rewrites `events`, `items`, `item_previews` or
     `history_item_revisions` with raw SQL, rather than from a validated value, must call
     `forgetStoredTrust` in the same transaction, as `mapRecordedPermissionModes` does.
   - **Other connections.** One daemon owns a data directory (`acquireLock` in
     `local-files.ts`). The only other writer of events and items is the history publication
     worker, a second connection in the same build that writes validated rows above the head
     and runs no pass of its own.
   - **Thread rows and tables.** The pass also confirms the thread rows still unconfirmed after
     open (decision 5), 64 at a time, before older events. The tables and triggers are
     created at open, with no migration step and no schema version bump.

   A cheaper rule, keeping old rows trusted across a change that only adds optional fields or
   new variants, was considered and not adopted. The fingerprint is a JSON Schema export that
   renders transforms and refinements as "any", so a diff of it can't prove a change
   additive. Key order, defaults and Zod's stripping of unknown keys also make "additive"
   changes visible in decoded rows. Every new build re-verifies in the background instead.

7. **Trusted casts live in one place.** `stored-decode.ts` holds the casts from trusted stored
   JSON to protocol types; other modules call its functions.

## Consequences

- Event replay and thread item pages skip validation for rows this build wrote. Byte budgets
  are the same: a trusted event is sized from its stored JSON and envelope, which is what
  serialising it again would give.
- A bug that writes a wrongly shaped row is no longer caught on read. Writes validate, and the
  fingerprint covers schema changes, which were the realistic source of mismatched rows.
- On a copy of the owner's store all 1,586 thread rows confirm, and decoding one costs 7.9 µs
  of CPU instead of 64 µs (`apps/daemon/bench/thread-rows.ts`). Confirming every row after an
  upgrade costs about 180 ms of CPU, which is why it is spread over opens.
- On a 20,040-event fixture (`apps/daemon/bench/stored-trust-pass.ts`, 40 threads of 500
  messages of about 400 bytes), with the boundary at the head after a shape change against
  after the pass: replaying all events costs 111 ms of CPU against 38 ms (2.9×), and opening
  the 40 threads' 200-item tails 72 ms against 51 ms (1.4×). The pass costs about 35 µs of
  CPU per event (the event and its item, preview and revision, each read both ways), 14 ms a
  batch at the median and 23 ms at worst. With 64 KiB messages a batch takes 25 ms at the
  median and 33 ms at worst: the byte budget, not the event count, bounds it. At one batch per
  200 ms idle tick that is under a tenth of one core while idle. The owner's 9.27 million
  older events would take about five minutes of CPU, spread over about an hour of idle time,
  once per release.
- Checked against real protocol history (`apps/daemon/bench/stored-trust-compat.ts`): the
  5,525 payloads of the recorded provider sessions, stored as builds from 1, 3, 10, 14 and 22
  days earlier would have stored them, all read the same under the current schema, so the
  pass confirms 100% of them. A deliberately added default on messages makes 4.3% of those
  rows differ, all message items: the pass then helps less, and stops at the rejection
  limit.
- Not detected: a build that drops or recreates `stored_event_shape`'s triggers, or rewrites
  rows without writing `stored_event_shape`, leaves the generation unchanged. Builds with
  the current schema version all record their start (older ones are refused by
  `migrate`), but none of them removes the triggers.
- Trust is no longer a single boundary: a read checks the sequence against the boundary and
  the rejected set (`isTrusted` in `stored-decode.ts`).
- Further slices follow the same rule: history revisions, entity pages, search
  replay and worker messages.
