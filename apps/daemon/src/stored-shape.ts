import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Event } from "@ace/protocol";
import { z } from "zod";

/**
 * Which stored rows this build may read back without validating them again (ADR 0125).
 *
 * The writer validates every event before it stores it, so a row this build wrote is already
 * in this build's shape. A row an older build wrote may not be: a newer schema can add a field
 * with a default, or rename a variant. The shape is a fingerprint of the event schema and the
 * migration version. When it differs from the one recorded, the first sequence this build
 * writes is recorded with it; rows from there on are trusted, rows before it are decoded as
 * before. Going back to an older build and forward again records a new start, so rows written
 * in between are never mistaken for this build's.
 */
export function storedEventShape(schemaVersion: number): string {
  const schema = z.toJSONSchema(Event, { unrepresentable: "any", io: "output", cycles: "ref" });
  return createHash("sha256")
    .update(`${schemaVersion}\n${JSON.stringify(schema)}`)
    .digest("hex");
}

const Recorded = z.object({ shape: z.string(), first_seq: z.number().int().nonnegative() });

/**
 * The first sequence written in `shape`. Run after migrations and before the first append.
 * Items keep the sequence they were created at, so the same boundary applies to them.
 */
export function trustedSequenceStart(db: DatabaseSync, shape: string): number {
  db.exec(`CREATE TABLE IF NOT EXISTS stored_event_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL, first_seq INTEGER NOT NULL
  )`);
  const recorded = Recorded.safeParse(
    db.prepare("SELECT shape, first_seq FROM stored_event_shape WHERE id = 1").get(),
  );
  if (recorded.success && recorded.data.shape === shape) return recorded.data.first_seq;
  const head = z
    .number()
    .int()
    .nonnegative()
    .parse(
      db
        .prepare(
          "SELECT MAX(COALESCE((SELECT seq FROM host_sequence WHERE id = 1), 0), COALESCE((SELECT MAX(seq) FROM events), 0)) AS head",
        )
        .get()?.head,
    );
  db.prepare(
    "INSERT INTO stored_event_shape VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape, first_seq = excluded.first_seq",
  ).run(shape, head + 1);
  return head + 1;
}
