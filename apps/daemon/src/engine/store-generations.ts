import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/*
 * Which generation of its provider-private session store each thread uses (ADR 0211). A thread
 * starts on the first (0, no row). When its saved session can never be opened again, ace moves it
 * to the next generation in the same transaction that hands its context over, so a restart opens
 * the fresh store, never the old one again. Earlier generations' folders are kept.
 */

/** Far past any real thread: a store that fails this often is not a store problem. */
export const maxStoreGeneration = 64;

export class StoreGenerations {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_store_generations (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL
      )`),
    );
  }
  get(id: ThreadId): number {
    const row = this.store
      .statement("SELECT generation FROM engine_store_generations WHERE thread_id=?")
      .get(id);
    return row ? z.number().int().nonnegative().parse(row.generation) : 0;
  }
  /** Moves the thread to its next generation and returns it. Call inside the handoff's commit. */
  advance(id: ThreadId): number {
    const next = this.get(id) + 1;
    this.store
      .statement(
        `INSERT INTO engine_store_generations VALUES (?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET generation=excluded.generation`,
      )
      .run(id, next);
    return next;
  }
}
