import type { ThreadId } from "@ace/protocol";
import { filterSessionToolEnv } from "./tool-env.ts";

/**
 * Ephemeral per-thread tool credentials. Values live only in daemon memory:
 * never persisted, never logged, dropped on explicit clear, dead-thread sweep
 * or daemon shutdown. Every stored entry already passed `filterSessionToolEnv`,
 * so only allowlisted keys with bounded values are ever held.
 */
export class ToolEnvVault {
  readonly #entries = new Map<string, NodeJS.ProcessEnv>();
  readonly #maxThreads: number;
  constructor(maxThreads = 256) {
    if (!Number.isSafeInteger(maxThreads) || maxThreads < 1)
      throw new Error("Invalid tool credential capacity");
    this.#maxThreads = maxThreads;
  }
  get size(): number {
    return this.#entries.size;
  }
  /** Store filtered entries for one thread; empty input releases it. */
  submit(threadId: ThreadId, entries: unknown): number {
    ToolEnvVault.checkThread(threadId);
    const filtered = filterSessionToolEnv(entries);
    const count = Object.keys(filtered).length;
    if (count === 0) {
      this.#entries.delete(threadId);
      return 0;
    }
    if (!this.#entries.has(threadId) && this.#entries.size >= this.#maxThreads)
      throw new Error("Tool credential store is full");
    this.#entries.set(threadId, filtered);
    return count;
  }
  /** A copy of the live thread's entries, or undefined. Dead threads read empty. */
  get(threadId: ThreadId, isLive?: (threadId: ThreadId) => boolean): NodeJS.ProcessEnv | undefined {
    const found = this.#entries.get(threadId);
    if (!found) return undefined;
    if (isLive && !isLive(threadId)) {
      this.#entries.delete(threadId);
      return undefined;
    }
    return { ...found };
  }
  /** Drop one thread's entries. Returns true when anything was held. */
  release(threadId: ThreadId): boolean {
    return this.#entries.delete(threadId);
  }
  /** Drop everything, for daemon shutdown. */
  clear(): void {
    this.#entries.clear();
  }
  private static checkThread(threadId: ThreadId): void {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(threadId)) throw new Error("Invalid thread");
  }
}
