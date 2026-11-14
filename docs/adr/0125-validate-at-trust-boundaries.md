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
   `stored-trust-pass.ts` walks history down from the trusted boundary while the daemon is
   idle: a tick does work only when no transaction, history write or buffered stream output is
   in flight and the head sequence hasn't moved since the previous tick, and checks again
   before each batch. A batch is the 512 events below the boundary plus every item, text
   preview and history revision written at their sequences; each row is read both validated
   and as stored, and its sequence stays trusted only when both give the same value, field
   order and byte size. A row that differs or that validation rejects puts its sequence in
   `stored_event_rejected`, so it keeps the lenient validating decode exactly as before. Each
   batch commits the new boundary (`stored_event_verified`) and its rejections in the
   transaction that read the rows, so an interrupted pass resumes where it stopped. The
   record belongs to one shape and to the start recorded with it: a different shape, or any
   build (old or new) recording a new start in between, drops it, and the pass simply runs
   again. The pass stops extending trust after 10,000 rejections, since a change that alters
   most old rows gains little and each rejection is held in memory. It also confirms the thread
   rows still unconfirmed after open (decision 5), 64 at a time, before older events. The
   tables are created at open, with no migration step and no schema version bump.

   A cheaper rule, keeping old rows trusted across a change that only adds optional fields or
   new variants, was considered and not adopted: the fingerprint is a JSON Schema export that
   renders transforms and refinements as "any", so a diff of it can't prove a change additive,
   and key order, defaults and Zod's stripping of unknown keys all make "additive" changes
   visible in decoded rows. Every shape change re-verifies in the background instead.

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
  messages), with the boundary at the head after a shape change against after the pass:
  replaying all events costs 93 ms of CPU against 32 ms (2.9×), and opening the 40 threads'
  200-item tails 53 ms against 39 ms (1.3×). The pass costs about 21 µs of CPU per event
  (the event and its item, preview and revision, each read both ways), about 10 ms a batch;
  at two batches per 250 ms idle tick that is under a tenth of one core while idle, and about
  three minutes of CPU spread over idle time for the owner's 9.27 million older events.
- Trust is no longer a single boundary: a read checks the sequence against the boundary and
  the rejected set (`isTrusted` in `stored-decode.ts`).
- Further slices follow the same rule: history revisions, entity pages, search
  replay and worker messages.
