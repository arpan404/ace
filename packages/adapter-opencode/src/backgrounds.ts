import { Deadlines } from "./deadlines.ts";
export type Background = { agent: string; child?: string; item: string; idleAt?: number };

/** Background identity, child/item ownership and grace deadlines share one owner. */
export class Backgrounds {
  private jobs = new Map<string, Background>();
  private children = new Map<string, Set<string>>();
  private items = new Map<string, Set<string>>();
  private deadlines = new Deadlines();
  get size(): number {
    return this.jobs.size;
  }
  get nextDeadline(): number | undefined {
    return this.deadlines.next;
  }
  get(key: string): Background | undefined {
    return this.jobs.get(key);
  }
  has(key: string): boolean {
    return this.jobs.has(key);
  }
  hasItem(item: string): boolean {
    return this.items.has(item);
  }
  set(key: string, value: Background): void {
    this.delete(key);
    this.jobs.set(key, value);
    this.add(this.items, value.item, key);
    if (value.child) this.add(this.children, value.child, key);
    if (value.idleAt !== undefined) this.deadlines.set(key, value.idleAt + 3000);
  }
  delete(key: string): void {
    const value = this.jobs.get(key);
    if (!value) return;
    this.jobs.delete(key);
    this.remove(this.items, value.item, key);
    if (value.child) this.remove(this.children, value.child, key);
    this.deadlines.delete(key);
  }
  idle(child: string, now: number): void {
    for (const key of this.children.get(child) ?? []) {
      const job = this.jobs.get(key);
      if (!job) continue;
      job.idleAt = now;
      this.deadlines.set(key, now + 3000);
    }
  }
  resumed(child: string): void {
    for (const key of this.children.get(child) ?? []) {
      const job = this.jobs.get(key);
      if (job) delete job.idleAt;
      this.deadlines.delete(key);
    }
  }
  *due(now: number): Generator<[string, Background]> {
    while (this.deadlines.next !== undefined && this.deadlines.next <= now) {
      const key = this.deadlines.first;
      if (key === undefined) break;
      this.deadlines.delete(key);
      const job = this.jobs.get(key);
      if (job) yield [key, job];
    }
  }
  private add(index: Map<string, Set<string>>, owner: string, key: string): void {
    const keys = index.get(owner) ?? new Set<string>();
    keys.add(key);
    index.set(owner, keys);
  }
  private remove(index: Map<string, Set<string>>, owner: string, key: string): void {
    const keys = index.get(owner);
    keys?.delete(key);
    if (!keys?.size) index.delete(owner);
  }
}
