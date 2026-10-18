import type { BrowserState, ThreadId } from "@ace/protocol";

/** True while an agent works in one of the browser's tabs (its `inUse` mark). */
export function agentBrowsing(state: BrowserState): boolean {
  return !state.closed && (state.tabs ?? []).some((tab) => tab.inUse?.kind === "agent");
}

/**
 * The threads whose browser an agent is working in now, across ace's browser and the person's
 * Chrome, kept from each browser state as it changes. Listeners hear the whole set, and only
 * when it changes, so a busy agent's every command costs a set lookup.
 */
export class BrowsingThreads {
  private readonly sources = new Map<string, Set<ThreadId>>();
  private readonly listeners = new Set<(threads: readonly ThreadId[]) => void>();
  private current: readonly ThreadId[] = [];

  /** A browser state from `source` (one browser service). */
  update(source: string, state: BrowserState): void {
    const set = this.sources.get(source) ?? new Set<ThreadId>();
    this.sources.set(source, set);
    const had = set.has(state.threadId);
    const has = agentBrowsing(state);
    if (had === has) return;
    if (has) set.add(state.threadId);
    else set.delete(state.threadId);
    const all = new Set<ThreadId>();
    for (const each of this.sources.values()) for (const thread of each) all.add(thread);
    this.current = [...all];
    for (const listener of this.listeners) listener(this.current);
  }

  threads(): readonly ThreadId[] {
    return this.current;
  }

  subscribe(listener: (threads: readonly ThreadId[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
