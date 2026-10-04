import { z } from "zod";
import type { Fact, ThreadState } from "@ace/core";
import type { EventPayload, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/** Durable native request ownership, independent of transcript paging and translator lifetimes. */
export class InteractionLedger {
  constructor(privateStore: Store) {
    this.store = privateStore;
    privateStore.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS engine_interaction_requests (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        interaction_id TEXT NOT NULL, native_key TEXT NOT NULL, native_item TEXT,
        binding TEXT NOT NULL, generation INTEGER, state TEXT NOT NULL,
        PRIMARY KEY(thread_id,interaction_id));
        CREATE INDEX IF NOT EXISTS engine_requests_generation ON engine_interaction_requests(thread_id,generation);
        CREATE INDEX IF NOT EXISTS engine_requests_native ON engine_interaction_requests(thread_id,binding,native_item,state);
        CREATE INDEX IF NOT EXISTS engine_requests_key ON engine_interaction_requests(thread_id,native_key,state);`);
      // Backfill terminal outcomes written before this ledger existed.
      db.exec(`INSERT OR IGNORE INTO engine_interaction_requests
        SELECT r.thread_id,json_extract(r.value,'$.id'),r.key,
          (SELECT key FROM engine_state_records i WHERE i.thread_id=r.thread_id AND i.section='items' AND json_extract(i.value,'$.id')=json_extract(r.value,'$.toolCallId') LIMIT 1),
          COALESCE(s.native_session_id,''),NULL,json_extract(r.value,'$.state')
        FROM engine_state_records r JOIN engine_sessions s ON s.thread_id=r.thread_id
        WHERE r.section='interactions' AND json_extract(r.value,'$.state')<>'pending';`);
    });
  }
  private store: Store;
  latestGeneration(id: ThreadId): number {
    return z.number().int().nonnegative().parse(this.store.statement("SELECT COALESCE(MAX(generation),0) AS generation FROM engine_interaction_requests WHERE thread_id=?").get(id)?.generation);
  }
  private binding(id: ThreadId): string {
    const row = this.store
      .statement("SELECT native_session_id FROM engine_sessions WHERE thread_id=?")
      .get(id);
    return row?.native_session_id == null ? "" : z.string().parse(row.native_session_id);
  }
  terminalItem(id: ThreadId, item: string): boolean {
    return Boolean(
      this.store
        .statement(
          "SELECT 1 FROM engine_interaction_requests WHERE thread_id=? AND binding=? AND native_item=? AND state<>'pending' LIMIT 1",
        )
        .get(id, this.binding(id), item),
    );
  }
  obsolete(id: ThreadId, fact: Fact): boolean {
    if (fact.type === "interaction.opened") {
      if (fact.item && this.terminalItem(id, fact.item)) return true;
      return false;
    }
    return (
      (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
      fact.draft.type === "tool_call" &&
      fact.draft.call?.status === "awaiting_approval" &&
      this.terminalItem(id, fact.item)
    );
  }
  opened(state: ThreadState, fact: Fact, generation: number | undefined): void {
    if (fact.type !== "interaction.opened") return;
    const interaction = state.interactions[fact.interaction];
    if (!interaction || interaction.state !== "pending") return;
    this.store
      .statement("INSERT OR IGNORE INTO engine_interaction_requests VALUES (?,?,?,?,?,?,?)")
      .run(
        state.threadId,
        interaction.id,
        fact.interaction,
        fact.item ?? null,
        this.binding(state.threadId),
        generation ?? null,
        interaction.state,
      );
  }
  observe(id: ThreadId, events: EventPayload[]): void {
    for (const event of events)
      if (event.type === "interaction.closed")
        this.store
          .statement(
            "UPDATE engine_interaction_requests SET state=? WHERE thread_id=? AND interaction_id=?",
          )
          .run(event.state, id, event.interactionId);
  }
  closed(state: ThreadState, event: Extract<EventPayload, { type: "interaction.closed" }>): Fact[] {
    const row = this.store
      .statement(
        "SELECT native_key,native_item FROM engine_interaction_requests WHERE thread_id=? AND interaction_id=?",
      )
      .get(state.threadId, event.interactionId);
    if (!row) return [];
    const key = z.string().parse(row.native_key);
    if (event.state === "expired") {
      event.expirationReason = "provider_disconnected";
      const interaction = state.interactions[key];
      if (interaction?.id === event.interactionId)
        interaction.expirationReason = event.expirationReason;
    }
    if (typeof row.native_item !== "string") return [];
    const item = state.items[row.native_item];
    if (
      item?.type !== "tool_call" ||
      !["pending", "running", "awaiting_approval"].includes(item.call.status)
    )
      return [];
    return [
      {
        type: "item.upsert",
        agent: state.indexes.agentKeysById[item.agentId] ?? state.rootKey ?? "root",
        item: row.native_item,
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            status: event.state === "resolved" ? "succeeded" : "cancelled",
            endedAt: event.closedAt,
          },
        },
      },
    ];
  }
  owner(id: ThreadId, interaction: string): number | undefined {
    const value = this.store
      .statement(
        "SELECT generation FROM engine_interaction_requests WHERE thread_id=? AND interaction_id=? AND state='pending'",
      )
      .get(id, interaction)?.generation;
    return value == null ? undefined : z.number().int().nonnegative().parse(value);
  }
}
