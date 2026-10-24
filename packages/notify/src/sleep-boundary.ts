import type { StatementSync } from "node:sqlite";
import { z } from "zod";

/** Additive and idempotent, like the inbox: an existing format-4 database gains it on open. */
export const sleepTables = `
  CREATE TABLE IF NOT EXISTS sleep_boundary (id INTEGER PRIMARY KEY CHECK(id=1),
    seq INTEGER NOT NULL, at INTEGER NOT NULL);`;

const Row = z.object({ seq: z.number().int().nonnegative(), at: z.number().int() });
export type Boundary = z.infer<typeof Row>;

/**
 * Where a deliberate stop began: the log sequence after which events happened while no device
 * could take an alert, and when. Only events after it may skip their alerts on wake. A crash
 * writes nothing, so whatever it interrupted is delivered normally.
 */
export class SleepBoundary {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  /** Keeps the earlier boundary when one is already recorded: the sleep began there. */
  mark(boundary: Boundary): void {
    this.statement(
      "INSERT INTO sleep_boundary VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET seq=min(seq,excluded.seq),at=min(at,excluded.at)",
    ).run(boundary.seq, boundary.at);
  }
  get(): Boundary | undefined {
    const row = this.statement("SELECT seq,at FROM sleep_boundary WHERE id=1").get();
    return row ? Row.parse(row) : undefined;
  }
  /** The woken worker has caught up: later events are live, never covered by the sleep. */
  clear(): Boundary | undefined {
    const boundary = this.get();
    this.statement("DELETE FROM sleep_boundary WHERE id=1").run();
    return boundary;
  }
}
