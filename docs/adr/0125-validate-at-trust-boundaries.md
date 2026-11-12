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
   payload variant whose fields are all flat (strings, numbers, booleans, literals and enums,
   optional or nullable, with only length, integer and range checks; `item.delta` is the hot
   one), it runs those checks and rebuilds the event in schema order itself, from plans read off
   the schema once, so no default or transform can be missed: a variant with anything else in it
   has no plan. Unplanned variants, and every input a plan rejects, go to `Event.parse`. A
   variant that gains a nested object, a default or another kind of check loses its plan by
   itself; `canonical-event.test.ts` runs both on every planned variant, mutated field by field,
   and on the payloads of the recorded provider sessions, and asserts identical output.
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
6. **Trusted casts live in one place.** `stored-decode.ts` holds the casts from trusted stored
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
- Further slices follow the same rule: history revisions, entity pages, search
  replay and worker messages.
