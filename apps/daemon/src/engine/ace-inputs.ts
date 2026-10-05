import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Store } from "../store.ts";
import { AceInput, settledInputEcho } from "./ace-input-attribution.ts";
// Adapters may report extra metadata. Origin is derived exclusively from the host command.
const MessageIdentity = z.object({
  commandId: z.string().min(1).max(512),
  nativeId: z.string().min(1).max(256),
});
const Correlation = z.object({ command_id: z.string(), origin: z.enum(["ace", "user"]) });
/** Durable attribution survives native replay, reconnects and daemon restarts. */
export class AceInputs {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_ace_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(thread_id,command_id)
    );
    CREATE TABLE IF NOT EXISTS engine_input_messages (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      native_id TEXT NOT NULL, command_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('ace','user')),
      PRIMARY KEY(thread_id,native_id)
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
  correlate(thread: ThreadId, identity: unknown): void {
    const { commandId, nativeId } = MessageIdentity.parse(identity);
    this.store.atomic(() => {
      const row = this.store
        .statement(
          "SELECT command_id,origin FROM engine_input_messages WHERE thread_id=? AND native_id=?",
        )
        .get(thread, nativeId);
      if (row) {
        if (Correlation.parse(row).command_id !== commandId)
          throw new Error("Provider reused an input message identity for a different command");
        return;
      }
      this.store
        .statement("INSERT INTO engine_input_messages VALUES (?,?,?,?)")
        .run(thread, nativeId, commandId, this.get(thread, commandId) ? "ace" : "user");
    });
  }
  /** Native transports may echo user-role input. Fold that echo into its ace item. */
  attribute(thread: ThreadId, fact: Fact): Fact {
    if (
      (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
      fact.draft.type !== "message" ||
      fact.draft.role !== "user"
    )
      return fact;
    if (!fact.draft.nativeId) return fact;
    const row = this.store
      .statement(
        "SELECT command_id,origin FROM engine_input_messages WHERE thread_id=? AND native_id=?",
      )
      .get(thread, fact.draft.nativeId);
    if (!row) return fact;
    const correlation = Correlation.parse(row);
    if (correlation.origin !== "ace") return fact;
    return settledInputEcho(this.get(thread, correlation.command_id), fact);
  }
}
