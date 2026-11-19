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
/**
 * The version of a path known to be gone. It differs from unknown (`undefined`, a folder that
 * didn't answer), so a path deleted while its folder was stuck is still noticed once it answers.
 */
const missing = "missing";
const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");
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
  /** Track a path's version; without a stat it is unknown, and any answer counts as a change. */
  track(path: string, stat: Stats | undefined): void {
    this.set(path, stat === undefined ? undefined : statVersion(stat));
  }
  /** Track a path known to be gone; only its coming back counts as a change. */
  trackMissing(path: string): void {
    this.set(path, missing);
  }
  private set(path: string, value: string | undefined): void {
    const current = this.indexes.get(path);
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
      } catch (error) {
        // Cancelled: nothing was learned about this path.
        if (this.stopped) break;
        current = isMissing(error) ? missing : undefined;
      }
      if (current !== entry.version) {
        entry.version = current;
        changed.push(entry.path);
      }
    }
    return changed;
  }
}
