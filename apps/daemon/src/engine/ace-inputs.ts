import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Store } from "../store.ts";
import { AceInput, settledInputEcho } from "./ace-input-attribution.ts";
/** Retain delegation summaries; the input journal is the sole source of message origin. */
export class AceInputs {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_ace_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(thread_id,command_id)
    )`),
    );
  }
  record(thread: ThreadId, command: string, input: AceInput) {
    this.store
      .statement("INSERT OR IGNORE INTO engine_ace_inputs VALUES (?,?,?)")
      .run(thread, command, JSON.stringify(input));
  }
  get(thread: ThreadId, command: string): AceInput | undefined {
    const row = this.store
      .statement("SELECT value FROM engine_ace_inputs WHERE thread_id=? AND command_id=?")
      .get(thread, command);
    return row ? AceInput.parse(JSON.parse(z.string().parse(row.value))) : undefined;
  }
  /** Native transports may echo user-role input. Fold that echo into its ace item. */
  attribute(thread: ThreadId, fact: Fact): Fact {
    if (
      (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
      fact.draft.type !== "message" ||
      fact.draft.role !== "user"
    )
      return fact;
    const origin = fact.draft.origin;
    if (origin?.kind !== "subagent_result" || !origin.commandId) return fact;
    return settledInputEcho(this.get(thread, origin.commandId), fact);
  }
}
