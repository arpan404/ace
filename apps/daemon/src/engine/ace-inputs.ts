import { z } from "zod";
import { DelegationOutcome, type ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Store } from "../store.ts";

const Input = z.object({
  agent: z.string(),
  item: z.string(),
  text: z.string(),
  results: z.array(DelegationOutcome).max(64),
});
type Input = z.infer<typeof Input>;
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
    )`),
    );
  }
  record(thread: ThreadId, command: string, input: Input) {
    this.store
      .statement("INSERT OR IGNORE INTO engine_ace_inputs VALUES (?,?,?)")
      .run(thread, command, JSON.stringify(input));
  }
  get(thread: ThreadId, command: string): Input | undefined {
    const row = this.store
      .statement("SELECT value FROM engine_ace_inputs WHERE thread_id=? AND command_id=?")
      .get(thread, command);
    return row ? Input.parse(JSON.parse(z.string().parse(row.value))) : undefined;
  }
  /** Native transports may echo user-role input. Fold that echo into its ace item. */
  attribute(thread: ThreadId, fact: Fact): Fact {
    if (
      (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
      fact.draft.type !== "message" ||
      fact.draft.role !== "user"
    )
      return fact;
    const text =
      fact.draft.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "";
    const match = /^\[ace-origin:delegation\.settled:([^\]]+)\]\n/.exec(text);
    if (!match?.[1]) return fact;
    const source = this.get(thread, match[1]);
    if (!source || source.text !== text) return fact;
    return {
      type: "item.upsert",
      agent: source.agent,
      item: source.item,
      draft: {
        type: "delegation.settled",
        complete: true,
        results: source.results,
        delivery: "ace-input",
        origin: "ace",
        ...(fact.draft.raw ? { raw: fact.draft.raw } : {}),
      },
    };
  }
}
