import type { DatabaseSync } from "node:sqlite";
import { DeadlineIndex, type AgentRecord, type ThreadState, type Fact } from "@ace/core";
import { RunId, type Item, type EventPayload } from "@ace/protocol";
import { z } from "zod";
import { recordSchemas } from "./snapshot.ts";
import { itemMetadata, keepsItemMetadata } from "./item-metadata.ts";
import { RecordBudget, type RecordTransaction } from "./record-cache.ts";
import { Records } from "./records.ts";
import { engineSchemaVersion } from "./schema-version.ts";
const nativeRunId = z.custom<RunId>((value) => RunId.safeParse(value).success);

/** A complete core snapshot is a small header plus native-keyed entity records. */
export class Snapshot {
  readonly state: ThreadState;
  private deadlines: DeadlineIndex | undefined;
  private deadlineObservedAt: number | undefined;
  private items: Records<Item>;
  private metadata: Records<Item>;
  private readonly sections = new Set<{ flush(): void; persist(): void; committed(): void }>();
  private readonly cache: RecordBudget;
  /** Every dictionary this snapshot made, including ones agent reads add later. */
  private readonly owned: { release(): void }[] = [];
  private released = false;
  private readonly transaction: RecordTransaction & { tracking: boolean } = {
    tracking: false,
    touch: (section) => {
      this.sections.add(section);
    },
  };
  constructor(db: Pick<DatabaseSync, "prepare">, state: ThreadState, budget = new RecordBudget()) {
    this.cache = budget;
    const segment = <T>(section: string, schema: z.ZodType<T>, initial: Record<string, T>) => {
      const records = new Records(
        db,
        state.threadId,
        section,
        schema,
        initial,
        undefined,
        undefined,
        this.cache,
        this.transaction,
      );
      this.own(records);
      return records.values;
    };
    const nativeRuns = new Map<string, Record<string, RunId>>();
    const attachRuns = (key: string, record: AgentRecord): AgentRecord => {
      if (record.nativeRuns !== undefined) {
        let runs = nativeRuns.get(key);
        if (!runs) {
          runs = segment<RunId>(`nativeRuns:${key}`, nativeRunId, record.nativeRuns);
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
      this.cache,
      this.transaction,
    );
    this.own(agents);
    state.agents = agents.values;
    this.items = new Records(
      db,
      state.threadId,
      "items",
      recordSchemas.items,
      state.items,
      undefined,
      undefined,
      this.cache,
      this.transaction,
    );
    this.own(this.items);
    state.items = this.items.values;
    this.metadata = new Records(
      db,
      state.threadId,
      "itemMetadata",
      recordSchemas.items,
      {},
      undefined,
      undefined,
      this.cache,
      this.transaction,
    );
    this.own(this.metadata);
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
    indexes.openText = segment("openText", recordSchemas.keys, indexes.openText ?? {});
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
  private own(records: { release(): void }): void {
    // A state kept past release can still open an agent's nativeRuns for the first time; that
    // dictionary must not cache either, or later repository writes would leave it stale.
    if (this.released) records.release();
    else this.owned.push(records);
  }
  /**
   * Called once the repository drops this snapshot: frees its entries in the shared budget.
   * Permanent: dictionaries this snapshot opens afterwards are released as they are made.
   */
  release(): void {
    this.released = true;
    for (const records of this.owned) records.release();
    this.owned.length = 0;
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
    if (
      fact.type !== "item.upsert" &&
      fact.type !== "item.reconciled" &&
      fact.type !== "item.delta"
    )
      return;
    const item = this.state.items[fact.item];
    if (
      item &&
      events.some(
        (event) =>
          ((event.type === "item.created" || event.type === "item.updated") &&
            event.item.id === item.id) ||
          (event.type === "item.delta" && event.itemId === item.id),
      )
    ) {
      const previous = this.metadata.values[fact.item];
      if (!keepsItemMetadata(item)) {
        // A copy would equal the item; `prepare` and `streamItem` fall back to the item itself.
        if (previous !== undefined) delete this.metadata.values[fact.item];
        return;
      }
      const next = itemMetadata(item);
      if (JSON.stringify(next) !== JSON.stringify(previous)) this.metadata.values[fact.item] = next;
    }
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
  deadline(providerDeadline?: number): number | undefined {
    this.deadlines ??= new DeadlineIndex(this.state);
    return this.deadlines.next(providerDeadline);
  }
  updateDeadlines(facts: readonly Fact[], events: readonly EventPayload[], now: number): void {
    const rolledBack = this.deadlineObservedAt !== undefined && now < this.deadlineObservedAt;
    this.deadlineObservedAt = now;
    if (!this.deadlines) return;
    if (
      !rolledBack &&
      facts.every((fact) => fact.type === "item.delta" || fact.type === "signal") &&
      events.every((event) => event.type === "item.delta")
    ) {
      const agents = new Set(
        facts.flatMap((fact) =>
          fact.type === "item.delta" || fact.type === "signal" ? [fact.agent] : [],
        ),
      );
      if (agents.has(undefined)) this.deadlines.signal(undefined, now, this.state.config.silenceMs);
      else
        for (const agent of agents) this.deadlines.signal(agent, now, this.state.config.silenceMs);
    } else this.deadlines.rebuild(this.state);
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
        openText: {},
        pendingInteractions: {},
        runningTasks: {},
        agentKeysById: {},
        childrenByParent: {},
        pendingSpawnLinks: {},
        pendingItemLinks: {},
      },
      engineSnapshot: engineSchemaVersion,
    });
  }
  begin(): void {
    this.transaction.tracking = true;
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
  /** A metadata-only lookup keeps streaming work independent of transcript length. */
  streamItem(key: string): Item | undefined {
    return this.metadata.values[key] ?? this.state.items[key];
  }
  persist(): void {
    // Agent serialization may register another section.
    for (const section of this.sections) section.persist();
  }
  committed(): void {
    for (const section of this.sections) section.committed();
    this.sections.clear();
    this.transaction.tracking = false;
  }
  flush(): void {
    this.persist();
    this.committed();
  }
}
