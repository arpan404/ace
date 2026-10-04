import { ExpiryMap } from "@ace/core";
import type { Agent, Run, Interaction, BackgroundTask, EntityCollection } from "@ace/protocol";
export type Entity = Agent | Run | Interaction | BackgroundTask;
export interface RetainedEntity {
  collection: EntityCollection;
  id: string;
  seq: number;
  bytes: number;
  active: boolean;
  references: string[];
}
export function retainedEntity(
  collection: EntityCollection,
  value: Entity,
  seq: number,
): RetainedEntity {
  const references = "agentId" in value ? [value.agentId] : value.parentId ? [value.parentId] : [];
  if ("childAgentId" in value && value.childAgentId) references.push(value.childAgentId);
  const active =
    "origin" in value
      ? value.origin === "root" || !["idle", "interrupted", "failed"].includes(value.status.state)
      : "state" in value
        ? value.state === "active" || value.state === "pending"
        : value.status === "running" || value.status === "unknown";
  return {
    collection,
    id: value.id,
    seq,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    active,
    references,
  };
}
interface Entry extends RetainedEntity {
  recent: boolean;
}
/** Pure bounded recent-window and reference policy. Active entities never enter eviction heaps. */
export class EntityRetention {
  private entries = new Map<EntityCollection, Map<string, Entry>>();
  private recent = new Map<EntityCollection, ExpiryMap<undefined>>();
  private bytes = new Map<EntityCollection, number>();
  private references = new Map<string, number>();
  private removed: RetainedEntity[] = [];
  seed(entries: RetainedEntity[]): void {
    for (const entry of entries) this.register(entry);
    for (const collection of this.entries.keys()) this.trim(collection);
  }
  hasAgent(id: string): boolean {
    return this.entries.get("agents")?.has(id) === true;
  }
  observe(input: RetainedEntity): void {
    this.register(input);
    this.trim(input.collection);
  }
  drain(): RetainedEntity[] {
    const removed = new Map(
      this.removed
        .filter((entry) => !this.entries.get(entry.collection)?.has(entry.id))
        .map((entry) => [`${entry.collection}:${entry.id}`, entry]),
    );
    this.removed = [];
    return Array.from(removed.values());
  }
  oldest(collection: EntityCollection): number | undefined {
    return this.recent.get(collection)?.first()?.expiresAt;
  }
  private register(input: RetainedEntity): void {
    let entries = this.entries.get(input.collection);
    if (!entries) {
      entries = new Map();
      this.entries.set(input.collection, entries);
    }
    let recent = this.recent.get(input.collection);
    if (!recent) {
      recent = new ExpiryMap();
      this.recent.set(input.collection, recent);
    }
    const previous = entries.get(input.id);
    if (previous?.recent)
      this.bytes.set(input.collection, (this.bytes.get(input.collection) ?? 0) - previous.bytes);
    recent.delete(input.id);
    const entry = { ...input, recent: !input.active };
    entries.set(input.id, entry);
    for (const id of input.references)
      if (!previous?.references.includes(id))
        this.references.set(id, (this.references.get(id) ?? 0) + 1);
    for (const id of previous?.references ?? [])
      if (!input.references.includes(id)) this.release(id);
    if (entry.recent) {
      recent.set(input.id, undefined, input.seq);
      this.bytes.set(input.collection, (this.bytes.get(input.collection) ?? 0) + input.bytes);
    }
  }
  private trim(collection: EntityCollection): void {
    const recent = this.recent.get(collection);
    if (!recent) return;
    while (recent.size > 200 || (this.bytes.get(collection) ?? 0) > 131072) {
      const oldest = recent.first();
      if (!oldest) break;
      recent.delete(oldest.key);
      const entry = this.entries.get(collection)?.get(oldest.key);
      if (!entry) continue;
      entry.recent = false;
      this.bytes.set(collection, (this.bytes.get(collection) ?? 0) - entry.bytes);
      if (collection !== "agents" || !(this.references.get(entry.id) ?? 0)) this.remove(entry);
    }
  }
  private release(id: string): void {
    const count = (this.references.get(id) ?? 0) - 1;
    if (count > 0) {
      this.references.set(id, count);
      return;
    }
    this.references.delete(id);
    const entry = this.entries.get("agents")?.get(id);
    if (entry && !entry.active && !entry.recent) this.remove(entry);
  }
  private remove(entry: Entry): void {
    this.entries.get(entry.collection)?.delete(entry.id);
    this.removed.push(entry);
    for (const id of entry.references) this.release(id);
  }
}
