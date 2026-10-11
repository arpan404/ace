import type { Selection, ThreadReader, ThreadSource } from "@ace/client";
import { isActionableInteraction } from "@ace/core/human";
import type { Agent, Interaction, Item, Run } from "@ace/protocol";
import type { Watched } from "./use-watched.ts";

type Launch = Extract<Item, { type: "delegation.started" }>;
const add = (map: Map<string, Set<string>>, key: string | null | undefined, id: string) => {
  if (!key) return;
  let ids = map.get(key);
  if (!ids) map.set(key, (ids = new Set()));
  ids.add(id);
};
const remove = (map: Map<string, Set<string>>, key: string | null | undefined, id: string) => {
  if (!key) return;
  const ids = map.get(key);
  ids?.delete(id);
  if (!ids?.size) map.delete(key);
};

/** Shared indexes of canonical links, pending attention and run endpoints. No transcript copy. */
export class AgentFacts {
  readonly bySpawn = new Map<string, Set<string>>();
  readonly byThread = new Map<string, Set<string>>();
  readonly launches = new Map<string, Set<string>>();
  private agents = new Map<string, Agent>();
  private questions = new Map<string, Interaction>();
  private pending = new Map<string, Set<string>>();
  private launchItems = new Map<string, Launch>();
  private runs = new Map<string, Run>();
  private ends = new Map<string, Map<string, number>>();
  private latest = new Map<string, number>();

  readonly reader: ThreadReader;
  constructor(reader: ThreadReader) {
    this.reader = reader;
    this.reset();
  }

  reset(): void {
    this.bySpawn.clear();
    this.byThread.clear();
    this.launches.clear();
    this.agents.clear();
    this.questions.clear();
    this.pending.clear();
    this.launchItems.clear();
    this.runs.clear();
    this.ends.clear();
    this.latest.clear();
    for (const id of this.reader.agentIds()) this.agent(id, new Set());
    for (const id of this.reader.interactionIds()) this.interaction(id, new Set());
    for (const id of this.reader.order) this.item(id, new Set());
  }

  /** Item keys include page additions and evictions; only a snapshot rebuilds the indexes. */
  update(keys: ReadonlySet<string> | "all"): ReadonlySet<string> | "all" {
    if (keys === "all") {
      this.reset();
      return "all";
    }
    const changed = new Set(keys);
    for (const key of keys) {
      if (key.startsWith("agent:")) this.agent(key.slice(6), changed);
      else if (key.startsWith("interaction:")) this.interaction(key.slice(12), changed);
      else if (key.startsWith("item:")) this.item(key.slice(5), changed);
      else if (key.startsWith("run:")) this.run(key.slice(4), changed);
    }
    return changed;
  }

  private agent(id: string, changed: Set<string>) {
    const before = this.agents.get(id);
    const next = this.reader.agent(id);
    if (before === next) return;
    remove(this.bySpawn, before?.spawnedBy, id);
    remove(this.byThread, before?.childThreadId, id);
    if (next) {
      this.agents.set(id, next);
      add(this.bySpawn, next.spawnedBy, id);
      add(this.byThread, next.childThreadId, id);
    } else this.agents.delete(id);
    for (const agent of [before, next]) {
      if (agent?.spawnedBy) changed.add(`spawn:${agent.spawnedBy}`);
      if (agent?.childThreadId) changed.add(`childThread:${agent.childThreadId}`);
      if (agent?.parentId) changed.add(`agent:${agent.parentId}`);
    }
  }

  private interaction(id: string, changed: Set<string>) {
    const before = this.questions.get(id);
    const next = this.reader.interaction(id);
    remove(this.pending, before?.agentId, id);
    if (next?.state === "pending") {
      this.questions.set(id, next);
      add(this.pending, next.agentId, id);
    } else this.questions.delete(id);
    if (before) changed.add(`attention:${before.agentId}`);
    if (next) changed.add(`attention:${next.agentId}`);
  }

  actionable(agentId: string): boolean {
    for (const id of this.pending.get(agentId) ?? []) {
      const question = this.questions.get(id);
      if (question && isActionableInteraction(question, this.reader.agent(agentId)?.status))
        return true;
    }
    return false;
  }

  private item(id: string, changed: Set<string>) {
    const item = this.reader.item(id);
    const before = this.launchItems.get(id);
    if (before !== item) {
      remove(this.launches, before?.childThreadId, id);
      if (before) changed.add(`launch:${before.childThreadId}`);
      if (item?.type === "delegation.started") {
        this.launchItems.set(id, item);
        add(this.launches, item.childThreadId, id);
        changed.add(`launch:${item.childThreadId}`);
      } else this.launchItems.delete(id);
    }
    if (item?.runId && !this.runs.has(item.runId)) this.run(item.runId, changed);
  }

  private run(id: string, changed: Set<string>) {
    const before = this.runs.get(id);
    const next = this.reader.run(id);
    if (before === next) return;
    if (next) this.runs.set(id, next);
    else this.runs.delete(id);
    for (const owner of new Set([before?.agentId, next?.agentId])) {
      if (!owner) continue;
      let ends = this.ends.get(owner);
      if (!ends) this.ends.set(owner, (ends = new Map()));
      const old = ends.get(id);
      ends.delete(id);
      if (next?.agentId === owner && next.endedAt !== undefined) ends.set(id, next.endedAt);
      const latest = this.latest.get(owner);
      // Normal run completion costs O(1). Only a corrected/evicted maximum needs a rescan.
      if (
        old !== undefined &&
        old === latest &&
        (next?.agentId === owner ? (next.endedAt ?? -1) : -1) < old
      ) {
        this.latest.delete(owner);
        for (const end of ends.values())
          this.latest.set(owner, Math.max(this.latest.get(owner) ?? end, end));
      } else if (next?.agentId === owner && next.endedAt !== undefined)
        this.latest.set(owner, Math.max(latest ?? next.endedAt, next.endedAt));
      changed.add(`end:${owner}`);
    }
  }

  endedAt(agentId: string): number | undefined {
    return this.latest.get(agentId);
  }
}

/** One observer and one projection per source, held only while its selections are mounted. */
class SharedAgentFacts extends AgentFacts {
  private listeners = new Map<string, Set<() => void>>();
  private holders = 0;
  private stop: (() => void) | undefined;

  select<T>(read: (facts: AgentFacts) => Watched<T>, equal: (a: T, b: T) => boolean): Selection<T> {
    let reading = read(this);
    return {
      getSnapshot: () => reading.value,
      subscribe: (listener) => {
        if (!this.holders++) {
          this.reset();
          this.stop = this.source.observe((keys) => {
            const changed = this.update(keys);
            const updates = new Set<() => void>();
            if (changed === "all")
              for (const set of this.listeners.values())
                for (const update of set) updates.add(update);
            else
              for (const key of changed)
                for (const update of this.listeners.get(key) ?? []) updates.add(update);
            for (const update of updates) update();
          });
        }
        const unbind = () => {
          for (const key of reading.watch) {
            const set = this.listeners.get(key);
            set?.delete(update);
            if (!set?.size) this.listeners.delete(key);
          }
        };
        const bind = () => {
          for (const key of reading.watch) {
            let set = this.listeners.get(key);
            if (!set) this.listeners.set(key, (set = new Set()));
            set.add(update);
          }
        };
        const update = () => {
          const next = read(this);
          const different = !equal(reading.value, next.value);
          unbind();
          reading = { value: different ? next.value : reading.value, watch: next.watch };
          bind();
          if (different) listener();
        };
        update();
        return () => {
          unbind();
          if (!--this.holders) {
            this.stop?.();
            this.stop = undefined;
          }
        };
      },
    };
  }

  private readonly source: ThreadSource;
  constructor(source: ThreadSource) {
    super(source);
    this.source = source;
  }
}

const projections = new WeakMap<ThreadSource, SharedAgentFacts>();
export function agentFactsOf(source: ThreadSource): SharedAgentFacts {
  let projection = projections.get(source);
  if (!projection) projections.set(source, (projection = new SharedAgentFacts(source)));
  return projection;
}
