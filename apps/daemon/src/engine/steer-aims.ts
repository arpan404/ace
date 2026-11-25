import type { StatementSync } from "node:sqlite";
import type { Store } from "../store.ts";

/**
 * The turn each admitted steer was sent into, kept durably beside the intent: the root run that
 * was active when the person sent or chose it, or `null` when the thread sat between turns.
 *
 * It stays out of the payload on purpose. A payload `runId` fences every steer that carries it,
 * so only a live session that steers by cancelling (ACP) is stamped with one; a native provider
 * handles its own steer and a run would fence an input it never asked for. Every steer records
 * this aim instead, and only the steering lane's cancel path reads it: a steer admitted before
 * its session opened has no payload target, yet must not cancel the turn its first prompt starts.
 */
export class SteerAims {
  private store: Store;
  private statements = new Map<string, StatementSync>();
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_steer_aims (
        intent_id INTEGER PRIMARY KEY, run TEXT)`),
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
  /** Records the turn the steer went into at admission, replacing any target it kept. */
  record(intent: number, run: string | null): void {
    this.sql(
      "INSERT INTO engine_steer_aims(intent_id,run) VALUES (?,?) ON CONFLICT(intent_id) DO UPDATE SET run=excluded.run",
    ).run(intent, run);
  }
  /** The recorded turn: `null` when none ran, `undefined` when the steer never recorded one. */
  aim(intent: number): string | null | undefined {
    const row = this.sql("SELECT run FROM engine_steer_aims WHERE intent_id=?").get(intent);
    if (!row) return undefined;
    return typeof row.run === "string" ? row.run : null;
  }
}
