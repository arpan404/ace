import { DelegationFailure, WatchedState, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";

/** What a settled delegated thread told the other machine, as kept on this one. */
export const SettledView = z.object({
  state: WatchedState,
  elapsedSeconds: z.number().int().nonnegative(),
  result: z.string().max(4096),
  truncated: z.boolean(),
  // A failure an older or newer build wrote that this one can't read is dropped, not fatal.
  failure: DelegationFailure.optional().catch(undefined),
});
export type SettledView = z.infer<typeof SettledView>;

/**
 * The outcome a delegated thread settled with, kept until it runs again. Read live, the same
 * stop changes once its account's limit resets (the failure's account evidence goes stale, the
 * thread's state moves on), and the other machine would take it for a second result.
 */
export class TargetOutcomes {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_thread_outcomes (
        thread_id TEXT PRIMARY KEY, view TEXT NOT NULL)`),
    );
  }
  get(id: ThreadId): SettledView | undefined {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT view FROM machine_thread_outcomes WHERE thread_id=?").get(id),
    );
    if (typeof row?.view !== "string") return undefined;
    try {
      const parsed = SettledView.safeParse(JSON.parse(row.view));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  /** Keeps the first outcome of this stop; a later read of the same stop never replaces it. */
  save(id: ThreadId, view: SettledView): void {
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO machine_thread_outcomes VALUES (?,?)")
        .run(id, JSON.stringify(view)),
    );
  }
  /** It runs again: its next stop is a new outcome. */
  forget(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("DELETE FROM machine_thread_outcomes WHERE thread_id=?").run(id),
    );
  }
}
