import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
interface Tracked {
  path: string;
  version: string | undefined;
}
const version = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
/** A fixed ring prevents churn at the tail from starving earlier paths. No history scan. */
export class FileRecovery {
  private readonly slots: (Tracked | undefined)[] = [];
  private readonly indexes = new Map<string, number>();
  private readonly free: number[] = [];
  private cursor = 0;
  track(path: string, stat: Stats | undefined): void {
    const current = this.indexes.get(path),
      value = stat === undefined ? undefined : version(stat);
    if (current !== undefined) {
      const entry = this.slots[current];
      if (entry) entry.version = value;
      return;
    }
    const index = this.free.pop() ?? this.slots.length;
    if (index >= 4160) return;
    this.indexes.set(path, index);
    this.slots[index] = { path, version: value };
  }
  forget(path: string): void {
    const index = this.indexes.get(path);
    if (index === undefined) return;
    this.indexes.delete(path);
    this.slots[index] = undefined;
    this.free.push(index);
  }
  async check(): Promise<string[]> {
    const changed: string[] = [];
    const count = Math.min(32, this.slots.length);
    for (let i = 0; i < count; i++) {
      const entry = this.slots[this.cursor];
      this.cursor = (this.cursor + 1) % this.slots.length;
      if (!entry) continue;
      let current: string | undefined;
      try {
        current = version(await lstat(entry.path));
      } catch {
        current = undefined;
      }
      if (current !== entry.version) {
        entry.version = current;
        changed.push(entry.path);
      }
    }
    return changed;
  }
}
