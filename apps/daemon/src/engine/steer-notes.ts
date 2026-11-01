import type { StatementSync } from "node:sqlite";
import type { Store } from "../store.ts";

/**
 * What the person did to a waiting message's steering, kept durably beside the intent:
 * - `person`: the person chose to steer it in (an agent's message too), so it goes in as
 *   their own steer does, moving a running command out of the way;
 * - `fell_back`: it was a steer the provider refused, so it went back to the queue as the next
 *   message; the queue says so until it is delivered or steered again.
 */
export class SteerNotes {
  private store: Store;
  private statements = new Map<string, StatementSync>();
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_steer_notes (
        intent_id INTEGER PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE,
        person INTEGER NOT NULL DEFAULT 0, fell_back INTEGER NOT NULL DEFAULT 0)`),
    );
  }
  private sql(source: string): StatementSync {
    let statement = this.statements.get(source);
    if (!statement) {
      statement = this.store.atomic((db) => db.prepare(source));
      this.statements.set(source, statement);
    }
    return statement;
  }
  /** The person steered the waiting message in: it no longer reads as fallen back. */
  personSteered(intent: number): void {
    this.sql(`INSERT INTO engine_steer_notes(intent_id,person,fell_back) VALUES (?,1,0)
      ON CONFLICT(intent_id) DO UPDATE SET person=1,fell_back=0`).run(intent);
  }
  /** The steer couldn't go in and waits in the queue as the next message. */
  fellBack(intent: number): void {
    this.sql(`INSERT INTO engine_steer_notes(intent_id,fell_back) VALUES (?,1)
      ON CONFLICT(intent_id) DO UPDATE SET fell_back=1`).run(intent);
  }
  /** Steered in again by an agent: it is a waiting steer once more, not a fallen-back one. */
  steeredAgain(intent: number): void {
    this.sql("UPDATE engine_steer_notes SET fell_back=0 WHERE intent_id=?").run(intent);
  }
  /** Whether the person chose to steer this message in. */
  personChose(intent: number): boolean {
    return Boolean(
      this.sql("SELECT 1 FROM engine_steer_notes WHERE intent_id=? AND person=1").get(intent),
    );
  }
}
