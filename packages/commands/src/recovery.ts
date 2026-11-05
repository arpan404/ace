import { dirname } from "node:path";
import {
  commandLane,
  lstatCommandPath,
  type CommandCalls,
  type CommandStat as Stats,
} from "./posix-calls.ts";
interface Tracked {
  path: string;
  version: string | undefined;
}
export const statVersion = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
/** A fixed ring prevents churn at the tail from starving earlier paths. No history scan. */
export class FileRecovery {
  private readonly slots: (Tracked | undefined)[] = [];
  private readonly indexes = new Map<string, number>();
  private readonly free: number[] = [];
  private cursor = 0;
  private inspected = 0;
  /** The command root lane a tracked path is checked on, so a dead mount stalls only its own. */
  private readonly laneOf: (path: string) => string;
  /** Whose calls these are: cancelling the owner ends a pass at once. */
  private readonly calls: CommandCalls | undefined;
  private stopped = false;
  constructor(
    laneOf: (path: string) => string = (path) => commandLane(dirname(path)),
    calls?: CommandCalls,
  ) {
    this.laneOf = laneOf;
    this.calls = calls;
  }
  /** No pass goes further once stopped; a check in progress ends at its next path. */
  stop(): void {
    this.stopped = true;
  }
  get checks(): number {
    return this.inspected;
  }
  track(path: string, stat: Stats | undefined): void {
    const current = this.indexes.get(path),
      value = stat === undefined ? undefined : statVersion(stat);
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
    for (let i = 0; i < count && !this.stopped; i++) {
      const entry = this.slots[this.cursor];
      this.cursor = (this.cursor + 1) % this.slots.length;
      if (!entry) continue;
      let current: string | undefined;
      this.inspected++;
      try {
        current = statVersion(
          await lstatCommandPath(this.laneOf(entry.path), entry.path, this.calls),
        );
      } catch {
        // Cancelled: nothing was learned about this path.
        if (this.stopped) break;
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
