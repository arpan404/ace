import { ContextSample, foldContext, type ContextChange } from "./context-sample.ts";
import { type EventPayload, type ThreadId, type ProviderKind } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { ThreadState } from "@ace/core";
import type { StatementSync } from "node:sqlite";
export type ContextWindowLookup = (
  provider: ProviderKind,
  instance: string | undefined,
  model: string,
) => number | undefined;
/** One replaceable row per agent. Never sum billing counters to estimate occupancy. */
export class ContextMeters {
  private store: Store;
  private lookup: ContextWindowLookup;
  private read: StatementSync;
  private write: StatementSync;
  private list: StatementSync;
  private count: StatementSync;
  constructor(store: Store, lookup: ContextWindowLookup = () => undefined) {
    this.store = store;
    this.lookup = lookup;
    const statements = store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS engine_context (
        thread_id TEXT NOT NULL REFERENCES threads(id), agent_id TEXT NOT NULL, sample JSON NOT NULL,
        PRIMARY KEY(thread_id,agent_id)
      )`);
      return {
        count: db.prepare("SELECT COUNT(*) AS n FROM engine_context WHERE thread_id=?"),
        read: db.prepare("SELECT sample FROM engine_context WHERE thread_id=? AND agent_id=?"),
        write: db.prepare(
          "INSERT INTO engine_context VALUES (?,?,?) ON CONFLICT(thread_id,agent_id) DO UPDATE SET sample=excluded.sample",
        ),
        list: db.prepare("SELECT agent_id,sample FROM engine_context WHERE thread_id=? LIMIT 4096"),
      };
    });
    this.read = statements.read;
    this.write = statements.write;
    this.list = statements.list;
    this.count = statements.count;
  }
  private save(id: ThreadId, value: ContextSample, at: number): void {
    this.write.run(id, value.meter.agentId, JSON.stringify(value));
    this.store.appendEvents(id, [{ type: "context_meter.updated", meter: value.meter }], at);
  }
  invalidate(id: ThreadId, at: number): void {
    for (const row of this.list.all(id)) {
      const sample = ContextSample.parse(JSON.parse(String(row.sample)));
      const next = foldContext(sample, { type: "invalidate" });
      if (next) this.save(id, next, at);
    }
  }
  observe(state: ThreadState, events: EventPayload[], at: number, instance?: string): void {
    for (const event of events) {
      // Inclusive model/session billing snapshots describe many samplings and models,
      // never the current occupied context.
      if (
        event.type === "usage.updated" &&
        (event.usageScope === "model_session" || event.usageScope === "provider_session")
      )
        continue;
      const compaction =
        (event.type === "item.created" || event.type === "item.updated") &&
        event.item.type === "compaction"
          ? event.item
          : undefined;
      const compacting =
        event.type === "agent.status" &&
        event.status.state === "working" &&
        event.status.activity === "compacting";
      const modelChanged = event.type === "agent.updated" && event.model !== undefined;
      if (
        event.type !== "usage.updated" &&
        event.type !== "context.sampled" &&
        !compaction &&
        !compacting &&
        !modelChanged
      )
        continue;
      const agentId = "agentId" in event ? event.agentId : compaction?.agentId;
      if (!agentId) continue;
      const row = this.read.get(state.threadId, agentId);
      const prior = row ? ContextSample.parse(JSON.parse(String(row.sample))) : undefined;
      if (!prior && Number(this.count.get(state.threadId)?.n) >= 4096) continue;
      const sample =
        prior ??
        ContextSample.parse({
          meter: { agentId, epoch: 0, usedTokens: null, windowTokens: null, source: "unknown" },
          session: null,
          compaction: null,
        });
      let change: ContextChange;
      if (compaction)
        change = { type: "compaction", id: `${compaction.id}:${compaction.complete}` };
      else if (compacting) change = { type: "invalidate" };
      else if (
        event.type === "usage.updated" ||
        event.type === "context.sampled" ||
        event.type === "agent.updated"
      ) {
        const agentModel = state.agents[state.indexes.agentKeysById[agentId] ?? ""]?.agent.model;
        const model = event.model ?? sample.meter.model ?? agentModel;
        change = {
          type: "sample",
          model,
          catalog: model ? this.lookup(state.config.provider, instance, model) : undefined,
          session:
            event.type === "usage.updated"
              ? event.contextSessionId
              : event.type === "context.sampled"
                ? event.sessionId
                : undefined,
          used:
            event.type === "usage.updated"
              ? event.contextTokens
              : event.type === "context.sampled"
                ? event.usedTokens
                : undefined,
          window:
            event.type === "usage.updated"
              ? event.contextWindow
              : event.type === "context.sampled"
                ? event.windowTokens
                : undefined,
        };
      } else continue;
      const next = foldContext(sample, change);
      if (next) this.save(state.threadId, ContextSample.parse(next), at);
    }
  }
}
