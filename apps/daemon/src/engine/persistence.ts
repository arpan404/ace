import type { DatabaseSync } from "node:sqlite";
import type { AgentRecord, ThreadState, Fact } from "@ace/core";
import { RunId, type Item, type EventPayload } from "@ace/protocol";
import { z } from "zod";
import { recordSchemas } from "./snapshot.ts";
import { itemMetadata } from "./item-metadata.ts";
import { Records } from "./records.ts";

/** A complete core snapshot is a small header plus native-keyed entity records. */
export class Snapshot {
  readonly state: ThreadState;
  private items: Records<Item>;
  private metadata: Records<Item>;
  private sections: { flush(): void; begin(): void }[] = [];
  constructor(db: DatabaseSync, state: ThreadState) {
    const segment = <T>(section: string, schema: z.ZodType<T>, initial: Record<string, T>) => {
      const records = new Records(db, state.threadId, section, schema, initial);
      this.sections.push(records);
      return records.values;
    };
    const nativeRuns = new Map<string, Record<string, RunId>>();
    const attachRuns = (key: string, record: AgentRecord): AgentRecord => {
      if (record.nativeRuns !== undefined) {
        let runs = nativeRuns.get(key);
        if (!runs) {
          runs = segment<RunId>(
            `nativeRuns:${key}`,
            z.custom<RunId>((value) => RunId.safeParse(value).success),
            record.nativeRuns,
          );
          nativeRuns.set(key, runs);
        }
        record.nativeRuns = runs;
      }
      return record;
    };
    const agents = new Records(
      db,
      state.threadId,
      "agents",
      recordSchemas.agents,
      state.agents,
      attachRuns,
      (key, record) => {
        attachRuns(key, record);
        const { nativeRuns: runs, ...agent } = record;
        return JSON.stringify({ ...agent, ...(runs === undefined ? {} : { nativeRuns: {} }) });
      },
    );
    this.sections.push(agents);
    state.agents = agents.values;
    this.items = new Records(db, state.threadId, "items", recordSchemas.items, state.items);
    this.sections.push(this.items);
    state.items = this.items.values;
    this.metadata = new Records(db, state.threadId, "itemMetadata", recordSchemas.items, {});
    this.sections.push(this.metadata);
    state.runs = segment("runs", recordSchemas.runs, state.runs);
    state.interactions = segment("interactions", recordSchemas.interactions, state.interactions);
    state.tasks = segment("tasks", recordSchemas.tasks, state.tasks);
    state.interactionHistory = segment(
      "interactionHistory",
      recordSchemas.interactions,
      state.interactionHistory,
    );
    state.taskHistory = segment("taskHistory", recordSchemas.tasks, state.taskHistory);
    state.itemLinks = segment("itemLinks", recordSchemas.itemLinks, state.itemLinks);
    const indexes = state.indexes;
    indexes.liveTools = segment("liveTools", recordSchemas.keys, indexes.liveTools);
    indexes.pendingInteractions = segment(
      "pendingInteractions",
      recordSchemas.keys,
      indexes.pendingInteractions,
    );
    indexes.runningTasks = segment("runningTasks", recordSchemas.keys, indexes.runningTasks);
    indexes.agentKeysById = segment("agentKeysById", recordSchemas.key, indexes.agentKeysById);
    indexes.childrenByParent = segment(
      "childrenByParent",
      recordSchemas.keySet,
      indexes.childrenByParent,
    );
    indexes.pendingSpawnLinks = segment(
      "pendingSpawnLinks",
      recordSchemas.keySet,
      indexes.pendingSpawnLinks,
    );
    indexes.pendingItemLinks = segment(
      "pendingItemLinks",
      recordSchemas.keys,
      indexes.pendingItemLinks,
    );
    this.state = state;
  }
  prepare(fact: Fact): () => void {
    if (
      fact.type !== "item.delta" ||
      fact.field === "output" ||
      this.items.hasReplacement(fact.item)
    )
      return () => {};
    let metadata = this.metadata.values[fact.item];
    if (!metadata) {
      const item = this.state.items[fact.item];
      if (!item) return () => {};
      metadata = itemMetadata(item);
    }
    return this.items.useAppendValue(fact.item, structuredClone(metadata));
  }
  remember(fact: Fact, events: EventPayload[]): void {
    if (fact.type !== "item.upsert" && fact.type !== "item.delta") return;
    const item = this.state.items[fact.item];
    if (
      item &&
      events.some(
        (event) =>
          ((event.type === "item.created" || event.type === "item.updated") &&
            event.item.id === item.id) ||
          (event.type === "item.delta" && event.itemId === item.id),
      )
    )
      this.metadata.values[fact.item] = itemMetadata(item);
  }
  delta(fact: Extract<Fact, { type: "item.delta" }>): void {
    const item = this.state.items[fact.item];
    if (!item) return;
    if (item.type === "message")
      this.items.append(fact.item, {
        path: ["parts", item.parts.length - 1, "text"],
        text: fact.append,
        seed: { type: "text" },
      });
    else if (item.type === "reasoning" || item.type === "notice")
      this.items.append(fact.item, { path: ["text"], text: fact.append });
  }
  header(): string {
    return JSON.stringify({
      ...this.state,
      agents: {},
      items: {},
      runs: {},
      interactions: {},
      tasks: {},
      interactionHistory: {},
      taskHistory: {},
      itemLinks: {},
      indexes: {
        liveTools: {},
        pendingInteractions: {},
        runningTasks: {},
        agentKeysById: {},
        childrenByParent: {},
        pendingSpawnLinks: {},
        pendingItemLinks: {},
      },
      engineSnapshot: 2,
    });
  }
  begin(): void {
    for (const section of this.sections) section.begin();
  }
  retainChanges(events: EventPayload[]): void {
    const changed = new Set(
      events.flatMap((event) =>
        event.type === "item.updated" || event.type === "item.created"
          ? [event.item.id]
          : event.type === "item.delta" && event.field === "output"
            ? [event.itemId]
            : [],
      ),
    );
    this.items.retainChanges((item) => changed.has(item.id));
  }
  flush(): void {
    // Agent serialization can add a new native-run section on this pass.
    for (const section of this.sections) section.flush();
  }
}
