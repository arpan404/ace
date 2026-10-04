import { piInput } from "@ace/adapter-pi";
import { claudeInputContent } from "@ace/adapter-claude";
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
    store.atomic((db) => {
      if (!db.prepare("PRAGMA table_info(engine_inputs)").all().some((field) => field.name === "generation"))
        db.exec("ALTER TABLE engine_inputs ADD COLUMN generation INTEGER");
      db.exec(`CREATE INDEX IF NOT EXISTS engine_inputs_delivery ON engine_inputs(thread_id,generation,signature,sent,matched,ordinal);
        DELETE FROM engine_input_echoes WHERE thread_id NOT IN (SELECT id FROM threads);
        DELETE FROM engine_inputs WHERE thread_id NOT IN (SELECT id FROM threads);
        CREATE TRIGGER IF NOT EXISTS engine_inputs_delete AFTER DELETE ON threads BEGIN
          DELETE FROM engine_input_echoes WHERE thread_id=OLD.id;
          DELETE FROM engine_inputs WHERE thread_id=OLD.id;
        END;`);
    });
  }
  invalidate(thread: ThreadId, key: string): void {
    this.store.statement("DELETE FROM engine_input_echoes WHERE thread_id=? AND item_key=?").run(thread, key);
    this.store.statement("DELETE FROM engine_inputs WHERE thread_id=? AND item_key=?").run(thread, key);
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
    generation?: number,
  ): void {
    this.store
      .statement("UPDATE engine_inputs SET signature=?,sent=1,generation=? WHERE thread_id=? AND item_key=?")
      .run(
        provider === "pi" ? signature([{ type: "text", text: piInput(parts).message }])
          : provider === "claude" ? createHash("sha256").update(claudeInputContent(parts).flatMap((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n")).digest("hex")
          : signature(parts),
        generation ?? null,
        thread,
        key,
      );
  }
  correlate(thread: ThreadId, fact: Fact, root: string, generation?: number): Fact | undefined {
    if (!("agent" in fact) || fact.agent !== root || fact.type === "item.delta") return fact;
    const alias = this.store.statement("SELECT item_key FROM engine_input_echoes WHERE thread_id=? AND native_key=?").get(thread, "item" in fact ? fact.item : "");
    if (fact.type === "item.delta") return alias && fact.field === "text" ? undefined : fact;
    if ((fact.type !== "item.upsert" && fact.type !== "item.reconciled") || fact.draft.type !== "message" || (fact.draft.role !== "user" && !alias)) return fact;
    if (fact.draft.origin && fact.draft.origin.kind !== "person" && !fact.draft.origin.commandId) return fact;
    if (!alias && !fact.draft.parts) return fact;
    const row =
      alias ??
      this.store
        .statement(
          "SELECT item_key,origin FROM engine_inputs WHERE thread_id=? AND signature=? AND generation=? AND sent=1 AND matched=0 ORDER BY ordinal LIMIT 1",
        )
        .get(thread, signature(fact.draft.parts ?? []), generation ?? null);
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
