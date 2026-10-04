import { createHash } from "node:crypto";
import { z } from "zod";
import { MessageOrigin, type Command, type ContentPart, type ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Store } from "../store.ts";

export function inputOrigin(command: Command): MessageOrigin {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.send")
    return { kind: "person", commandId: command.id };
  if (p.origin) return { ...p.origin, commandId: command.id };
  const trigger = p.trigger;
  const kind =
    trigger === "user" || trigger === "unknown" || !trigger
      ? "person"
      : trigger === "goal"
        ? "parent_agent"
        : trigger;
  return { kind, commandId: command.id };
}
function signature(parts: ContentPart[]): string {
  return createHash("sha256")
    .update(
      parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
    )
    .digest("hex");
}
/** Durable, indexed echo correlation. Transcript history is never scanned on a frame. */
export class InputJournal {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_inputs (
      ordinal INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, item_key TEXT NOT NULL,
      signature TEXT NOT NULL, origin JSON NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0, UNIQUE(thread_id,item_key));
      CREATE INDEX IF NOT EXISTS engine_inputs_echo ON engine_inputs(thread_id,signature,sent,matched,ordinal);
      CREATE TABLE IF NOT EXISTS engine_input_echoes (
        thread_id TEXT NOT NULL, native_key TEXT NOT NULL, item_key TEXT NOT NULL,
        PRIMARY KEY(thread_id,native_key));`),
    );
  }
  register(thread: ThreadId, key: string, parts: ContentPart[], origin: MessageOrigin): void {
    this.store
      .statement(
        "INSERT OR IGNORE INTO engine_inputs(thread_id,item_key,signature,origin) VALUES (?,?,?,?)",
      )
      .run(thread, key, signature(parts), JSON.stringify(origin));
  }
  sending(
    thread: ThreadId,
    key: string,
    parts: ContentPart[],
    provider?: import("@ace/protocol").ProviderKind,
  ): void {
    this.store
      .statement("UPDATE engine_inputs SET signature=?,sent=1 WHERE thread_id=? AND item_key=?")
      .run(
        signature(
          provider === "claude"
            ? parts.map((part) =>
                part.type === "file" ? { type: "text", text: `@${part.path}` } : part,
              )
            : parts,
        ),
        thread,
        key,
      );
  }
  correlate(thread: ThreadId, fact: Fact, root: string): Fact {
    if (
      (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
      fact.agent !== root ||
      fact.draft.type !== "message" ||
      fact.draft.role !== "user" ||
      !fact.draft.parts
    )
      return fact;
    if (fact.draft.origin && fact.draft.origin.kind !== "person" && !fact.draft.origin.commandId)
      return fact;
    const alias = this.store
      .statement("SELECT item_key FROM engine_input_echoes WHERE thread_id=? AND native_key=?")
      .get(thread, fact.item);
    const row =
      alias ??
      this.store
        .statement(
          "SELECT item_key,origin FROM engine_inputs WHERE thread_id=? AND signature=? AND sent=1 AND matched=0 ORDER BY ordinal LIMIT 1",
        )
        .get(thread, signature(fact.draft.parts));
    if (!row) return fact;
    const key = z.string().parse(row.item_key);
    if (key === fact.item && !alias) return fact;
    this.store
      .statement("UPDATE engine_inputs SET matched=1 WHERE thread_id=? AND item_key=?")
      .run(thread, key);
    this.store
      .statement("INSERT OR IGNORE INTO engine_input_echoes VALUES (?,?,?)")
      .run(thread, fact.item, key);
    const originRow = this.store
      .statement("SELECT origin FROM engine_inputs WHERE thread_id=? AND item_key=?")
      .get(thread, key);
    const origin = MessageOrigin.parse(JSON.parse(z.string().parse(originRow?.origin)));
    // Keep the person's original parts; provider input may contain expanded context.
    const { parts: _parts, ...draft } = fact.draft;
    return {
      ...fact,
      item: key,
      draft: {
        ...draft,
        origin,
        synthetic: origin.kind !== "person" && origin.kind !== "queue",
        nativeId: fact.draft.nativeId ?? fact.item,
      },
    };
  }
}
